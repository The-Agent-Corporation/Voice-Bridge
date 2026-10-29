"""Synthetic directory-preservation and source-identity regressions."""
from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "factory"))
import runtime_host
import runtime_resource


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve() / "input"
        self.root.mkdir()
        (self.root / "app.py").write_text("print('synthetic candidate')\n")

    def manager(self, *, bound=False, setup=None):
        root = ({"path": str(self.root), "binding": runtime_resource.MARKER}
                if bound else str(self.root))
        manager = runtime_host.Environments({"version": 1, "roots": {"candidate": root},
            "shape": "cli", "include": ["app.py", "empty"], "timeout_s": 5,
            "setup": setup, "command": [sys.executable, "app.py"]}, threading.Event())
        self.addCleanup(manager.close)
        return manager

    def git(self, *args, input=None):
        return subprocess.run(["git", "-c", "user.name=Synthetic Fixture", "-c",
            "user.email=fixture@example.invalid", *args], cwd=self.root,
            input=input, capture_output=True, text=True, check=True).stdout.strip()

    def test_selected_empty_and_nested_directories_survive_setup_snapshot(self):
        (self.root / "empty" / "nested").mkdir(parents=True)
        original = (self.root / "app.py").read_bytes()
        before = runtime_host.digest(runtime_host.source_files(self.root, ["app.py", "empty"]))
        setup = [sys.executable, "-c", "from pathlib import Path; "
            "assert Path('empty/nested').is_dir(); "
            "Path('empty/nested/created.txt').write_text('setup fixture')"]
        manager = self.manager(setup=setup)
        result = manager.start({"slot": "test", "root": "candidate", "expected_source": before})
        snapshot = Path(result["snapshot"])
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["input_digest"], before)
        self.assertNotEqual(result["source_digest"], before)
        self.assertEqual((snapshot / "empty/nested/created.txt").read_text(), "setup fixture")
        self.assertEqual((self.root / "app.py").read_bytes(), original)
        self.assertEqual(list((self.root / "empty/nested").iterdir()), [])
        self.assertEqual(manager.identity("test")["candidate"], result["candidate"])
        created = snapshot / "empty/nested/created.txt"
        created.chmod(0o600)
        created.write_text("changed after start")
        with self.assertRaisesRegex(ValueError, "changed candidate"):
            manager.identity("test")

    def test_bound_git_resource_preserves_selected_empty_tree(self):
        # Git's object format supports an empty tree even though git add does not
        # record empty working directories. Exercise the actual object preparer.
        repository = self.root
        self.git("init", "-q")
        blob = self.git("hash-object", "-w", "app.py")
        leaf = self.git("mktree", input="")
        empty = self.git("mktree", input=f"040000 tree {leaf}\tnested\n")
        tree = self.git("mktree", input=f"100644 blob {blob}\tapp.py\n040000 tree {empty}\tempty\n")
        revision = self.git("commit-tree", tree, "-m", "Synthetic empty directory")
        config = repository.parent / "config.json"
        config.write_text(json.dumps({"version": 1, "include": ["app.py", "empty"]}))
        self.root = repository.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(repository, revision)):
            binding = runtime_resource.prepare(self.root, config, revision)
        self.assertTrue((self.root / "empty/nested").is_dir())
        before = runtime_resource.resource_digest(self.root)
        marker = (self.root / runtime_resource.MARKER).read_bytes()
        manager = self.manager(bound=True)
        result = manager.start({"slot": "test", "root": "candidate", "expected_revision": revision})
        self.assertEqual(result["exit_code"], 0)
        snapshot = Path(result["snapshot"])
        self.assertTrue((snapshot / "empty/nested").is_dir())
        self.assertEqual(result["source_revision"], revision)
        self.assertEqual(result["source_tree"], tree)
        self.assertEqual(result["resource_digest"], binding["resource_digest"])
        self.assertEqual(result["input_digest"], result["source_digest"])
        self.assertEqual(runtime_resource.resource_digest(self.root), before)
        self.assertEqual((self.root / runtime_resource.MARKER).read_bytes(), marker)
        self.assertEqual(list((self.root / "empty/nested").iterdir()), [])
        self.assertEqual(manager.identity("test")["candidate"], result["candidate"])
        (snapshot / "empty/nested").rmdir()
        (snapshot / "empty").rmdir()
        with self.assertRaisesRegex(ValueError, "configured source missing"):
            manager.identity("test")

    def test_preparation_still_rejects_unsafe_committed_entries(self):
        self.git("init", "-q")
        blob = self.git("hash-object", "-w", "app.py")
        leaf = self.git("mktree", input="")
        link = self.git("hash-object", "-w", "--stdin", input="../outside")
        config = self.root.parent / "config.json"
        config.write_text(json.dumps({"version": 1, "include": ["app.py", "empty"]}))
        destination = self.root.parent / "refused"
        for entry in (f"040000 tree {leaf}\t.env\n", f"120000 blob {link}\tlinked\n"):
            with self.subTest(entry=entry):
                directory = self.git("mktree", input=entry)
                tree = self.git("mktree", input=f"100644 blob {blob}\tapp.py\n040000 tree {directory}\tempty\n")
                revision = self.git("commit-tree", tree, "-m", "Synthetic unsafe directory")
                with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
                    with self.assertRaises(ValueError):
                        runtime_resource.prepare(destination, config, revision)
                self.assertFalse(destination.exists())

    def resource_fixture(self, *, attributes=""):
        self.git("init", "-q")
        (self.root / "assets").mkdir()
        (self.root / "assets/selected.txt").write_bytes(b"selected committed bytes\x00\xff\n")
        (self.root / "assets/version.txt").write_bytes(b"$Format:%H$\n")
        (self.root / ".gitattributes").write_text(attributes)
        self.git("add", ".")
        self.git("update-index", "--chmod=+x", "app.py")
        self.git("commit", "-qm", "Synthetic resource inputs")
        revision = self.git("rev-parse", "HEAD")
        config = self.root.parent / "config.json"
        config.write_text(json.dumps({"version": 1, "include": ["app.py", "assets"]}))
        return revision, config

    def test_resource_keeps_selected_blobs_marked_export_ignore(self):
        revision, config = self.resource_fixture(attributes="assets/selected.txt export-ignore\n")
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
        expected = {"app.py", "assets/selected.txt", "assets/version.txt"}
        actual = {path.relative_to(destination).as_posix() for path in destination.rglob("*")
                  if path.is_file() and path.name != runtime_resource.MARKER}
        self.assertEqual(actual, expected)
        for relative in expected:
            committed = subprocess.run(["git", "cat-file", "blob", f"{revision}:{relative}"],
                cwd=self.root, capture_output=True, check=True).stdout
            self.assertEqual((destination / relative).read_bytes(), committed)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((destination / "app.py").stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((destination / "assets/selected.txt").stat().st_mode), 0o644)
        self.assertEqual(binding["resource_digest"], runtime_resource.resource_digest(destination))
        self.assertEqual(binding["source_revision"], revision)

    def test_resource_keeps_literal_committed_export_subst_bytes(self):
        revision, config = self.resource_fixture(attributes="assets/version.txt export-subst\n")
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            runtime_resource.prepare(destination, config, revision)
        self.assertEqual((destination / "assets/version.txt").read_bytes(), b"$Format:%H$\n")

    def test_resource_rejects_windows_drive_and_stream_paths_before_writes(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
        marker = (destination / runtime_resource.MARKER).read_bytes()
        blob = self.git("rev-parse", f"{revision}:app.py")
        leaf = self.git("mktree", input=f"100644 blob {blob}\tescape.txt\n")
        cases = {
            "drive-relative": (f"100644 blob {blob}\tC:escape.txt\n", "C:escape.txt"),
            "drive-absolute": (f"040000 tree {leaf}\tC:\n", "C:"),
            "alternate-stream": (f"100644 blob {blob}\tapp.py:stream\n", "app.py:stream"),
        }
        for name, (entry, include) in cases.items():
            with self.subTest(name=name):
                tree = self.git("mktree", input=entry)
                unsafe_revision = self.git("commit-tree", tree, "-m", "Synthetic Windows path")
                config.write_text(json.dumps({"version": 1, "include": [include]}))
                with patch.object(runtime_resource, "delivery", return_value=(self.root, unsafe_revision)):
                    with self.assertRaisesRegex(ValueError, "escaping include"):
                        runtime_resource.prepare(destination, config, unsafe_revision)
                with self.assertRaisesRegex(ValueError, "escaping committed source"):
                    runtime_resource.committed_files(self.root, unsafe_revision, [include])
                self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
                self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
                self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

        # A safe include can contain a Windows alternate stream deeper in its tree.
        assets = self.git("mktree", input=f"100644 blob {blob}\tfile:stream\n")
        tree = self.git("mktree", input=f"040000 tree {assets}\tassets\n")
        unsafe_revision = self.git("commit-tree", tree, "-m", "Synthetic nested stream")
        config.write_text(json.dumps({"version": 1, "include": ["assets"]}))
        with patch.object(runtime_resource, "delivery", return_value=(self.root, unsafe_revision)):
            with self.assertRaisesRegex(ValueError, "escaping committed source"):
                runtime_resource.prepare(destination, config, unsafe_revision)
        self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
        self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
        self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_resource_preserves_duplicate_blobs_and_literal_binary_paths(self):
        _, config = self.resource_fixture()
        relative = "assets/copy with\ttab\nand newline.py"
        (self.root / relative).write_bytes((self.root / "app.py").read_bytes())
        self.git("add", "assets")
        self.git("commit", "-qm", "Synthetic duplicate blob")
        revision = self.git("rev-parse", "HEAD")
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            runtime_resource.prepare(destination, config, revision)
        self.assertEqual((destination / relative).read_bytes(), (destination / "app.py").read_bytes())
        self.assertEqual((destination / "assets/selected.txt").read_bytes(), b"selected committed bytes\x00\xff\n")
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((destination / relative).stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((destination / "app.py").stat().st_mode), 0o755)

    def test_resource_preserves_distinct_git_names_or_refuses_filesystem_aliases(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
        marker = (destination / runtime_resource.MARKER).read_bytes()
        first = self.git("rev-parse", f"{revision}:app.py")
        second = self.git("rev-parse", f"{revision}:assets/selected.txt")
        tree = self.git("mktree", input=f"100644 blob {first}\tCASE.py\n100644 blob {second}\tcase.py\n")
        alias_revision = self.git("commit-tree", tree, "-m", "Synthetic distinct Git names")
        config.write_text(json.dumps({"version": 1, "include": ["CASE.py", "case.py"]}))
        probe = self.root.parent / "CASE-PROBE"
        probe.touch()
        aliases = (self.root.parent / "case-probe").exists()
        probe.unlink()
        with patch.object(runtime_resource, "delivery", return_value=(self.root, alias_revision)):
            if aliases:
                with self.assertRaisesRegex(ValueError, "materialized.*paths"):
                    runtime_resource.prepare(destination, config, alias_revision)
                self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
                self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
            else:
                runtime_resource.prepare(destination, config, alias_revision)
                self.assertEqual((destination / "CASE.py").read_bytes(), (self.root / "app.py").read_bytes())
                self.assertEqual((destination / "case.py").read_bytes(), (self.root / "assets/selected.txt").read_bytes())
        self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_invalid_blob_batch_cannot_replace_previous_owned_resource(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        read = runtime_resource.checked_bytes
        def changed_payload(output):
            start = output.index(b"\n") + 1
            return output[:start] + bytes([output[start] ^ 1]) + output[start + 1:]
        corruptions = {
            "missing": lambda output: output.split(b" ", 1)[0] + b" missing\n",
            "truncated": lambda output: output[:-2],
            "extra": lambda output: output + b"unexpected",
            "wrong type": lambda output: output.replace(b" blob ", b" tree ", 1),
            "negative size": lambda output: output.replace(b" blob ", b" blob -", 1),
            "wrong identity": lambda output: b"x" + output[1:],
            "changed bytes": changed_payload,
        }
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
            marker = (destination / runtime_resource.MARKER).read_bytes()
            for name, corrupt in corruptions.items():
                with self.subTest(response=name):
                    def altered(argv, cwd, **kwargs):
                        output = read(argv, cwd, **kwargs)
                        return corrupt(output) if argv[1:3] == ["cat-file", "--batch"] else output
                    with patch.object(runtime_resource, "checked_bytes", side_effect=altered):
                        with self.assertRaisesRegex(ValueError, "committed blob"):
                            runtime_resource.prepare(destination, config, revision)
                    self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
                    self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
                    self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_materialization_changes_cannot_replace_previous_owned_resource(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        materialize = runtime_resource.materialize_blobs
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
            marker = (destination / runtime_resource.MARKER).read_bytes()
            for change in ("bytes", "missing", "extra", "directory"):
                with self.subTest(change=change):
                    def changed_materialize(repository, files, staging):
                        materialize(repository, files, staging)
                        target = staging / "assets/selected.txt"
                        if change == "bytes":
                            target.write_bytes(b"not the selected committed blob")
                        elif change == "missing":
                            target.unlink()
                        elif change == "extra":
                            (staging / "unexpected.txt").write_bytes(b"extra")
                        else:
                            (staging / "unexpected-directory").mkdir()
                    with patch.object(runtime_resource, "materialize_blobs", side_effect=changed_materialize):
                        with self.assertRaisesRegex(ValueError, "materialized source"):
                            runtime_resource.prepare(destination, config, revision)
                    self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
                    self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
                    self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def replacement_fixture(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            runtime_resource.prepare(destination, config, revision)
        original = {path.relative_to(destination): path.read_bytes()
                    for path in destination.rglob("*") if path.is_file()}
        inode = destination.stat().st_ino
        (self.root / "app.py").write_text("print('replacement candidate')\n")
        self.git("add", "app.py")
        self.git("commit", "-qm", "Synthetic replacement generation")
        return destination, config, self.git("rev-parse", "HEAD"), original, inode

    def assert_previous_resource(self, destination, original, inode):
        self.assertTrue(destination.is_dir(), "previous owned directory must survive")
        self.assertEqual(destination.stat().st_ino, inode)
        self.assertEqual({path.relative_to(destination): path.read_bytes()
                          for path in destination.rglob("*") if path.is_file()}, original)
        self.assertTrue(runtime_resource.owned_destination(destination))

    def test_failed_resource_install_restores_exact_previous_directory(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        replace = Path.replace
        for failure in (OSError("synthetic install failure"), KeyboardInterrupt("synthetic cancellation")):
            with self.subTest(failure=type(failure).__name__):
                def fail_install(path, target):
                    if path.parent == destination.parent and path.name.startswith(".factory-resource-"):
                        raise failure
                    return replace(path, target)
                with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                        patch.object(Path, "replace", fail_install):
                    with self.assertRaises(type(failure)) as raised:
                        runtime_resource.prepare(destination, config, revision)
                self.assertIs(raised.exception, failure)
                self.assert_previous_resource(destination, original, inode)
                self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_failed_resource_rollback_retains_recoverable_previous_directory(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        replace = Path.replace
        install_error = OSError("synthetic install failure")
        rollback_error = PermissionError("synthetic rollback failure")
        def fail_install_and_restore(path, target):
            if path.name == "previous":
                raise rollback_error
            if path.parent == destination.parent and path.name.startswith(".factory-resource-"):
                raise install_error
            return replace(path, target)
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                patch.object(Path, "replace", fail_install_and_restore):
            with self.assertRaises(OSError) as raised:
                runtime_resource.prepare(destination, config, revision)
        self.assertIs(raised.exception, install_error)
        self.assertIs(raised.exception.__cause__, rollback_error)
        backups = list(destination.parent.glob(".factory-resource-backup-*"))
        self.assertEqual(len(backups), 1)
        previous = backups[0] / "previous"
        self.assertFalse(destination.exists())
        self.assertEqual(previous.stat().st_ino, inode)
        self.assertEqual({path.relative_to(previous): path.read_bytes()
                          for path in previous.rglob("*") if path.is_file()}, original)
        self.assertFalse(runtime_resource.owned_destination(previous), "backup is not an active binding")
        self.assertIn(str(previous), "\n".join(raised.exception.__notes__))
        self.assertEqual(list(destination.parent.glob(".factory-resource-*")), backups)
        output = io.StringIO()
        with patch.object(runtime_resource, "prepare", side_effect=raised.exception), redirect_stderr(output):
            result = runtime_resource.main(["prepare", "--destination", str(destination),
                                            "--config", str(config)])
        self.assertEqual(result, 1)
        self.assertIn(str(previous), output.getvalue())
        self.assertNotIn("synthetic rollback failure", output.getvalue())
        previous.replace(destination)
        backups[0].rmdir()
        self.assert_previous_resource(destination, original, inode)

    def test_resource_backup_move_failure_or_interrupt_preserves_previous(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        replace = Path.replace
        for after_move in (False, True):
            with self.subTest(after_move=after_move):
                failure = KeyboardInterrupt("synthetic interruption") if after_move else OSError("synthetic backup failure")
                def fail_backup(path, target):
                    if path == destination:
                        if after_move:
                            replace(path, target)
                        raise failure
                    return replace(path, target)
                with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                        patch.object(Path, "replace", fail_backup):
                    with self.assertRaises(type(failure)) as raised:
                        runtime_resource.prepare(destination, config, revision)
                self.assertIs(raised.exception, failure)
                self.assert_previous_resource(destination, original, inode)
                self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_successful_resource_install_keeps_previous_until_new_generation_installed(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        replace = Path.replace
        checked_previous = []
        def inspect_install(path, target):
            if path.parent == destination.parent and path.name.startswith(".factory-resource-"):
                backups = list(destination.parent.glob(".factory-resource-backup-*"))
                self.assertEqual(len(backups), 1)
                previous = backups[0] / "previous"
                self.assertEqual(previous.stat().st_ino, inode)
                self.assertEqual({p.relative_to(previous): p.read_bytes()
                                  for p in previous.rglob("*") if p.is_file()}, original)
                self.assertFalse(destination.exists())
                checked_previous.append(previous)
            return replace(path, target)
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                patch.object(Path, "replace", inspect_install):
            binding = runtime_resource.prepare(destination, config, revision)
        self.assertEqual(len(checked_previous), 1)
        self.assertEqual(binding["source_revision"], revision)
        self.assertEqual((destination / "app.py").read_bytes(), (self.root / "app.py").read_bytes())
        self.assertTrue(runtime_resource.owned_destination(destination))
        self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_interruption_after_resource_install_retains_both_generations(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        replace = Path.replace
        failure = KeyboardInterrupt("synthetic post-install interruption")
        def interrupt_after_install(path, target):
            result = replace(path, target)
            if path.parent == destination.parent and path.name.startswith(".factory-resource-"):
                raise failure
            return result
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                patch.object(Path, "replace", interrupt_after_install):
            with self.assertRaises(KeyboardInterrupt) as raised:
                runtime_resource.prepare(destination, config, revision)
        self.assertIs(raised.exception, failure)
        self.assertEqual((destination / "app.py").read_bytes(), (self.root / "app.py").read_bytes())
        self.assertTrue(runtime_resource.owned_destination(destination))
        backups = list(destination.parent.glob(".factory-resource-backup-*"))
        self.assertEqual(len(backups), 1)
        previous = backups[0] / "previous"
        self.assertEqual(previous.stat().st_ino, inode)
        self.assertEqual({p.relative_to(previous): p.read_bytes()
                          for p in previous.rglob("*") if p.is_file()}, original)
        self.assertIn(str(previous), "\n".join(raised.exception.__notes__))

    def test_failed_backup_cleanup_does_not_rollback_installed_resource(self):
        destination, config, revision, original, inode = self.replacement_fixture()
        remove = runtime_resource.remove_tree
        failure = PermissionError("synthetic backup cleanup failure")
        def fail_backup_cleanup(path):
            if path.name.startswith(".factory-resource-backup-"):
                raise failure
            return remove(path)
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)), \
                patch.object(runtime_resource, "remove_tree", fail_backup_cleanup):
            with self.assertRaises(PermissionError) as raised:
                runtime_resource.prepare(destination, config, revision)
        self.assertIs(raised.exception, failure)
        self.assertTrue(runtime_resource.owned_destination(destination))
        self.assertEqual((destination / "app.py").read_bytes(), (self.root / "app.py").read_bytes())
        marker = json.loads((destination / runtime_resource.MARKER).read_text())
        self.assertEqual(marker["source_revision"], revision)
        backups = list(destination.parent.glob(".factory-resource-backup-*"))
        self.assertEqual(len(backups), 1)
        previous = backups[0] / "previous"
        self.assertEqual(previous.stat().st_ino, inode)
        self.assertEqual({p.relative_to(previous): p.read_bytes()
                          for p in previous.rglob("*") if p.is_file()}, original)
        self.assertIn("New resource is installed", "\n".join(raised.exception.__notes__))

    def test_preparation_rejects_dangling_destination_and_ancestor_links(self):
        revision, config = self.resource_fixture()
        for ancestor in (False, True):
            with self.subTest(ancestor=ancestor):
                outside = self.root.parent / f"outside-{ancestor}"
                link = self.root.parent / f"linked-{ancestor}"
                link.symlink_to(outside, target_is_directory=True)
                destination = link / "prepared" if ancestor else link
                with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
                    with self.assertRaisesRegex(ValueError, "linked destination"):
                        runtime_resource.prepare(destination, config, revision)
                self.assertTrue(link.is_symlink())
                self.assertFalse(outside.exists(), "refusal must not write through the dangling link")

    def test_unavailable_committed_blob_preserves_previous_owned_resource(self):
        revision, config = self.resource_fixture()
        destination = self.root.parent / "prepared"
        with patch.object(runtime_resource, "delivery", return_value=(self.root, revision)):
            binding = runtime_resource.prepare(destination, config, revision)
            marker = (destination / runtime_resource.MARKER).read_bytes()
            blob = self.git("rev-parse", f"{revision}:assets/selected.txt")
            (self.root / ".git/objects" / blob[:2] / blob[2:]).unlink()
            with self.assertRaises(ValueError):
                runtime_resource.prepare(destination, config, revision)
        self.assertEqual((destination / runtime_resource.MARKER).read_bytes(), marker)
        self.assertEqual(runtime_resource.resource_digest(destination), binding["resource_digest"])
        self.assertEqual(list(destination.parent.glob(".factory-resource-*")), [])

    def test_snapshot_still_rejects_links_and_private_directories(self):
        (self.root / "empty").mkdir()
        outside = self.root.parent / "outside"
        outside.mkdir()
        manager = self.manager()
        for name, symlink in (("linked", True), (".env", False)):
            with self.subTest(name=name):
                invalid = self.root / "empty" / name
                if symlink:
                    invalid.symlink_to(outside, target_is_directory=True)
                else:
                    invalid.mkdir()
                try:
                    with patch.object(runtime_host, "ProcessTree", side_effect=AssertionError("unsafe source spawned")):
                        with self.assertRaises(ValueError):
                            manager.start({"slot": "test", "root": "candidate"})
                    self.assertEqual(manager.active, {})
                finally:
                    invalid.unlink() if symlink else invalid.rmdir()

    def test_snapshot_still_rejects_source_change_during_copy(self):
        (self.root / "empty").mkdir()
        manager = self.manager()
        copy = runtime_host.shutil.copy2
        def changed_copy(source, target):
            result = copy(source, target)
            source.write_text("changed during copy\n")
            return result
        with patch.object(runtime_host.shutil, "copy2", side_effect=changed_copy), \
                patch.object(runtime_host, "ProcessTree", side_effect=AssertionError("changed source spawned")):
            with self.assertRaisesRegex(ValueError, "source changed during snapshot"):
                manager.start({"slot": "test", "root": "candidate"})
        self.assertEqual(manager.active, {})


if __name__ == "__main__":
    unittest.main()
