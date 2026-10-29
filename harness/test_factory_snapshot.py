"""Synthetic directory-preservation and source-identity regressions."""
import json
from pathlib import Path
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
        # record empty working directories. Exercise the actual archive preparer.
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
