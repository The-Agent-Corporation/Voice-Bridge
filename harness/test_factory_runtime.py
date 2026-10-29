"""Offline regressions for runtime preparation, identity, and HTTP ownership."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "factory"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import consumer
import runtime_host
from appproc import HttpApp, AppDidNotStart


class PreparationTests(unittest.TestCase):
    def test_malformed_helper_invocation_aborts_before_dispatch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            helper = root / "helper.py"
            helper.write_text("# fake helper, never executed\n")
            config = root / "trigger.json"
            config.write_text(json.dumps({"binding": {
                "capacity": 1, "overlap": "skip", "launch": {
                    "workflowName": "archon-lifecycle", "cwd": str(root),
                    "inputs": {}, "isolation": "worktree"}}}))
            for index, prepared in enumerate(({"invocation": 123}, {"invocation": None}, [], None)):
                invocations = root / f"invocations-{index}"
                with self.subTest(prepared=prepared), patch.object(consumer, "checked", return_value=json.dumps(prepared)):
                    with self.assertRaises(ValueError):
                        consumer.dispatch_bound_trigger(root, {"revision": "a" * 40}, root, config,
                            {"invocation_root": str(invocations), "helper": str(helper)}, lambda _: None)
                    self.assertEqual(json.loads((invocations / "dispatch.json").read_text())["status"],
                                     "aborted_before_dispatch")

    def test_setup_dependencies_are_excluded_but_selected_source_remains_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "app.py").write_text("print('ok')\n")
            setup = ("from pathlib import Path; p=Path('node_modules/.bin'); p.mkdir(parents=True); "
                     "Path('node_modules/tool').write_text('dependency'); (p/'tool').symlink_to('../tool')")
            manager = runtime_host.Environments({"version": 1, "roots": {"candidate": str(root)},
                "shape": "cli", "include": ["app.py"], "timeout_s": 5,
                "setup": [sys.executable, "-c", setup], "command": [sys.executable, "app.py"]}, threading.Event())
            try:
                result = manager.start({"slot": "test", "root": "candidate"})
                self.assertEqual(result["exit_code"], 0)
                self.assertEqual(manager.identity("test")["candidate"], result["candidate"])
                source = Path(result["snapshot"]) / "app.py"
                source.chmod(0o600)
                source.write_text("print('changed')\n")
                with self.assertRaisesRegex(ValueError, "changed candidate"):
                    manager.identity("test")
            finally:
                manager.close()

    def test_start_transport_waits_for_both_server_phase_budgets(self):
        def open_response(request, timeout):
            if timeout <= 600:
                raise TimeoutError("setup and readiness each require their 300 second budget")
            return io.BytesIO(b'{"started": true}')
        with patch.object(runtime_host.HTTP, "open", side_effect=open_response):
            self.assertEqual(runtime_host.request("start", {}, {"url": "http://127.0.0.1:12345", "token": "fixture"}),
                             {"started": True})


class HttpOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def script(self, body):
        path = Path(self.directory.name) / "app.py"
        path.write_text(body)
        return f'"{sys.executable}" "{path}" {{port}}'

    def cleanup_process(self, proc):
        if proc and proc.poll() is None:
            proc.kill()
        if proc:
            proc.wait(timeout=5)
            if proc.stdout:
                proc.stdout.close()

    def test_chatty_app_starts_without_stdout_backpressure(self):
        command = self.script("import sys\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n"
            "sys.stdout.write('x' * 1_000_000); sys.stdout.flush()\n"
            "class Handler(BaseHTTPRequestHandler):\n"
            " def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'ok')\n"
            "HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()\n")
        app = HttpApp({"http": {"start": command, "boot_timeout_s": 2}})
        try:
            with app:
                self.assertEqual(app.get("/health")[0], 200)
        finally:
            self.cleanup_process(app.proc)

    def test_startup_failure_reaps_the_owned_process(self):
        app = HttpApp({"http": {"start": self.script("import time; time.sleep(60)\n"), "boot_timeout_s": 0}})
        try:
            with self.assertRaises(AppDidNotStart):
                app.__enter__()
            self.assertIsNotNone(app.proc.poll())
        finally:
            self.cleanup_process(app.proc)

    def test_cleanup_never_signals_a_reaped_process_group(self):
        app = HttpApp({"http": {"start": self.script("import time; time.sleep(60)\n"), "boot_timeout_s": 0}})
        late_signals = []
        killpg = os.killpg

        def signal_reserved_group(pid, signum):
            if signum and app.proc.returncode is not None:
                late_signals.append(signum)
                raise AssertionError("process-group identity was already released")
            return killpg(pid, signum)

        try:
            with patch('appproc.os.killpg', side_effect=signal_reserved_group):
                with self.assertRaises(AppDidNotStart):
                    app.__enter__()
            self.assertEqual(late_signals, [])
        finally:
            self.cleanup_process(app.proc)

    def test_early_exit_remains_reserved_until_cleanup(self):
        app = HttpApp({"http": {"start": self.script("raise SystemExit(7)\n"), "boot_timeout_s": 5}})
        late_signals = []
        killpg = os.killpg

        def signal_reserved_group(pid, signum):
            if signum and app.proc.returncode is not None:
                late_signals.append(signum)
                raise AssertionError("health polling reaped the process-group owner")
            return killpg(pid, signum)

        try:
            with patch('appproc.os.killpg', side_effect=signal_reserved_group):
                with self.assertRaisesRegex(AppDidNotStart, 'exited with 7'):
                    app.__enter__()
            self.assertEqual(late_signals, [])
        finally:
            self.cleanup_process(app.proc)

    def test_reaped_owner_refuses_further_group_signals(self):
        app = HttpApp({"http": {}})
        app.proc = subprocess.Popen([sys.executable, '-c', 'pass'], start_new_session=True)
        app.proc.wait(timeout=5)
        with patch('appproc.os.killpg', side_effect=AssertionError('unreserved group signaled')):
            with self.assertRaisesRegex(RuntimeError, 'reaped'):
                app.__exit__()

    def test_missing_waitid_refuses_before_spawning(self):
        app = HttpApp({"http": {"start": self.script('pass\n')}})
        with patch('appproc.os.waitid', None), \
                patch('appproc.subprocess.Popen', side_effect=AssertionError('unsupported host spawned')):
            with self.assertRaisesRegex(AppDidNotStart, 'waitid'):
                app.__enter__()

    def test_cleanup_failure_preserves_the_startup_error(self):
        app = HttpApp({"http": {"start": self.script("import time; time.sleep(60)\n"), "boot_timeout_s": 0}})
        try:
            with patch.object(app, '__exit__', side_effect=OSError('synthetic cleanup failure')):
                with self.assertRaises(AppDidNotStart) as failure:
                    app.__enter__()
            self.assertTrue(any('cleanup' in note for note in failure.exception.__notes__))
        finally:
            self.cleanup_process(app.proc)
            if app._output:
                app._output.close()

    def test_teardown_stops_owned_listener_descendants(self):
        command = self.script("import subprocess,sys\n"
            "child=subprocess.Popen([sys.executable, '-m', 'http.server', sys.argv[1], '--bind', '127.0.0.1'])\n"
            "child.wait()\n")
        app = HttpApp({"http": {"start": command, "health_path": "/", "boot_timeout_s": 5}})
        try:
            with app:
                self.assertEqual(app.get("/")[0], 200)
            app.__exit__()  # Cleanup is idempotent after the owned session exits.
            with self.assertRaises(OSError):
                app.get("/")
        finally:
            self.cleanup_process(app.proc)

    def test_teardown_preserves_unowned_listener_on_same_port(self):
        app = HttpApp({"http": {}})
        listener = subprocess.Popen([sys.executable, "-u", "-c",
            "import socket,sys,time; s=socket.socket(); s.bind(('127.0.0.1',int(sys.argv[1]))); "
            "s.listen(); print('ready',flush=True); time.sleep(60)", str(app.port)], stdout=subprocess.PIPE)
        try:
            self.assertEqual(listener.stdout.readline().strip(), b"ready")
            app.__exit__()
            time.sleep(0.1)
            self.assertIsNone(listener.poll(), "teardown killed a process it did not start")
        finally:
            self.cleanup_process(listener)


if __name__ == "__main__":
    unittest.main()
