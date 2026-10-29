"""Materialize the delivering Git revision into an owned ordinary resource root."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile


MARKER = ".factory-resource.json"
FORBIDDEN = {".git", ".factory", ".archon", ".claude", ".env", MARKER,
             "holdout.md", "node_modules", ".venv", "__pycache__"}


def checked(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise ValueError("Git could not verify the delivering revision")
    return result.stdout.strip()


def checked_bytes(argv: list[str], cwd: Path, *, input: bytes | None = None) -> bytes:
    result = subprocess.run(argv, cwd=cwd, input=input, capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError("Git could not verify the delivering revision")
    return result.stdout


def resource_digest(root: Path) -> str:
    result = hashlib.sha256()
    files = sorted(path for path in root.rglob("*")
                   if path.is_file() and path != root / MARKER)
    if not files:
        raise ValueError("delivering revision produced an empty resource")
    for path in files:
        name = path.relative_to(root).as_posix()
        content = path.read_bytes()
        result.update(name.encode() + b"\0" + str(len(content)).encode() + b"\0" + content)
    return result.hexdigest()


def remove_tree(root: Path) -> None:
    def writable(function, path, exc):
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        function(path)
    shutil.rmtree(root, onerror=writable)


def owned_destination(destination: Path) -> bool:
    marker = destination / MARKER
    if destination.is_symlink() or not marker.is_file() or marker.is_symlink():
        return False
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    return (data.get("version") == 1 and data.get("kind") == "factory-runtime-resource"
            and data.get("resource_root") == str(destination))


def delivery(expected_revision: str | None = None) -> tuple[Path, str]:
    script_root = Path(__file__).resolve().parents[1]
    if script_root.name == "template" and (script_root.parent / ".git").exists():
        script_root = script_root.parent
    repository = Path(checked(["git", "rev-parse", "--show-toplevel"], script_root)).resolve()
    if script_root != repository:
        raise ValueError("resource helper must run from its delivering repository")
    workflow_repository = Path(
        checked(["git", "rev-parse", "--show-toplevel"], Path.cwd())
    ).resolve()
    if workflow_repository != repository:
        raise ValueError("resource helper and workflow must use the same delivering repository")
    actual_revision = checked(["git", "rev-parse", "HEAD"], repository)
    if expected_revision is not None and expected_revision != actual_revision:
        raise ValueError("expected revision does not match the delivering checkout")
    if len(actual_revision) != 40:
        raise ValueError("delivering checkout does not have a full commit revision")
    if checked(["git", "status", "--porcelain", "--untracked-files=no"], repository):
        raise ValueError("delivering checkout has modified tracked files")
    return repository, actual_revision


def configured_includes(config: Path) -> list[str]:
    data = json.loads(config.read_text(encoding="utf-8"))
    includes = data.get("include") if isinstance(data, dict) and data.get("version") == 1 else None
    if (not isinstance(includes, list) or not includes
            or not all(isinstance(value, str) for value in includes)):
        raise ValueError("runtime config requires version 1 and nonempty include paths")
    result = []
    for value in includes:
        path = PurePosixPath(value)
        if (not value or value != path.as_posix() or "\\" in value or ":" in value or path.is_absolute()
                or any(part in {"", ".", ".."} or part.lower() in FORBIDDEN
                       for part in path.parts)):
            raise ValueError("private or escaping include path refused")
        result.append(path.as_posix())
    return result


def committed_files(repository: Path, revision: str, includes: list[str]) -> tuple[list[str], dict[str, tuple[str, int]]]:
    """Select directory layout and exact blob identities, independent of export attributes."""
    for include in includes:
        entry = checked_bytes(["git", "ls-tree", "-z", revision, "--", include], repository)
        if not entry:
            raise ValueError("configured include is missing from the delivering revision")

    entries = checked_bytes(
        ["git", "ls-tree", "-rtz", "--full-tree", revision, "--", *includes], repository
    )
    if not entries:
        raise ValueError("configured includes produced an empty resource")
    directories = []
    files = {}
    for raw in entries.split(b"\0"):
        if not raw:
            continue
        metadata, separator, name = raw.partition(b"\t")
        fields = metadata.split()
        if (not separator or len(fields) != 3
                or (fields[0], fields[1]) not in {
                    (b"100644", b"blob"), (b"100755", b"blob"), (b"040000", b"tree")}):
            raise ValueError("linked or unsupported committed source path refused")
        try:
            decoded = name.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("committed source path is not UTF-8") from error
        path = PurePosixPath(decoded)
        # Colons can select a Windows drive or alternate data stream instead of
        # the ordinary relative file represented by the Git entry.
        if ("\\" in decoded or ":" in decoded or path.is_absolute()
                or any(part in {"", ".", ".."} or part.lower() in FORBIDDEN
                       for part in path.parts)):
            raise ValueError("private or escaping committed source path refused")
        if fields[1] == b"tree":
            directories.append(decoded)
        else:
            if len(fields[2]) != 40 or any(value not in b"0123456789abcdef" for value in fields[2]):
                raise ValueError("committed source has an invalid blob identity")
            files[decoded] = (fields[2].decode("ascii"), int(fields[0], 8) & 0o777)
    return directories, files


def staging_path(staging: Path, relative: str) -> Path:
    target = (staging / relative).resolve()
    if not target.is_relative_to(staging):
        raise ValueError("committed source contains an escaping path")
    return target


def materialize_blobs(repository: Path, files: dict[str, tuple[str, int]], staging: Path) -> None:
    # Git archive applies export-ignore/export-subst, so its output need not
    # contain the selected commit's paths or bytes. Read immutable blobs instead.
    identities = list(dict.fromkeys(identity for identity, _ in files.values()))
    output = checked_bytes(["git", "cat-file", "--batch"], repository,
                           input="".join(identity + "\n" for identity in identities).encode("ascii"))
    contents = {}
    offset = 0
    for identity in identities:
        end = output.find(b"\n", offset)
        if end < 0:
            raise ValueError("Git returned incomplete committed blob data")
        header = output[offset:end].split(b" ")
        if (len(header) != 3 or header[0] != identity.encode("ascii")
                or header[1] != b"blob" or not header[2].isdigit()):
            raise ValueError("Git returned an unexpected committed blob")
        size = int(header[2])
        offset = end + 1
        content = output[offset:offset + size]
        if len(content) != size or output[offset + size:offset + size + 1] != b"\n":
            raise ValueError("Git returned truncated committed blob data")
        actual = hashlib.sha1(b"blob " + str(size).encode("ascii") + b"\0" + content).hexdigest()
        if actual != identity:
            raise ValueError("Git returned changed committed blob bytes")
        contents[identity] = content
        offset += size + 1
    if offset != len(output):
        raise ValueError("Git returned unexpected extra committed blob data")
    for relative, (identity, mode) in files.items():
        target = staging_path(staging, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents[identity])
        target.chmod(mode)


def verify_materialized(staging: Path, directories: list[str], files: dict[str, tuple[str, int]]) -> None:
    expected_directories = set(directories)
    for relative in [*directories, *files]:
        expected_directories.update(parent.as_posix() for parent in PurePosixPath(relative).parents
                                    if parent != PurePosixPath("."))
    actual_files = {}
    actual_directories = set()
    for path in staging.rglob("*"):
        relative = path.relative_to(staging).as_posix()
        if path.is_symlink():
            raise ValueError("materialized source contains linked paths")
        if path.is_dir():
            actual_directories.add(relative)
        elif path.is_file():
            actual_files[relative] = path
        else:
            raise ValueError("materialized source contains unsupported paths")
    # Case folding and other host filename aliases must not silently collapse
    # distinct committed names into a resource bearing the original revision.
    if set(actual_files) != set(files) or actual_directories != expected_directories:
        raise ValueError("materialized source paths differ from the delivering revision")
    for relative, path in actual_files.items():
        identity, mode = files[relative]
        content = path.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()
        if actual != identity or (os.name == "posix" and stat.S_IMODE(path.stat().st_mode) != mode):
            raise ValueError("materialized source bytes or mode differ from the delivering revision")


def validate_destination(destination: Path, repository: Path) -> Path:
    if (not destination.is_absolute() or destination == Path(destination.anchor)
            or ".." in destination.parts):
        raise ValueError("destination must be an explicit absolute directory")
    cursor = destination
    while cursor != cursor.parent:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("linked destinations are unsupported")
        cursor = cursor.parent
    resolved = destination.resolve()
    if resolved == repository or repository.is_relative_to(resolved):
        raise ValueError("destination cannot contain the delivering repository")
    return resolved


def publish_resource(staging: Path, destination: Path) -> None:
    """Install a validated generation, retaining the previous one until success."""
    backup = (Path(tempfile.mkdtemp(prefix=".factory-resource-backup-", dir=destination.parent))
              if destination.exists() else None)
    previous = backup / "previous" if backup is not None else None
    try:
        if previous is not None:
            destination.replace(previous)
        staging.replace(destination)
    except BaseException as error:
        # Include cancellation after the first rename. Abrupt process/machine
        # loss still requires manual recovery; two renames are not an exchange.
        if previous is not None:
            # A signal may arrive after rename completed but before it returned.
            # Under the serial-preparation contract, the consumed staging path
            # and installed destination distinguish this from a failed install.
            if not staging.exists() and destination.exists() and previous.exists():
                error.add_note(
                    f"New resource is installed at {destination}; the previous generation "
                    f"is retained at {previous}. Remove {backup} after confirming the "
                    "installed resource. See factory/RUNTIME_HOST.md.")
                raise
            try:
                if previous.exists():
                    previous.replace(destination)
            except BaseException as rollback_error:
                error.add_note(
                    f"Previous resource retained for recovery at {previous}; "
                    "restore it to the configured destination before preparing again. "
                    "See factory/RUNTIME_HOST.md.")
                raise error from rollback_error
            try:
                backup.rmdir()
            except OSError:
                error.add_note(f"Empty resource backup directory could not be removed: {backup}")
        raise
    if backup is not None:
        try:
            remove_tree(backup)
        except BaseException as error:
            error.add_note(
                f"New resource is installed at {destination}; previous backup cleanup "
                f"is incomplete at {backup}. See factory/RUNTIME_HOST.md.")
            raise


def prepare(destination: Path, config: Path, expected_revision: str | None = None) -> dict:
    repository, actual_revision = delivery(expected_revision)
    destination = validate_destination(destination, repository)
    includes = configured_includes(config)
    directories, files = committed_files(repository, actual_revision, includes)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.parent.is_symlink():
        raise ValueError("linked destination parents are unsupported")
    if destination.exists() and not owned_destination(destination):
        raise ValueError("destination exists and is not an owned runtime resource")

    staging = Path(tempfile.mkdtemp(prefix=".factory-resource-", dir=destination.parent))
    try:
        # Preserve selected empty trees without changing the file-byte digest.
        for relative in directories:
            staging_path(staging, relative).mkdir(parents=True, exist_ok=True)
        materialize_blobs(repository, files, staging)
        verify_materialized(staging, directories, files)
        mapping = {
            "version": 1,
            "kind": "factory-runtime-resource",
            "source_revision": actual_revision,
            "source_tree": checked(["git", "rev-parse", f"{actual_revision}^{{tree}}"], repository),
            "resource_root": str(destination),
            "resource_digest": resource_digest(staging),
            "include": includes,
        }
        (staging / MARKER).write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf-8")
        publish_resource(staging, destination)
        return mapping
    except BaseException as error:
        try:
            if staging.exists():
                remove_tree(staging)
        except BaseException:
            # Do not hide the publication failure or its retained-backup note.
            error.add_note(f"Resource staging cleanup is incomplete at {staging}")
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    node = sub.add_parser("prepare")
    node.add_argument("--destination", required=True, type=Path)
    node.add_argument("--config", required=True, type=Path)
    node.add_argument("--expected-revision")
    start = sub.add_parser("start", help="start a bound root as this delivering revision")
    start.add_argument("--slot", required=True)
    start.add_argument("--root", required=True)
    start.add_argument("--connection-file", required=True, type=Path)
    start.add_argument("--mutation")
    args = parser.parse_args(argv)
    try:
        if args.action == "prepare":
            print(json.dumps(prepare(args.destination, args.config, args.expected_revision)))
            return 0
        repository, revision = delivery()
        command = [sys.executable, str(repository / "factory/runtime_host.py"), "start",
                   "--slot", args.slot, "--root", args.root,
                   "--expected-revision", revision, "--connection-file", str(args.connection_file)]
        if args.mutation:
            command.extend(["--mutation", args.mutation])
        return subprocess.run(command, cwd=repository).returncode
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print("Runtime resource operation refused", file=sys.stderr)
        for note in getattr(error, "__notes__", ()):
            print(note, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
