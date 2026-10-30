"""Invoke a pinned, complete Archon source installation. No stage policy lives here."""
from __future__ import annotations

import calendar
import contextlib
import hashlib
import importlib.machinery
import json
import os
import platform
import plistlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "pack.json").read_text(encoding="utf-8"))
SETTINGS = ".factory/consumer.json"
ENTRY = "packages/cli/src/cli.ts"
SCHEDULE = ".factory/schedule.json"
TRIGGER = ".factory/trigger.json"
PAUSE = ".factory/PAUSE"
ADMISSION_MARKER = ".factory/shared-admission.json"
ADMISSION_REGISTRY = "factory-controller.json"
# The shared workflows that carry a merge gate and accept a declared required-check policy.
MERGING_WORKFLOWS = {"archon-lifecycle", "archon-merge-queue"}


def windowless() -> bool:
    """True under pythonw (the Windows timer): no console to show child output in."""
    return sys.platform == "win32" and sys.stdout is None


def execute(argv: list[str], cwd: Path, *, capture: bool = True,
            timeout: int | None = 180, env: dict | None = None,
            output=None) -> subprocess.CompletedProcess:
    # Resolve PATH and PATHEXT once, including Windows .cmd launchers.
    argv = [shutil.which(argv[0]) or argv[0], *argv[1:]]
    flags = {}
    # A console program started from a windowless parent gets a new console window
    # unless told not to; captured or logged output does not need one.
    if sys.platform == "win32" and (capture or output is not None or windowless()):
        flags["creationflags"] = subprocess.CREATE_NO_WINDOW
    streams = ({"stdout": output, "stderr": subprocess.STDOUT} if output is not None
               else {"capture_output": capture})
    return subprocess.run(argv, cwd=cwd, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, env=env, **streams, **flags)


def checked(argv: list[str], cwd: Path, timeout: int = 180) -> str:
    result = execute(argv, cwd, timeout=timeout)
    if result.returncode:
        raise ValueError(f"Command exited {result.returncode}: {argv[:3]}\n"
                         + (result.stderr or result.stdout)[-3000:])
    return result.stdout


def verify_git_environment(*, local_brake: bool = False) -> None:
    harmless = {"GIT_PAGER", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"}
    if local_brake:
        # These do not affect rev-parse repository discovery. Admission keeps
        # its stricter allowlist; unknown and repository/config overrides refuse.
        harmless |= {"GIT_ASKPASS", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
                     "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
                     "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
                     "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_SSL_CAINFO"}
    if any(key.startswith("GIT_") and key not in harmless for key in os.environ):
        raise ValueError("Git environment redirects are unsupported; project identity must be authoritative")


def project_root(*, local_brake: bool = False) -> Path:
    verify_git_environment(local_brake=local_brake)
    return Path(checked(["git", "rev-parse", "--show-toplevel"], Path.cwd()).strip()).resolve()


def shared_root(root: Path, *, local_brake: bool = False) -> Path:
    verify_git_environment(local_brake=local_brake)
    common = checked(["git", "rev-parse", "--git-common-dir"], root).strip()
    return (root / common).resolve().parent


def read_settings(root: Path) -> dict:
    path = shared_root(root) / SETTINGS
    if not path.is_file():
        raise ValueError("Integration pin required. Run factory init --source <complete Archon "
                         "checkout or URL> --revision <40-character SHA> --cache <directory>.")
    settings = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(settings, dict):
        raise ValueError(f"Invalid consumer settings: {path}")
    return settings


def _admission_bytes(path: Path, *, private: bool = True) -> bytes:
    """Read canonical deployment-owned files without following redirects."""
    if not hasattr(os, "getuid"):
        raise ValueError("Shared admission requires POSIX ownership checks; no native fallback")
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Shared admission requires canonical paths")
    for parent in path.parents:
        if parent.is_symlink():
            raise ValueError("Shared admission path contains a symlink")
        info = parent.stat()
        sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if info.st_uid not in {0, os.getuid()} or (info.st_mode & 0o022 and not sticky_root):
            raise ValueError("Shared admission parent directory is not owner-controlled")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & (0o077 if private else 0o022)):
            raise ValueError("Shared admission requires owner-controlled files")
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Shared admission file exceeds its size bound")
    return data


def _admission_json(path: Path) -> dict:
    data = _admission_bytes(path)
    try:
        value = json.loads(data)
    except (UnicodeError, ValueError) as error:
        raise ValueError("Shared admission deployment file is invalid") from error
    if not isinstance(value, dict):
        raise ValueError("Shared admission deployment file must be an object")
    return value


def default_admission_home() -> Path:
    # HOME and ARCHON_HOME are caller environment, not an enrollment opt-out.
    if hasattr(os, "getuid"):
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve() / ".archon"
    return Path.home().resolve() / ".archon"


def shared_admission(root: Path) -> dict | None:
    """Enforce enrolled wrappers; raw Archon CLI/API remains outside this boundary.

    The private home registry is authoritative. A second project marker keeps
    a missing registry fail-closed; a matching registry also enforces enrollment
    when the marker is missing. Changing ARCHON_HOME cannot hide the default
    registry. Neither caller arguments nor project schedule flags select a controller.
    """
    verify_git_environment()
    shared = shared_root(root)
    marker_path = shared / ADMISSION_MARKER
    marker = None
    paths = {default_admission_home() / ADMISSION_REGISTRY,
             archon_home() / ADMISSION_REGISTRY}
    if marker_path.exists() or marker_path.is_symlink():
        marker = _admission_json(marker_path)
        if (set(marker) != {"schema", "registry", "project"} or marker["schema"] != "factory-enrolled-v1"
                or not isinstance(marker["registry"], str) or not isinstance(marker["project"], str)):
            raise ValueError("Invalid shared admission enrollment marker")
        paths.add(Path(marker["registry"]))
        if not Path(marker["registry"]).exists():
            raise ValueError("Enrolled controller registry is missing; no native fallback")
    found = []
    for path in sorted(paths):
        if not path.exists() and not path.is_symlink():
            continue
        registry = _admission_json(path)
        if (set(registry) != {"schema", "controller", "config", "config_sha256", "controller_files", "projects"}
                or registry["schema"] != "factory-controller-v1" or not isinstance(registry["projects"], dict)
                or not all(isinstance(registry[key], str) and registry[key] for key in ("controller", "config", "config_sha256"))):
            raise ValueError("Invalid shared admission controller registry")
        config_path = Path(registry["config"])
        config_bytes = _admission_bytes(config_path)
        if hashlib.sha256(config_bytes).hexdigest() != registry["config_sha256"]:
            raise ValueError("Shared admission deployment config pin changed")
        try:
            config = json.loads(config_bytes)
            projects = config["projects"]
            if not isinstance(projects, dict):
                raise ValueError()
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError("Invalid shared admission deployment config") from error
        entry = registry["projects"].get(str(shared))
        if entry is None:
            # Exact mappings are independently validated below. Probe other
            # configured roots only to detect a missing enrolled mapping; any
            # unavailable potential alias still refuses rather than falling back.
            known = False
            for value in projects.values():
                if not isinstance(value, dict):
                    continue
                for key in ("registered_root", "consumer_root"):
                    candidate = value.get(key)
                    if isinstance(candidate, str) and (candidate == str(shared) or
                            (Path(candidate).is_dir() and shared_root(Path(candidate)) == shared)):
                        known = True
                        break
                if known:
                    break
            if known or (marker and marker["registry"] == str(path)):
                raise ValueError("Enrolled project mapping is missing; no native fallback")
            continue
        if (not isinstance(entry, dict) or set(entry) != {"project", "source_root", "source_revision", "consumer_sha256", "pack_sha256"}
                or not isinstance(entry["project"], str) or entry["project"] not in projects):
            raise ValueError("Invalid enrolled project mapping")
        if marker and (marker["registry"] != str(path) or marker["project"] != entry["project"]):
            raise ValueError("Shared admission enrollment conflicts with registry")
        project = projects[entry["project"]]
        if (not isinstance(project, dict) or project.get("identifier") != entry["project"] or
                any(project.get(key) != entry[key] for key in ("source_root", "source_revision", "consumer_sha256", "pack_sha256")) or
                any(not isinstance(project.get(key), str) for key in ("registered_root", "consumer_root")) or
                any(shared_root(Path(project[key])) != shared for key in ("registered_root", "consumer_root"))):
            raise ValueError("Shared admission project identity or source pins changed")
        if (hashlib.sha256(_admission_bytes(Path(__file__).resolve(), private=False)).hexdigest() != entry["consumer_sha256"] or
                hashlib.sha256(_admission_bytes(HERE / "pack.json", private=False)).hexdigest() != entry["pack_sha256"]):
            raise ValueError("Enrolled consumer or pack pin changed")
        home_value = config.get("archon_home", str(Path.home() / ".archon"))
        if not isinstance(home_value, str):
            raise ValueError("Invalid shared admission Archon home")
        configured_home = Path(home_value).expanduser().resolve()
        if path != configured_home / ADMISSION_REGISTRY or archon_home() != configured_home:
            raise ValueError("Shared admission Archon home changed; no native fallback")
        controller = Path(registry["controller"])
        pins = registry["controller_files"]
        if (controller.name != "factoryctl.py" or not isinstance(pins, dict) or
                set(pins) != {item.name for item in controller.parent.glob("*.py")} or controller.name not in pins):
            raise ValueError("Shared controller module inventory changed")
        for item in controller.parent.iterdir():
            if (item.is_symlink() or item.suffix in {".pyc", ".so", ".pyd"} or
                    (item.is_dir() and any((item / ("__init__" + suffix)).exists()
                                          for suffix in importlib.machinery.all_suffixes()))):
                raise ValueError("Shared controller has an unpinned import shadow")
        for name, expected in pins.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.py", name) or not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
                raise ValueError("Invalid shared controller module pin")
            if hashlib.sha256(_admission_bytes(controller.parent / name, private=False)).hexdigest() != expected:
                raise ValueError("Shared controller module pin changed")
        found.append({"controller": str(controller), "config": str(config_path), "project": entry["project"],
                      "grant": project.get("schedule"), "registry": str(path),
                      "consumer_root": project["consumer_root"],
                      "consumer_sha256": entry["consumer_sha256"], "pack_sha256": entry["pack_sha256"]})
    if len(found) > 1 or (marker and not found):
        raise ValueError("Shared admission registry is missing or ambiguous; no native fallback")
    return found[0] if found else None


def shared_command(binding: dict, command: str, cache: str, *args: str) -> list[str]:
    # The controller uses stdlib and pinned local sources only. Ignore site and
    # environment hooks; an empty private cache plus -B prevents stale bytecode
    # from substituting for the source bytes whose digests were verified.
    return [sys.executable, "-E", "-s", "-S", "-B", "-X", f"pycache_prefix={cache}",
            binding["controller"], "--config", binding["config"],
            command, binding["project"], *args]


def verify_source(settings: dict) -> Path:
    revision = settings.get("revision", "")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Integration revision must be a full lowercase commit SHA")
    source = Path(settings["source"]).resolve()
    if source.name != revision:
        raise ValueError("Source must use an immutable per-pin directory named with its full SHA")
    actual = checked(["git", "rev-parse", "HEAD"], source).strip()
    if actual != revision:
        raise ValueError(f"Source SHA mismatch: expected {revision}, found {actual}")
    dirty = checked(["git", "status", "--porcelain", "--untracked-files=all"], source)
    if dirty.strip():
        # Name the paths and the way back. The usual cause is a dependency install
        # inside the pinned tree, which looks harmless and stops every run.
        changed = [line[3:].strip() for line in dirty.strip().splitlines() if line[3:].strip()]
        shown = ", ".join(changed[:5])
        if len(changed) > 5:
            shown += f", and {len(changed) - 5} more"
        raise ValueError(
            f"Pinned source has changes ({shown}). The pinned tree is verified byte for byte. "
            f"Restore it with: rm -rf {source} && python3 bin/factory.py init from your repo. "
            f"To change engine behavior, move the pin in factory/pack.json instead of editing the tree"
        )
    # Include ignored files under authoring roots: an ignored workflow can shadow a
    # committed name just as an untracked one can. Runtime dependencies stay ignored.
    tracked = set(checked(["git", "ls-files"], source).splitlines())
    for directory in (source / ".archon", source / "packages/cli/src"):
        if directory.is_symlink() or not directory.resolve().is_relative_to(source):
            raise ValueError(f"Source authoring directory escapes the pin: {directory}")
        for path in directory.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Source authoring symlink is not supported: {path}")
            if path.is_file() and path.relative_to(source).as_posix() not in tracked:
                raise ValueError(f"Untracked authoring file in pinned source: {path}")
    for rel in (ENTRY, "package.json", "bun.lock", MANIFEST["source_directory"]):
        if not (source / rel).exists():
            raise ValueError(f"Incomplete Archon source: missing {rel}")
    if not (source / "node_modules").is_dir():
        raise ValueError("Archon dependencies missing; complete the pinned source installation")
    return source


def cli(settings: dict, source: Path) -> list[str]:
    # Never use an ambient archon binary or provider command override.
    return [settings.get("bun", "bun"), str(source / ENTRY)]


def native_json(settings: dict, source: Path, args: list[str], cwd: Path) -> dict:
    raw = checked([*cli(settings, source), *args, "--cwd", str(cwd), "--json"], cwd)
    data = json.loads(raw)  # One whole document, including pretty-printed JSON.
    if not isinstance(data, dict) or data.get("ok") is False:
        raise ValueError(f"Invalid native response: {raw[:1000]}")
    return data


def source_workflows(source: Path) -> dict[str, Path]:
    # This is only a provenance index. Archon parses and validates the definitions.
    found = {}
    for path in (source / MANIFEST["source_directory"]).rglob("*"):
        if path.suffix not in (".yaml", ".yml"):
            continue
        match = re.search(r"^name:\s*['\"]?([a-z][a-z0-9-]*)['\"]?\s*$",
                          path.read_text(encoding="utf-8"), re.M)
        if match:
            name = match[1]
            if name in found:
                raise ValueError(f"Duplicate source workflow: {name}")
            found[name] = path
    # A second project definition must not shadow a selected pack member.
    for path in (source / ".archon/workflows").rglob("*"):
        if path.suffix not in (".yaml", ".yml") or path in found.values():
            continue
        match = re.search(r"^name:\s*['\"]?([a-z][a-z0-9-]*)['\"]?\s*$",
                          path.read_text(encoding="utf-8"), re.M)
        if match and match[1] in found:
            raise ValueError(f"Conflicting workflow outside the SDLC pack: {path}")
    # Packaged resources are resolved relative to their author's package by
    # Archon. Require the literal references to exist there, so a home-scoped or
    # bundled fallback cannot make an incomplete source look installable. Native
    # validation below remains responsible for parsing, types and the graph.
    for name, path in found.items():
        for kind, value in re.findall(r"^\s+(command|script|include):\s*([^\n#]+)",
                                      path.read_text(encoding="utf-8"), re.M):
            value = value.strip().strip("'\"")
            # Inline script code is already part of this pinned YAML. Match the
            # native isInlineScript rule; it has no external file to resolve.
            if kind == "script" and re.search(r"[;(){}&|<>$`\"' ]", value):
                continue
            if not re.fullmatch(r"[a-zA-Z0-9_./-]+", value):
                raise ValueError(f"Cannot verify nonliteral {kind} provenance in {name}: {value}")
            if kind == "include":
                if value not in found:
                    raise ValueError(f"Include {value} is missing from pinned SDLC source")
                continue
            directory = path.parent / ("commands" if kind == "command" else "scripts")
            candidates = [directory / (value + ".md")] if kind == "command" else [
                directory / (value + suffix) for suffix in ("", ".py", ".ts", ".js", ".sh")]
            if not any(p.is_file() and p.resolve().is_relative_to(source) for p in candidates):
                raise ValueError(f"Missing source-owned {kind} {value} for {name}")
    return found


def discover(settings: dict, source: Path) -> dict[str, Path]:
    local = source_workflows(source)
    data = native_json(settings, source, ["workflow", "list"], source)
    if data.get("errors"):
        raise ValueError(f"Native workflow discovery errors: {data['errors']}")
    rows = data.get("workflows")
    if not isinstance(rows, list):
        raise ValueError("Native workflow list returned no workflows array")
    names = {row["name"] for row in rows}
    return {name: path for name, path in local.items() if name in names}


def validate(settings: dict, source: Path, name: str) -> None:
    data = native_json(settings, source, ["validate", "workflows", name], source)
    results = data.get("results", [])
    if (not results or any(row.get("valid") is not True for row in results)
            or data.get("summary", {}).get("errors", 0)):
        raise ValueError(f"Workflow/command validation failed for {name}: {data}")


def doctor(settings: dict) -> dict:
    source = verify_source(settings)
    # Global flags such as --json are documented once, in the top-level workflow
    # help, and not repeated under every subcommand (`workflow status --help` lists
    # only --events and --all, yet `status --json` works). A flag counts as
    # documented when either help names it; the subcommand itself must still exist.
    shared_help = checked([*cli(settings, source), "workflow", "--help"], source)
    for command, flags in MANIFEST["capabilities"].items():
        help_text = checked([*cli(settings, source), "workflow", command, "--help"], source)
        if f"workflow {command}" not in help_text or any(
                flag not in help_text and flag not in shared_help for flag in flags):
            raise ValueError(f"Pinned CLI missing workflow {command} capability: {flags}")
    discovered = discover(settings, source)
    missing = sorted(set(MANIFEST["entries"]) - discovered.keys())
    if missing:
        raise ValueError("Incomplete integration source; missing shared workflows: " + ", ".join(missing))
    for name in discovered:
        validate(settings, source, name)
    return {"source": str(source), "revision": settings["revision"],
            "workflows": sorted(discovered), "automation": "supervised integration",
            "provider_configuration": "native configuration preserved; authentication not live-tested"}


# Merge policy keys a project declares once in harness/harness.config.json.
MERGE_POLICY_KEYS = ("required_checks", "protected_paths")


def harness_inputs(root: Path, name: str) -> dict:
    # A project's merge policy is a fact the merge gate reads, not something an
    # agent decides. GitHub cannot report required checks on plans without branch
    # protection, and nothing on GitHub says which files only a human may change,
    # so the project declares both once in its harness configuration.
    if name not in MERGING_WORKFLOWS:
        return {}
    policy_file = "harness/harness.config.json"
    requirement = (f"Merge policy required: {policy_file} must be a readable JSON object "
                   "declaring required_checks and protected_paths as nonempty comma-separated "
                   "strings (or explicit \"none\").")
    try:
        config = json.loads((root / policy_file).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise ValueError(requirement) from None
    if not isinstance(config, dict):
        raise ValueError(requirement)
    policy = {}
    for key in MERGE_POLICY_KEYS:
        value = config.get(key)
        invalid = not isinstance(value, str) or not value.strip()
        if not invalid:
            # Match the native policy grammar; whitespace around list items is allowed.
            # Native path-policy treats mixed `none` as a literal path pattern;
            # only required-check lists reserve it exclusively as a sentinel.
            items = [re.sub(r"^[\s\ufeff]+|[\s\ufeff]+$", "", item)
                     for item in value.split(",")]
            invalid = bool(re.search(r"[\x00-\x08\x0e-\x1f\x7f-\x9f]", value)) or any(
                not item or re.search(r"[\x00-\x1f\x7f-\x9f]", item)
                or (key == "required_checks" and len(items) > 1 and item.lower() == "none")
                or (key == "protected_paths" and item == "/") for item in items)
        if invalid:
            label = "check names" if key == "required_checks" else "path patterns"
            raise ValueError(f"Invalid merge policy: {policy_file} {key} must be a nonempty "
                             f"comma-separated string of {label}, or explicit \"none\".")
        policy[key] = value
    return policy


def workflow_defaults(root: Path, name: str) -> dict:
    return {**MANIFEST.get("default_inputs", {}).get(name, {}), **harness_inputs(root, name)}


def verify_scheduled_policy(root: Path, config_path: Path, schedule_data: dict) -> None:
    """Refuse stale installed merge inputs before changing admission state."""
    reinstall = ("Installed trigger policy is stale or malformed. Run factory schedule install "
                 "to preview, then repeat with --apply.")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    binding = config.get("binding") if isinstance(config, dict) else None
    launch = binding.get("launch") if isinstance(binding, dict) else None
    workflow = schedule_data.get("workflow", "archon-lifecycle")
    if (not isinstance(launch, dict) or not isinstance(workflow, str)
            or launch.get("workflowName") != workflow):
        raise ValueError(reinstall)
    inputs = schedule_data.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("schedule.json requires an inputs object")
    if workflow not in MERGING_WORKFLOWS:
        return
    # Validate the declaration even when explicit schedule inputs override it,
    # matching install/direct-run behavior. Overrides remain authoritative.
    policy = harness_inputs(root, workflow)
    effective = {key: (inputs[key] if isinstance(inputs[key], str) else json.dumps(inputs[key]))
                 if key in inputs else value for key, value in policy.items()}
    installed = launch.get("inputs")
    if not isinstance(installed, dict) or any(installed.get(key) != value for key, value in effective.items()):
        raise ValueError(reinstall)


def with_default_inputs(name: str, args: list[str], options: list[str], root: Path) -> list[str]:
    supplied = set()
    for index, arg in enumerate(options):
        if arg == "--input" and index + 1 < len(options):
            supplied.add(options[index + 1].split("=", 1)[0])
        elif arg.startswith("--input="):
            supplied.add(arg.removeprefix("--input=").split("=", 1)[0])
    defaults = workflow_defaults(root, name)
    injected = [item for key, value in defaults.items() if key not in supplied
                for item in ("--input", f"{key}={value}")]
    return [args[0], *injected, *args[1:]]


def invoke(root: Path, action: str, args: list[str]) -> int:
    args = list(args)
    binding = None if action in {"halt", "pause"} else shared_admission(root)
    if binding:
        verify_registry_environment(root)
    if binding and action in {"run", "resume", "cancel", "abandon", "unpause", "approve", "reject", "respond"}:
        if action in {"approve", "reject", "respond"}:
            raise ValueError("Enrolled human-gate continuation is withheld until shared capacity admission is supported. "
                             f"Keep the gate pending; inspect with factoryctl run {binding['project']} RUN_ID. "
                             "A human decision cannot bypass admission.")
        command = {"run": "start", "resume": "resume-run", "cancel": "cancel", "abandon": "abandon-run", "unpause": "resume-intake"}[action]
        target = " ISSUE_URL" if action == "run" else ("" if action == "unpause" else " RUN_ID")
        raise ValueError(f"Enrolled execution requires factoryctl {command} {binding['project']}{target} "
                         "--request-id STABLE_ID --authorization-ref USER_INSTRUCTION; no native fallback")
    runtime_config = None
    options = args[:args.index("--")] if "--" in args else args[:]
    runtime_flags = [a for a in options if a.split("=", 1)[0] == "--runtime-host"]
    if runtime_flags:
        if action != "run" or len(runtime_flags) != 1:
            raise ValueError("--runtime-host supports one foreground run only")
        if any(a.split("=", 1)[0] in {"--detach", "--resume", "-d"} for a in options):
            raise ValueError("Detached/resumed runtime-host mode is unsupported: no public durable ownership contract; use a new foreground run")
        flag = runtime_flags[0]
        index = args.index(flag)
        if "=" in flag:
            runtime_config = flag.split("=", 1)[1]
            del args[index]
        else:
            if index + 1 >= len(options) or options[index + 1].startswith("--"):
                raise ValueError("--runtime-host requires a trusted project configuration path")
            runtime_config = args.pop(index + 1)
            args.pop(index)
        if not runtime_config:
            raise ValueError("--runtime-host requires a configuration path")
    if action == "schedule":
        return schedule(root, args)
    if action not in {"run", "list", "get", "status", "runs", "abandon", "approve", "reject", "respond",
                      "cancel", "resume", "doctor", "halt", "unhalt", "pause", "unpause"}:
        raise ValueError(f"Unknown command '{action}'. Run factory --help for the commands.")
    common_root = shared_root(root, local_brake=True) if action in {"halt", "pause"} else shared_root(root)
    stop = common_root / ".factory/STOP"
    if action in {"halt", "unhalt"}:
        if args:
            raise ValueError(f"{action} takes no arguments. Cancel an active run by its run ID.")
        if action == "halt":
            stop.parent.mkdir(parents=True, exist_ok=True)
            stop.write_text("Operator stopped new factory launches.\n", encoding="utf-8")
        else:
            stop.unlink(missing_ok=True)
        print("Local launch brake " + ("set. Active runs require cancel <run-id>." if action == "halt" else "cleared."))
        return 0
    if action in {"pause", "unpause"}:
        # Launch-only: the timer stops starting laps but keeps waking durable waits, so a lap
        # already in flight (paused on CI, a usage limit) still finishes. Disabling the host
        # timer instead strands it; halt blocks its continuation by design.
        if args:
            raise ValueError(f"{action} takes no arguments")
        pause = common_root / PAUSE
        if action == "pause":
            pause.parent.mkdir(parents=True, exist_ok=True)
            pause.write_text("Operator paused scheduled launches.\n", encoding="utf-8")
        else:
            pause.unlink(missing_ok=True)
        print("Scheduled launches " + ("paused. Active runs remain unchanged."
                                       if action == "pause" else "resumed."))
        return 0
    for arg in args:
        if arg.split("=", 1)[0] in {"--cwd", "--workflow-source"}:
            raise ValueError("Factory owns --cwd and --workflow-source; select the application by working directory")
    if action in {"run", "resume", "approve", "respond"} and stop.exists():
        raise ValueError("Local STOP is set. Use unhalt to permit launch/continuation; cancel remains available")
    settings = read_settings(root)
    source = verify_source(settings)
    if action == "doctor":
        print(json.dumps(doctor(settings), indent=2))
        return 0
    if action == "list":
        print(json.dumps({"source": str(source), "revision": settings["revision"],
                          "workflows": sorted(discover(settings, source))}, indent=2))
        return 0
    # These flags must precede caller arguments. Appending after a caller's `--`
    # turns them into message text and silently restores ambient source discovery.
    native = ["workflow", action, "--cwd", str(root)]
    if action == "run":
        if not args:
            raise ValueError("Usage: factory run <shared-workflow> [native options and message]")
        name = args[0]
        if name not in discover(settings, source):
            raise ValueError(f"Shared workflow '{name}' is absent from the pinned SDLC source; no fallback")
        validate(settings, source, name)
        options = args[:args.index("--")] if "--" in args else args
        resuming = any(arg.split("=", 1)[0] == "--resume" for arg in options)
        if not resuming:
            native += ["--workflow-source", str(source)]
            args = with_default_inputs(name, args, options, root)
    native += args
    if action == "status":
        print(f"Factory source={source} revision={settings['revision']} local_STOP={stop.exists()}", file=sys.stderr)
    # Native output, exit code, inputs, identity and gates pass through unchanged.
    # No subprocess deadline or retry can guess whether a native run is alive.
    if runtime_config:
        from runtime_host import RuntimeHost
        with RuntimeHost(root / runtime_config) as host:
            return execute([*cli(settings, source), *native], root, capture=False,
                           timeout=None, env={**os.environ, **host.environment()}).returncode
    return execute([*cli(settings, source), *native], root,
                   capture=False, timeout=None).returncode


def repository_slug(root: Path) -> str:
    remote = checked(["git", "remote", "get-url", "origin"], root).strip()
    match = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?/?$", remote)
    if not match:
        raise ValueError("The origin remote does not name one owner/repo")
    return match[1]


def whoami(settings: dict, source: Path, root: Path) -> str:
    # The CLI prints log records before its JSON answer; read the last object.
    raw = checked([*cli(settings, source), "trigger", "whoami"], root)
    for start in reversed([m.start() for m in re.finditer(r"^\{", raw, re.M)]):
        try:
            data = json.loads(raw[start:])
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("runAsUserId"), str):
            return data["runAsUserId"]
    raise ValueError("archon trigger whoami returned no runAsUserId")


def base_branch(root: Path, schedule_data: dict) -> str | None:
    """The branch laps start from: schedule.json `base_branch`, else what the last fetch
    recorded as the remote's default (origin/HEAD), read locally. None when neither is
    known; the launch then asks the remote itself."""
    named = schedule_data.get("base_branch")
    if named is not None:
        if not isinstance(named, str) or not re.fullmatch(r"[A-Za-z0-9._/-]+", named):
            raise ValueError("schedule.json base_branch must be a branch name")
        return named
    result = execute(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root)
    head = result.stdout.strip() if result.returncode == 0 else ""
    return head.split("/", 1)[1] if head.startswith("origin/") else None


def trigger_config(root: Path, settings: dict, source: Path, interval: int) -> dict:
    """An Archon trigger binding for the scheduled shared workflow. Archon owns admission,
    the durable queue and overlap; this only names what to start."""
    schedule_file = shared_root(root) / SCHEDULE
    schedule_data = json.loads(schedule_file.read_text(encoding="utf-8"))
    runtime_binding_options(root, schedule_data)
    workflow = schedule_data.get("workflow", "archon-lifecycle")
    inputs = schedule_data.get("inputs")
    if not isinstance(workflow, str) or not isinstance(inputs, dict):
        raise ValueError("schedule.json requires a shared workflow and inputs object")
    if "runtime_host" in schedule_data:
        raise ValueError("A trigger cannot wrap the runtime host. Run it as its own service "
                         "(python factory/runtime_host.py serve --config <runtime.json> "
                         "--connection-file <connection.json>) and drop runtime_host from schedule.json")
    if workflow not in discover(settings, source):
        raise ValueError(f"Shared workflow '{workflow}' is absent from the pinned SDLC source")
    for key in inputs:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid scheduled workflow input name")
    values = {**workflow_defaults(root, workflow),
              **{k: v if isinstance(v, str) else json.dumps(v) for k, v in inputs.items()}}
    parallel = schedule_data.get("parallel", 1)
    if not isinstance(parallel, int) or isinstance(parallel, bool) or not 1 <= parallel <= 8:
        raise ValueError("schedule.json parallel must be a whole number of laps from 1 to 8")
    slug = repository_slug(root)
    # Archon fixes a slot's capacity when the slot is first used, so a different number
    # of parallel laps is a different slot.
    resource = f"github:{slug}:{workflow}" + (f":x{parallel}" if parallel > 1 else "")
    # Without a known base branch every launch asks the remote for its default branch
    # (one ls-remote, no retry); when that fails the run never starts and holds its slot.
    base = base_branch(root, schedule_data)
    isolation = {"kind": "worktree", "baseOverride": base} if base else {"kind": "default"}
    return {
        "version": 1,
        "sourceInstanceId": "factory-" + slug.replace("/", "-"),
        "binding": {
            "bindingId": "factory-" + workflow,
            "bindingRevision": None,
            "hostId": "factory-" + re.sub(r"[^A-Za-z0-9-]", "-", platform.node() or "host"),
            "runAsUserId": whoami(settings, source, root),
            # One resource per repository and workflow, holding at most `parallel` laps.
            # A tick that arrives while every lap is busy is skipped; the next tick
            # starts the next lap. The workflow keeps parallel laps off each other's work.
            "resource": resource,
            "capacity": parallel,
            "overlap": "skip",
            "launch": {"cwd": str(root), "workflowName": workflow, "inputs": values,
                       "discoveryCwd": str(source.resolve()),
                       "isolation": isolation},
        },
        "schedule": {"intervalSeconds": interval, "runAtLoad": False},
    }


def _private_path(path: Path, *, directory: bool = False) -> None:
    if path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"Runtime binding requires an ordinary private {'directory' if directory else 'file'}: {path}")
    metadata = path.stat()
    if os.name != "nt" and (metadata.st_mode & 0o077 or metadata.st_uid != os.getuid()):
        raise ValueError(f"Runtime binding path must be private to the current owner: {path}")


def runtime_binding_options(root: Path, data: dict) -> dict | None:
    """Opt-in caller-owned scenarios; the pinned workflow remains unchanged."""
    if not isinstance(data, dict):
        raise ValueError("schedule.json must contain a JSON object")
    value = data.get("runtime_binding")
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"helper", "invocation_root"}:
        raise ValueError("runtime_binding requires exactly helper and invocation_root")
    if data.get("workflow", "archon-lifecycle") != "archon-lifecycle":
        raise ValueError("runtime_binding supports archon-lifecycle only")
    if type(data.get("parallel", 1)) is not int or data.get("parallel", 1) != 1:
        raise ValueError("runtime_binding requires parallel=1")
    result = {}
    for key in ("helper", "invocation_root"):
        if not isinstance(value[key], str) or not Path(value[key]).is_absolute():
            raise ValueError(f"runtime_binding {key} must be an absolute path")
        path = Path(value[key])
        if path.is_symlink():
            raise ValueError(f"runtime_binding {key} must not be a symlink")
        result[key] = str(path.resolve())
    if not Path(result["helper"]).is_file():
        raise ValueError("runtime_binding helper does not exist")
    directory = Path(result["invocation_root"])
    if directory.exists():
        _private_path(directory, directory=True)
    return result


def _binding_write(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _binding_record(directory: Path, record: dict) -> None:
    # The current journal is written first: a crash must block a new dispatch.
    _binding_write(directory / "dispatch.json", record)
    invocation = Path(record["directory"])
    if invocation.is_dir():
        _private_path(invocation, directory=True)
        _binding_write(invocation / "dispatch.json", record)


def _binding_receipt(raw: str, config: dict) -> dict:
    """Require one exact persisted native admission, not just CLI exit zero."""
    digest = hashlib.sha256(json.dumps(config, separators=(",", ":"),
                                      ensure_ascii=False).encode()).hexdigest()
    try:
        documents = [json.loads(raw)]
    except ValueError:
        documents = []
        for line in raw.splitlines():
            try:
                documents.append(json.loads(line))
            except ValueError:
                pass
    receipts = [d for d in documents if isinstance(d, dict) and
                d.get("contentDigest") == digest and
                d.get("sourceInstanceId") == config["sourceInstanceId"]]
    if len(receipts) != 1:
        raise ValueError("No unambiguous matching native receipt")
    receipt = receipts[0]
    bindings = receipt.get("bindings", [])
    if not receipt.get("id") or receipt.get("outcome") != "matched" or len(bindings) != 1:
        raise ValueError("Invalid native receipt disposition")
    binding = bindings[0]
    expected = dict(config["binding"])
    observed = dict(binding.get("intent") or {})
    # Native trigger fire computes this field from the immutable binding itself.
    expected.pop("bindingRevision", None)
    observed.pop("bindingRevision", None)
    if observed != expected or binding.get("bindingId") != expected["bindingId"] or \
            binding.get("status") != "complete" or \
            (binding.get("disposition") or {}).get("status") not in {"admitted", "skipped"}:
        raise ValueError("Native binding is incomplete or differs from dispatch intent")
    return receipt


def dispatch_bound_trigger(root: Path, settings: dict, source: Path, config_path: Path,
                           options: dict, write) -> int:
    """Called under fire.lock. Never replay a dispatch with an unknown outcome."""
    if shared_admission(root):
        raise ValueError("Enrolled runtime dispatch requires factoryctl schedule-tick; no native fallback")
    directory = Path(options["invocation_root"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    _private_path(directory, directory=True)
    journal = directory / "dispatch.json"
    if journal.exists():
        _private_path(journal)
        previous = json.loads(journal.read_text(encoding="utf-8"))
        if previous.get("status") not in {"acknowledged", "aborted_before_dispatch"}:
            raise ValueError(f"Runtime dispatch unresolved; inspect {journal} before another launch")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    binding = config["binding"]
    if binding.get("capacity") != 1 or binding.get("overlap") != "skip" or \
            binding["launch"].get("workflowName") != "archon-lifecycle" or \
            Path(binding["launch"]["cwd"]).resolve() != root.resolve():
        raise ValueError("Runtime binding requires this project's single-slot lifecycle trigger")
    launch = binding["launch"]
    if launch.get("discoveryCwd") is not None and \
            Path(launch["discoveryCwd"]).resolve() != source.resolve():
        raise ValueError("Runtime trigger discovery source differs from the verified pin")
    # Match native schema key order: its contentDigest hashes JSON.stringify(parsed).
    # Rebuild old installed triggers rather than appending discoveryCwd after isolation.
    binding["launch"] = {"cwd": launch["cwd"], "workflowName": launch["workflowName"],
                         "inputs": launch["inputs"], "discoveryCwd": str(source.resolve()),
                         **({"configSource": launch["configSource"]} if "configSource" in launch else {}),
                         "isolation": launch["isolation"]}
    invocation = directory / str(uuid.uuid4())
    helper = Path(options["helper"])
    record = {"version": 1, "status": "preparing", "directory": str(invocation),
              "project_root": str(root.resolve()), "created_at": time.time(),
              "helper": str(helper), "helper_sha256": hashlib.sha256(helper.read_bytes()).hexdigest(),
              "source_revision": settings["revision"]}
    _binding_record(directory, record)
    try:
        raw = checked([sys.executable, str(helper), "create", "--project-root", str(root.resolve()),
                       "--output", str(invocation)], root)
        prepared = json.loads(raw)
        if not isinstance(prepared, dict) or not isinstance(prepared.get("invocation"), str):
            raise ValueError("Runtime binding helper returned an invalid invocation")
        uuid.UUID(prepared["invocation"])
        _private_path(invocation, directory=True)
        paths = {}
        for key in ("runtime", "holdout"):
            path = Path(prepared[key])
            if not path.is_absolute() or not path.resolve().is_relative_to(invocation.resolve()):
                raise ValueError("Runtime scenario escaped its invocation directory")
            _private_path(path)
            paths[key] = str(path.resolve())
        if paths["runtime"] == paths["holdout"]:
            raise ValueError("Runtime and holdout need separate scenario files")
        if hashlib.sha256(helper.read_bytes()).hexdigest() != record["helper_sha256"]:
            raise ValueError("Runtime binding helper changed during preparation")
        binding["launch"]["inputs"].update(scenario=paths["runtime"], holdout=paths["holdout"])
        invocation_config = invocation / "trigger.json"
        _binding_write(invocation_config, config)
        record.update(invocation=prepared["invocation"], trigger=str(invocation_config),
                      trigger_sha256=hashlib.sha256(invocation_config.read_bytes()).hexdigest(),
                      scenario_sha256={k: hashlib.sha256(Path(v).read_bytes()).hexdigest()
                                       for k, v in paths.items()})
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        record["status"] = "aborted_before_dispatch"
        _binding_record(directory, record)
        raise
    if (shared_root(root) / ".factory/STOP").exists() or (shared_root(root) / PAUSE).exists():
        record["status"] = "aborted_before_dispatch"
        _binding_record(directory, record)
        write("Runtime prepared, but STOP/PAUSE now blocks dispatch.\n")
        return 0
    record["status"] = "dispatching"
    _binding_record(directory, record)
    try:
        result = execute([*cli(settings, source), "trigger", "fire", "--config", str(invocation_config)],
                         root, capture=True, timeout=None)
        if result.stdout:
            write(result.stdout)
        if result.stderr:
            write(result.stderr)
        if result.returncode:
            raise ValueError(f"Native trigger exited {result.returncode}")
        receipt = _binding_receipt(result.stdout or "", config)
        record.update(status="acknowledged", receipt=receipt, acknowledged_at=time.time())
        _binding_record(directory, record)
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        record.update(status="uncertain", error=str(error)[:500])
        _binding_record(directory, record)
        raise ValueError(f"Runtime dispatch uncertain; no retry permitted. Inspect {journal}") from error


def reconcile_runtime_dispatch(root: Path, settings: dict, source: Path, options: dict,
                               receipt_id: str) -> None:
    directory = Path(options["invocation_root"])
    _private_path(directory, directory=True)
    journal = directory / "dispatch.json"
    _private_path(journal)
    record = json.loads(journal.read_text(encoding="utf-8"))
    if record.get("status") not in {"dispatching", "uncertain"}:
        raise ValueError("Only an unresolved dispatched invocation can be reconciled")
    if record.get("project_root") != str(root.resolve()) or record.get("source_revision") != settings["revision"]:
        raise ValueError("Dispatch project or source revision differs from current consumer")
    path = Path(record["trigger"])
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError("Dispatch trigger escaped invocation root")
    _private_path(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != record.get("trigger_sha256"):
        raise ValueError("Dispatch trigger changed after preparation")
    config = json.loads(path.read_text(encoding="utf-8"))
    if config["binding"]["launch"].get("discoveryCwd") != str(source.resolve()):
        raise ValueError("Dispatch discovery source differs from the verified pin")
    raw = checked([*cli(settings, source), "trigger", "inspect", receipt_id], root)
    receipt = _binding_receipt(raw, config)
    if receipt["id"] != receipt_id:
        raise ValueError("Native receipt ID differs from the inspected receipt")
    record.update(status="acknowledged", receipt=receipt, reconciled_at=time.time())
    _binding_record(directory, record)


def task_xml(python: Path, root: Path, minutes: int) -> str:
    """A Task Scheduler definition that runs `schedule fire` hidden every N minutes."""
    def text(value: object) -> str:
        return (str(value).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))
    start = time.strftime("%Y-%m-%dT%H:%M:%S")
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Archon factory trigger for {text(root)}</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT{minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{text(python)}</Command>
      <Arguments>factory\\consumer.py schedule fire</Arguments>
      <WorkingDirectory>{text(root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def _systemd_word(value: str) -> str:
    """Quote one systemd word, preserving literal specifiers and C escape characters."""
    if re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        raise ValueError("Systemd paths and environment values cannot contain control characters")
    return json.dumps(value.replace("%", "%%"), ensure_ascii=False)


def verified_timer_root(admission: dict) -> Path:
    root = Path(admission["consumer_root"])
    for name, key in (("consumer.py", "consumer_sha256"), ("pack.json", "pack_sha256")):
        if hashlib.sha256(_admission_bytes(root / "factory" / name, private=False)).hexdigest() != admission[key]:
            raise ValueError("Enrolled timer consumer or pack pin changed")
    return root


def timer_commands(root: Path, interval: int, *, include_wake: bool = True,
                   consumer_root: Path | None = None) -> dict:
    """Host schedulers invoke the consumer so STOP/PAUSE are checked before Archon."""
    fire = [sys.executable, str(root / "factory/consumer.py"), "schedule", "fire"]
    name = "ArchonFactory-" + re.sub(r"[^A-Za-z0-9-]", "-", root.name)
    if sys.platform == "win32":
        # pythonw has no console, so a tick flashes no window; schtasks /TR cannot set a
        # working directory, so the task is defined in XML. It runs only while the user
        # is logged on (a rendered runtime check needs the desktop session). Ticks run in
        # parallel: a wake that resumes a long lap must not hold back the next tick's
        # launch. `schedule fire` single-flights each phase itself, so ticks cannot stack.
        pythonw = Path(fire[0]).with_name("pythonw.exe")
        task = shared_root(root) / ".factory/schedule-task.xml"
        return {"task_xml": {task: task_xml(pythonw if pythonw.exists() else Path(fire[0]),
                                            root, max(1, interval // 60))},
                "install": [["schtasks", "/Create", "/TN", name, "/XML", str(task), "/F"]],
                "remove": [["schtasks", "/Delete", "/TN", name, "/F"]]}
    if sys.platform == "darwin":
        root = shared_root(root)
        execution_root = consumer_root if consumer_root is not None else root
        identity = hashlib.sha256(str(root).encode()).hexdigest()
        directory = Path.home() / "Library/LaunchAgents"
        domain = f"gui/{os.getuid()}"
        jobs = {}
        # A separate wake keeps CI continuations responsive while a fire is running.
        # Both paths check STOP; wake intentionally ignores PAUSE. No run at install.
        for action, seconds in ((("fire", interval), ("wake", 60)) if include_wake else (("fire", interval),)):
            label = f"com.archon.factory.{identity}.{action}"
            path = directory / f"{label}.plist"
            jobs[path] = plistlib.dumps({
                "Label": label,
                "ProgramArguments": [sys.executable, str(execution_root / "factory/consumer.py"),
                                     "schedule", action],
                "WorkingDirectory": str(execution_root),
                "EnvironmentVariables": {"ARCHON_HOME": str(archon_home().resolve()),
                                         "PATH": os.environ.get("PATH", "")},
                "StartInterval": seconds, "RunAtLoad": False,
                "StandardOutPath": str(root / ".factory/schedule.log"),
                "StandardErrorPath": str(root / ".factory/schedule.log"),
            }, sort_keys=True).decode()
        return {"launchd": jobs,
                "retire": [] if include_wake else [directory / f"com.archon.factory.{identity}.wake.plist"],
                "install": [["/bin/launchctl", "bootstrap", domain, str(path)] for path in jobs],
                "remove": [["/bin/launchctl", "bootout", f"{domain}/{path.stem}"] for path in jobs]}
    unit = name.lower()
    # systemd is not a shell: quote each word, escape %-specifiers, and disable
    # environment expansion with ':' so literal dollars survive in every argument.
    command = " ".join(_systemd_word(value) for value in [":" + fire[0], *fire[1:]])
    path_environment = _systemd_word("PATH=" + os.environ.get("PATH", ""))
    # WorkingDirectory accepts a raw path (no unquoting/C-unescaping). '/.' protects
    # a trailing space or backslash in the directory name from unit line parsing.
    working_directory = str(root).replace("%", "%%") + "/."
    # The timer gets what a manual run had: the same tool PATH, credentials from a
    # mode-600 file outside the repository, and IS_SANDBOX for Claude Code as root.
    return {"systemd": {
        f"{unit}.service": "[Unit]\nDescription=Archon factory trigger\n\n[Service]\nType=oneshot\n"
                           f"WorkingDirectory={working_directory}\nEnvironment={path_environment}\n"
                           "Environment=IS_SANDBOX=1\nEnvironmentFile=-%h/.factory-env\n"
                           f"ExecStart={command}\n",
        f"{unit}.timer": f"[Unit]\nDescription=Archon factory trigger\n\n[Timer]\nOnBootSec=2min\n"
                         f"OnUnitInactiveSec={interval}s\n\n[Install]\nWantedBy=timers.target\n"},
        "install": [["systemctl", "--user", "daemon-reload"],
                    ["systemctl", "--user", "enable", "--now", f"{unit}.timer"]],
        "remove": [["systemctl", "--user", "disable", "--now", f"{unit}.timer"]]}


def legacy_launchd_jobs(root: Path) -> list[Path]:
    """Find the actual old job, even if a preview or repo transfer changed its binding ID.
    Match config path/home from the plist instead of recomputing an obsolete hash."""
    directory = Path.home() / "Library/LaunchAgents"
    config = (shared_root(root) / TRIGGER).resolve()
    home = archon_home().resolve()
    found = []
    for path in sorted(directory.glob("com.archon.trigger.*.plist")):
        job = plistlib.loads(path.read_bytes())
        args = job.get("ProgramArguments", [])
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise ValueError(f"Invalid native launchd job: {path}")
        job_home = job.get("EnvironmentVariables", {}).get("ARCHON_HOME")
        if not job_home or Path(job_home).expanduser().resolve() != home:
            continue
        trigger = any(args[i:i + 3] == ["trigger", "fire", "--config"] and
                      Path(args[i + 3]).resolve() == config for i in range(len(args) - 3))
        wake = path.name.startswith("com.archon.trigger.workflow-wake-") and any(
            args[i:i + 2] == ["workflow", "wake"] for i in range(len(args) - 1))
        if trigger or wake:
            if job.get("Label") != path.stem:
                raise ValueError(f"Native launchd label does not match its file: {path}")
            found.append(path)
    return found


def remove_launchd_job(path: Path, root: Path) -> None:
    service = f"gui/{os.getuid()}/{path.stem}"
    loaded = execute(["/bin/launchctl", "print", service], root)
    if loaded.returncode == 0:
        checked(["/bin/launchctl", "bootout", service], root)
    path.unlink(missing_ok=True)


def configure_launchd(root: Path, plan: dict, apply: bool, *, remove: bool = False) -> None:
    # Remove all previous jobs before registering any replacement. An already unloaded
    # job still has its plist deleted so it cannot return after the next login.
    paths = list(dict.fromkeys([*legacy_launchd_jobs(root), *plan.get("retire", []), *plan["launchd"]]))
    for path in paths:
        print(f"{'Removing' if apply else 'Would remove'} launchd job: {path}")
        if apply:
            remove_launchd_job(path, root)
    if remove:
        return
    for path, body in plan["launchd"].items():
        print(f"--- {path}\n{body}")
        if apply:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
            path.chmod(0o600)
    for command in plan["install"]:
        print(("Running: " if apply else "Run to enable: ") + subprocess.list2cmdline(command))
        if apply:
            checked(command, root)


@contextlib.contextmanager
def single_flight(path: Path):
    """Yield True to the one process holding an OS lock on `path`, False to the rest.
    The lock dies with its process, so a killed tick never wedges later ones."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+", encoding="utf-8")
    try:
        try:
            if sys.platform == "win32":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        yield True
    finally:
        handle.close()


SCHEDULE_INSTALL_PENDING = ".factory/schedule-install-pending.json"


@contextlib.contextmanager
def schedule_install_guard(root: Path, apply: bool):
    """Keep partial binding/scheduler commits out of scheduled admission."""
    if not apply:
        yield
        return
    shared = shared_root(root)
    with single_flight(shared / ".factory/fire.lock") as held:
        if not held:
            raise ValueError("Another process is launching or installing; schedule installation refused")
        pending = shared / SCHEDULE_INSTALL_PENDING
        # Persist before replacing the binding. A crash or failed post-replace
        # directory sync must leave subsequent ticks unable to use a partial install.
        _binding_write(pending, {"state": "installing"})
        try:
            yield
            pending.unlink()
        except BaseException as error:
            error.add_note(
                f"Schedule installation may be partially committed; scheduled launches remain blocked by {pending}. "
                "Inspect the failure and rerun schedule install --apply to complete installation. "
                "Do not remove this guard to resume launches.")
            raise


ENDED = {"completed", "failed", "cancelled"}
ACTIVE = {"pending", "running", "paused"}
# A launch that died before its run started has written its last line by now.
STUCK_AFTER_SECONDS = 600


def archon_home() -> Path:
    return Path(os.environ.get("ARCHON_HOME") or Path.home() / ".archon").expanduser().resolve()


def verify_registry_environment(root: Path) -> None:
    # Match native CLI boot, not Bun's discarded application .env files:
    # strip-cwd-env-boot runs first, then loadCliEnv loads ARCHON_HOME/.env
    # and <cwd>/.archon/.env with override=true. User-scope keys may move the
    # home after the Python process has selected its SQLite registry. Native
    # Docker detection can also override ARCHON_HOME entirely.
    for key in ("DATABASE_URL", "ARCHON_DOCKER", "WORKSPACE_PATH"):
        if os.environ.get(key):
            raise ValueError(f"{key} selects an unsupported registry environment")
    registry_keys = "DATABASE_URL|ARCHON_HOME|HOME|USERPROFILE|ARCHON_DOCKER|WORKSPACE_PATH"
    assignment = re.compile(rf"(?mi)^\s*(?:export\s+)?({registry_keys})\s*(?:=|:\s)")
    for env_file in (archon_home() / ".env", root / ".archon/.env"):
        if env_file.is_file():
            keys = sorted(set(assignment.findall(env_file.read_text(encoding="utf-8-sig"))))
            if keys:
                # Even an empty override can clear a pinned ARCHON_HOME and
                # redirect to the default registry. Never print the values.
                raise ValueError(f"Registry redirect keys {', '.join(keys)} are configured in {env_file}")


def wake_allowed(root: Path, source: Path, write) -> bool:
    """Native wake is home-wide, not cwd-scoped. Withhold it if ANY registered repo
    is halted. Fail closed if the local SQLite registry cannot be verified. This is
    deliberately conservative until Archon exposes project-scoped continuations."""
    try:
        verify_registry_environment(root)
        registry = archon_home() / "archon.db"
        with contextlib.closing(sqlite3.connect(registry.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            rows = db.execute("SELECT default_cwd FROM remote_agent_codebases").fetchall()
        if not rows:
            raise ValueError("registry contains no codebases")
        roots = set()
        for (cwd,) in rows:
            if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
                raise ValueError("registry contains an unavailable or ambiguous codebase path")
            roots.add(shared_root(Path(cwd)))
        if shared_root(root) not in roots:
            raise ValueError("this project is absent from the registry")
        for registered_root in sorted(roots):
            if shared_admission(registered_root):
                write("Global wake withheld: enrolled roots require exact shared continuation admission.\n")
                return False
            if (registered_root / ".factory/STOP").exists():
                write(f"Global wake withheld: STOP is set in {registered_root}.\n")
                return False
        return True
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        raise ValueError(f"Global wake refused: cannot verify the Archon registry: {error}") from error


def sweep_stuck(root: Path, settings: dict, source: Path, runs: list[dict], write) -> set[str]:
    """Abandon runs whose launch failed before they started. Such a run stays `pending`
    with its slot held until someone abandons it; its launch log ends in the error."""
    if shared_admission(root):
        write("Automatic abandonment withheld: inspect the exact run with factoryctl.\n")
        return set()
    swept = set()
    for run in runs:
        if run.get("status") != "pending" or not isinstance(run.get("id"), str):
            continue
        launch_log = archon_home() / "logs" / f"trigger-run-{run['id']}.log"
        try:
            if time.time() - launch_log.stat().st_mtime < STUCK_AFTER_SECONDS:
                continue
            lines = [line for line in launch_log.read_text(encoding="utf-8", errors="replace").splitlines()
                     if line.strip()]
        except OSError:
            continue
        if not lines or not lines[-1].startswith("Error:"):
            continue
        result = execute([*cli(settings, source), "workflow", "abandon", run["id"], "--cwd", str(root)], root)
        if result.returncode == 0:
            swept.add(run["id"])
            write(f"Abandoned run {run['id']}, whose launch failed before it started: {lines[-1][:300]}\n")
        else:
            write(f"Could not abandon stuck run {run['id']}: {(result.stderr or result.stdout)[-300:]}\n")
    return swept


def tick_state(root: Path, **updates) -> dict:
    """The tick's small memory between runs (.factory/gate.json), updated in place."""
    path = shared_root(root) / ".factory/gate.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    if not isinstance(state, dict):
        raise ValueError(f".factory/gate.json must contain a JSON object (found {type(state).__name__})")
    if updates:
        state.update(updates)
        path.write_text(json.dumps(state) + "\n", encoding="utf-8")
    return state


EMPTY_LAP_SECONDS = 300
CHOOSING_SECONDS = 1800


def _when(value) -> float | None:
    try:
        return calendar.timegm(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return None


def empty_lap_since(runs: list[dict], since: float) -> bool:
    """Whether a lap started at or after `since` completed within a few minutes: it picked
    nothing. A lap that failed (a usage limit, an outage) says nothing about the board."""
    for run in runs:
        start, end = _when(run.get("started_at")), _when(run.get("completed_at"))
        if start is None or end is None or start + 60 < since:
            continue
        if run.get("status") == "completed" and end - start < EMPTY_LAP_SECONDS:
            return True
    return False


def launch_decision(root: Path, settings: dict, source: Path, write) -> bool:
    """Whether this tick should start a lap. A workflow without a launch gate always
    launches. With one, the tick first clears runs that never started and claims of runs
    that ended, then launches only when there is workable work and no lap is still
    choosing its item, plus one lap per idle period for bookkeeping. Any failure to read
    the board launches, as before the gate existed."""
    try:
        binding = json.loads((shared_root(root) / TRIGGER).read_text(encoding="utf-8"))["binding"]
        launch_config = binding["launch"]
        workflow, inputs = launch_config["workflowName"], launch_config.get("inputs") or {}
        capacity = binding.get("capacity")
    except (OSError, ValueError, KeyError, TypeError):
        return True
    try:
        schedule_data = json.loads((shared_root(root) / SCHEDULE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        schedule_data = {}
    gate = MANIFEST.get("launch_gates", {}).get(workflow)
    script = source / MANIFEST["source_directory"] / gate if gate else None
    if script is None or not script.is_file():
        return True
    state = tick_state(root)

    signature = ""

    def launch(reason: str) -> bool:
        write(f"Launch: {reason}\n")
        tick_state(root, last_launch=time.time(), last_launch_board=signature)
        return True

    try:
        listed = native_json(settings, source, ["workflow", "runs", "--limit", "100"], root)
        runs = [run for run in listed.get("runs", []) if run.get("workflow_name") == workflow]
        swept = sweep_stuck(root, settings, source, runs, write)
        ended = [run["id"] for run in runs if run.get("status") in ENDED]
        active = {run["id"] for run in runs if run.get("status") in ACTIVE} - swept
        result = execute([settings.get("bun", "bun"), str(script)], root, timeout=180, env={
            **os.environ,
            "INPUTS_CLAIM_HOURS": str(inputs.get("claim_hours", "")),
            "INPUTS_ENDED_RUNS": ",".join(ended)})
        if result.returncode:
            raise ValueError((result.stderr or result.stdout)[-500:])
        board = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        return launch(f"the launch gate could not read the board ({str(error)[:300]}).")
    for claim in board.get("ended", []):
        write(f"Released the claim run {claim['run']} left on #{claim['number']} when it ended.\n")
    workable = board.get("workable", [])
    # A lap is still choosing only early on: picking takes minutes. A long lap whose claim aged
    # out is not choosing, and counting it as such held every launch back (seen live: an
    # 8-hour lap blocked the second slot for over an hour).
    recent = {run["id"] for run in runs if run.get("id") in active and
              (_when(run.get("started_at")) or time.time()) >= time.time() - CHOOSING_SECONDS}
    choosing = recent - {claim["run"] for claim in board.get("claims", [])}
    names = ", ".join(f"#{item['number']}" for item in workable) or "nothing"
    # The board as a lap would see it. A lap that ended within minutes of starting picked
    # nothing (a real lap takes far longer); if the board is unchanged since that launch,
    # another lap would see the same and pick nothing too, so wait for the board to change
    # (seen live: items the gate counts as workable that pick stays clear of, because they
    # touch what a live claim is changing).
    signature = json.dumps([sorted(f"{item.get('kind')}:{item.get('number')}" for item in workable),
                            sorted(claim["run"] for claim in board.get("claims", []))])
    # Archon skips a start when every slot is busy; say so instead of recording a launch.
    if isinstance(capacity, int) and len(active) >= capacity:
        write(f"No launch: all {capacity} slot(s) busy; workable {names}.\n")
        return False
    if workable and not choosing and signature == state.get("last_launch_board") and \
            empty_lap_since(runs, state.get("last_launch", 0)):
        write(f"No launch: the last lap found nothing to start on this same board (workable {names}).\n")
        return False
    # One pick at a time: two laps choosing at once converge on the same item and the
    # later one loses the claim race (seen live). The next tick sees the first lap's claim.
    if workable and not choosing:
        return launch(f"workable {names}; no lap still choosing.")
    idle = schedule_data.get("idle_pick_minutes", 60)
    if not isinstance(idle, (int, float)) or isinstance(idle, bool) or idle < 0:
        raise ValueError("schedule.json idle_pick_minutes must be a number of minutes (0 turns it off)")
    if idle and not active and time.time() - state.get("last_launch", 0) >= idle * 60:
        return launch(f"nothing workable, but no lap has looked in {idle} minutes (bookkeeping).")
    write(f"No launch: workable {names}; {len(active)} lap(s) active, {len(choosing)} still choosing.\n")
    return False


def schedule(root: Path, args: list[str]) -> int:
    action = args[0] if args else ""
    flags = args[1:]
    admission = shared_admission(root)
    if admission and action in {"fire", "wake", "status"}:
        if flags:
            raise ValueError("Enrolled schedule operations accept no native arguments or target")
        if action == "wake":
            raise ValueError("Enrolled global wake is withheld pending exact shared continuation admission")
        shared = shared_root(root)
        lock = single_flight(shared / ".factory/fire.lock") if action == "fire" else contextlib.nullcontext(True)
        with lock as held:
            if not held:
                print("Shared launch withheld: another launch or installation owns the fire lock.", file=sys.stderr)
                return 0
            # Installation uses this same common-root lock. Keep it until the
            # controller returns, and check durable guards after fresh binding reads.
            verify_registry_environment(root)
            if shared_admission(root) != admission:
                raise ValueError("Shared admission binding changed before dispatch")
            if action == "fire":
                for marker in (".factory/STOP", PAUSE):
                    if (shared / marker).exists() or (shared / marker).is_symlink():
                        print("Scheduled launch withheld by local STOP/PAUSE.", file=sys.stderr)
                        return 0
                pending = shared / SCHEDULE_INSTALL_PENDING
                if pending.exists() or pending.is_symlink():
                    raise ValueError("Schedule installation is incomplete; shared launch withheld")
            with tempfile.TemporaryDirectory(prefix="factory-controller-cache-") as cache:
                return execute(shared_command(admission, "schedule-tick" if action == "fire" else "status", cache),
                               root, capture=False, timeout=None).returncode
    apply = "--apply" in flags
    interval = 300
    if "--interval" in flags:
        interval = int(flags[flags.index("--interval") + 1])
        if interval < 60:
            raise ValueError("--interval must be at least 60 seconds")
    settings = read_settings(root)
    source = verify_source(settings)
    config_path = shared_root(root) / TRIGGER
    stop = shared_root(root) / ".factory/STOP"
    native = cli(settings, source)
    if action == "reconcile-runtime":
        if len(flags) != 2 or flags[0] != "--receipt":
            raise ValueError("Usage: factory schedule reconcile-runtime --receipt <native-receipt-id>")
        verify_registry_environment(root)
        data = json.loads((shared_root(root) / SCHEDULE).read_text(encoding="utf-8"))
        options = runtime_binding_options(root, data)
        if options is None:
            raise ValueError("No runtime_binding configured")
        with single_flight(shared_root(root) / ".factory/fire.lock") as held:
            if not held:
                raise ValueError("Another tick is still launching; reconciliation refused")
            reconcile_runtime_dispatch(root, settings, source, options, flags[1])
        print("Exact native receipt reconciled; no launch was repeated.")
        return 0
    if action == "install":
        if admission:
            grant = admission["grant"]
            if (not isinstance(grant, dict) or type(grant.get("interval_seconds")) is not int
                    or not 60 <= grant["interval_seconds"] <= 86400):
                raise ValueError("Enrolled timer requires its deployment-owned schedule grant")
            if "--interval" in flags and interval != grant["interval_seconds"]:
                raise ValueError("Enrolled timer interval is owned by its schedule grant")
            interval = grant["interval_seconds"]
            schedule_path = shared_root(root) / SCHEDULE
            local_schedule = json.loads(schedule_path.read_text()) if schedule_path.exists() else {}
            if not isinstance(local_schedule, dict) or type(local_schedule.get("parallel", 1)) is not int or local_schedule.get("parallel", 1) != 1:
                raise ValueError("Enrolled schedules require exactly one project slot")
            config = None
            timer_root = verified_timer_root(admission)
            plan = timer_commands(timer_root, interval, include_wake=False, consumer_root=timer_root)
        else:
            config = trigger_config(root, settings, source, interval)
            plan = timer_commands(root, interval)
        with schedule_install_guard(root, apply):
            if admission:
                if shared_admission(root) != admission:
                    raise ValueError("Shared admission binding changed during timer installation")
                verified_timer_root(admission)
                print(f"Timer uses factoryctl schedule-tick {admission['project']}; existing STOP/PAUSE are preserved. No global wake.")
            else:
                binding_text = json.dumps(config, indent=2) + "\n"
                if apply:
                    config_path.parent.mkdir(parents=True, exist_ok=True)
                    _binding_write(config_path, config)
                    print(f"Wrote {config_path} (Archon trigger binding for {config['binding']['launch']['workflowName']}).")
                else:
                    print(f"Would write {config_path}:\n{binding_text}")
                base = config["binding"]["launch"]["isolation"].get("baseOverride")
                print(f"Laps start from {base}." if base else
                      "No default branch is known locally, so every launch asks the remote for it. "
                      "Run `git remote set-head origin --auto` or set base_branch in schedule.json.")
            if "launchd" in plan:
                configure_launchd(root, plan, apply)
                return 0
            for task_file, body in plan.get("task_xml", {}).items():
                print(f"--- {task_file}\n{body}")
                if apply:
                    task_file.parent.mkdir(parents=True, exist_ok=True)
                    task_file.write_text(body, encoding="utf-16")
            if "systemd" in plan:
                unit_dir = Path.home() / ".config/systemd/user"
                for file_name, body in plan["systemd"].items():
                    print(f"--- {unit_dir / file_name}\n{body}")
                    if apply:
                        unit_dir.mkdir(parents=True, exist_ok=True)
                        (unit_dir / file_name).write_text(body, encoding="utf-8")
            for command in plan["install"]:
                print(("Running: " if apply else "Run to enable: ") + subprocess.list2cmdline(command))
                if apply:
                    checked(command, root)
            return 0
    if action in {"fire", "wake"}:
        if stop.exists():
            print("Local STOP is set; no trigger fired. Use unhalt to resume.", file=sys.stderr)
            return 0
        # Refuse redirects before intake as well as before global continuation.
        verify_registry_environment(root)
        # A windowless timer tick (pythonw) has no console, so its output goes to a log.
        log = ((shared_root(root) / ".factory/schedule.log").open("a", encoding="utf-8")
               if windowless() else None)
        try:
            if log:
                log.write(f"=== schedule fire {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                log.flush()
            write = log.write if log else sys.stderr.write
            fired = 0
            if action == "wake":
                pass
            elif (shared_root(root) / PAUSE).exists():
                write("Scheduled launches paused; no trigger fired, waking only. Use unpause to resume.\n")
            else:
                # Ticks run in parallel (a long wake must not hold back the next launch), so
                # each phase admits one tick at a time; a tick that finds a phase busy skips it.
                try:
                    if not config_path.is_file():
                        raise ValueError("No trigger binding. Run factory schedule install to preview, "
                                         "then repeat with --apply.")
                    with single_flight(shared_root(root) / ".factory/fire.lock") as held:
                        if not held:
                            write("Another tick is still launching; this one skips the launch.\n")
                        else:
                            if (shared_root(root) / SCHEDULE_INSTALL_PENDING).exists():
                                raise ValueError("Schedule installation is incomplete; scheduled launches are blocked. "
                                                 "Inspect the failure and rerun schedule install --apply.")
                            schedule_file = shared_root(root) / SCHEDULE
                            data = json.loads(schedule_file.read_text(encoding="utf-8")) if schedule_file.exists() else {}
                            if not isinstance(data, dict):
                                raise ValueError("schedule.json must contain a JSON object")
                            verify_scheduled_policy(root, config_path, data)
                            if launch_decision(root, settings, source, write):
                                options = runtime_binding_options(root, data)
                                if options:
                                    fired = dispatch_bound_trigger(root, settings, source, config_path, options, write)
                                else:
                                    fired = execute([*native, "trigger", "fire", "--config", str(config_path)], root,
                                                    capture=False, timeout=None, output=log).returncode
                except Exception as error:
                    # Admission and continuation are independent: even an unexpected
                    # launch error must leave existing durable waits able to wake.
                    # STOP, registry trust checks, wake failures and operator interrupts
                    # remain outside this launch-only recovery boundary.
                    write(f"Launch phase error ({type(error).__name__}): {error}\n")
                    fired = 1
            if log:
                log.flush()
            # Resume due durable waits (CI pauses, usage-limit resumes) in the same tick.
            woken = 0
            with single_flight(archon_home() / "factory-wake.lock") as held:
                if held and wake_allowed(root, source, write):
                    woken = execute([*native, "workflow", "wake"], root, capture=False, timeout=None,
                                    output=log).returncode
                elif not held:
                    write("A wake from an earlier tick is still running; this one skips it.\n")
        finally:
            if log:
                log.close()
        return fired or woken
    if action == "remove":
        # Enrollment can bind a different worktree than the caller. Remove the
        # same scheduler identity that installation selected on every platform.
        timer_root = verified_timer_root(admission) if admission else root
        plan = timer_commands(timer_root, interval, include_wake=not bool(admission),
                              consumer_root=timer_root if admission else None)
        if "launchd" in plan:
            configure_launchd(root, plan, apply, remove=True)
            if apply:
                config_path.unlink(missing_ok=True)
            return 0
        for command in plan["remove"]:
            print(("Running: " if apply else "Run to disable: ") + subprocess.list2cmdline(command))
            if apply:
                execute(command, root)
        if apply:
            config_path.unlink(missing_ok=True)
        return 0
    if action == "status":
        return execute([*native, "trigger", "list"], root, capture=False, timeout=None).returncode
    raise ValueError("Usage: factory schedule install|fire|wake|remove|status [--interval <seconds>] [--apply] | reconcile-runtime --receipt <id>")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"--help", "-h"}:
        print("factory run <shared-workflow> [native arguments]\n"
              "factory run <shared-workflow> --runtime-host <config.json> [foreground native arguments]\n"
              "Runtime host: fresh ordinary apps; detach/resume unsupported. Manual: python factory/runtime_host.py serve --help\n"
              "factory schedule install [--interval <seconds>] [--apply] | fire | wake | remove [--apply] | status\n"
              "factory schedule reconcile-runtime --receipt <native-receipt-id> (inspect only; never relaunch)\n"
              "factory list | doctor | status | runs | get <run-id>\n"
              "factory approve | reject | respond | cancel | resume | abandon <run-id>\n"
              "factory halt | unhalt (local launch brake only)\n"
              "factory pause | unpause (stop/resume scheduled launches)\n"
              "Enrolled projects: schedule fire uses the shared controller; manual launches use factoryctl.\n"
              "Enrolled global wake and human-gate continuation remain withheld pending exact shared admission.\n"
              "These wrappers do not sandbox raw Archon CLI/API access.")
        return 0
    try:
        root = project_root(local_brake=True) if args[0] in {"halt", "pause"} else project_root()
        return invoke(root, args[0], args[1:])
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Factory refused: {error}", file=sys.stderr)
        for note in getattr(error, "__notes__", []):
            print(note, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
