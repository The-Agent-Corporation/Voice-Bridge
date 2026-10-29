"""Bounded startup and best-effort owned cleanup, using synthetic fixtures only."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "factory"))
import runtime_host
import runtime_process


class RuntimeDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "app.py").write_text("pass\n")
        self.stopping = threading.Event()
        self.manager = runtime_host.Environments({"version": 1,
            "roots": {"candidate": str(self.root)}, "shape": "cli", "include": ["app.py"],
            "timeout_s": 5, "command": [sys.executable, "app.py"]}, self.stopping)
        self.addCleanup(self.manager.close)

    def slot(self, name, processes):
        directory = self.manager.base / name
        directory.mkdir()
        self.manager.active[name] = {"directory": directory, "processes": processes}
        return directory

    def handler(self, path, data, *, manager=None, deadline=None, broken=False):
        manager = manager or self.manager
        stopping = threading.Event()
        body = json.dumps(data).encode()
        observed = {}

        class Server:
            server_port = 12345

            def __init__(self, address, handler):
                self.handler_type = handler

            def handle_request(self):
                handler = self.handler_type.__new__(self.handler_type)
                handler.path = path
                handler.connection = Mock()
                handler.headers = {"Authorization": "Bearer fixture", "Content-Length": str(len(body))}
                if deadline is not None:
                    handler.headers["X-Factory-Deadline"] = str(deadline)
                handler.rfile = io.BytesIO(body)
                handler.wfile = Mock(write=Mock(side_effect=BrokenPipeError)) if broken else io.BytesIO()
                handler.send_response = lambda status: observed.update(status=status)
                handler.send_header = Mock()
                handler.end_headers = Mock()
                try:
                    handler.do_POST()
                    if not broken:
                        observed["body"] = json.loads(handler.wfile.getvalue())
                finally:
                    stopping.set()

            def server_close(self):
                pass

        with patch.object(runtime_host, "Environments", return_value=manager), \
                patch.object(runtime_host, "HTTPServer", Server), \
                patch.object(runtime_host.threading, "Event", return_value=stopping), \
                patch.object(runtime_host.threading, "Thread"), \
                patch.object(runtime_host.signal, "signal"), \
                patch.object(runtime_host.secrets, "token_urlsafe", return_value="fixture"), \
                patch.object(manager, "close"), redirect_stdout(io.StringIO()):
            runtime_host.serve({})
        return observed

    def test_teardown_attempts_each_process_and_retains_failed_slot_for_retry(self):
        good = Mock()
        flaky = Mock(close=Mock(side_effect=[OSError("fixture cleanup refusal"), None]))
        directory = self.slot("test", [good, flaky])
        with self.assertRaises(Exception):
            self.manager.teardown("test")
        good.close.assert_called_once()
        self.assertIn("test", self.manager.active)
        self.assertTrue(directory.exists())
        self.assertTrue(self.manager.teardown("test")["stopped"])
        self.assertNotIn("test", self.manager.active)
        self.assertFalse(directory.exists())

    def test_close_attempts_each_slot_and_retains_failed_slot_for_retry(self):
        flaky = Mock(close=Mock(side_effect=[OSError("fixture cleanup refusal"), None]))
        self.slot("first", [flaky])
        good = Mock()
        directory = self.slot("second", [good])
        with self.assertRaises(Exception):
            self.manager.close()
        good.close.assert_called_once()
        self.assertEqual(list(self.manager.active), ["first"])
        self.assertFalse(directory.exists())
        self.assertTrue(self.manager.base.exists())
        self.manager.close()
        self.assertFalse(self.manager.base.exists())

    def test_handler_reports_incomplete_cleanup_and_still_attempts_other_slots(self):
        flaky = Mock(close=Mock(side_effect=[OSError("private diagnostic withheld"), None]))
        self.slot("first", [flaky])
        good = Mock()
        self.slot("second", [good])
        result = self.handler("/unknown", {})
        self.assertEqual(result["status"], 500)
        self.assertIn("cleanup incomplete", result["body"]["error"])
        self.assertNotIn("private diagnostic", result["body"]["error"])
        good.close.assert_called_once()
        self.assertEqual(list(self.manager.active), ["first"])

    def test_failed_start_response_delivery_tears_down_only_started_slot(self):
        started = Mock()
        other = Mock()
        self.slot("test", [started])
        self.slot("other", [other])
        with patch.object(self.manager, "start", return_value={"version": 1, "slot": "test"}):
            self.handler("/start", {"slot": "test", "root": "candidate"}, broken=True)
        started.close.assert_called_once()
        other.close.assert_not_called()
        self.assertEqual(list(self.manager.active), ["other"])

    def test_failed_delivery_keeps_failed_cleanup_available_for_retry(self):
        flaky = Mock(close=Mock(side_effect=[OSError("private diagnostic"), None]))
        self.slot("test", [flaky])
        diagnostic = io.StringIO()
        with patch.object(self.manager, "start", return_value={"version": 1, "slot": "test"}), \
                redirect_stderr(diagnostic):
            self.handler("/start", {"slot": "test", "root": "candidate"}, broken=True)
        self.assertEqual(list(self.manager.active), ["test"])
        self.assertIn("cleanup incomplete", diagnostic.getvalue())
        self.assertNotIn("private diagnostic", diagnostic.getvalue())
        self.assertTrue(self.manager.teardown("test")["stopped"])

    def test_failed_process_initialization_retains_ownership_until_cleanup_is_verified(self):
        for phase in ("app", "setup"):
            with self.subTest(phase=phase):
                if phase == "setup":
                    self.manager.config["setup"] = [sys.executable, "-c", "pass"]
                failure = OSError("fixture stdin initialization failed")
                spawned = []
                popen = runtime_process.subprocess.Popen

                class FailingInput:
                    def __init__(self, stream):
                        self.stream = stream

                    @property
                    def closed(self):
                        return self.stream.closed

                    def write(self, data):
                        raise failure

                    def close(self):
                        self.stream.close()

                def spawn(*args, **kwargs):
                    process = popen(*args, **kwargs)
                    process.stdin = FailingInput(process.stdin)
                    spawned.append(process)
                    return process

                with patch.object(runtime_process.subprocess, "Popen", side_effect=spawn), \
                        patch.object(runtime_process, "group_has_live_members",
                                     side_effect=RuntimeError("fixture membership unavailable")) as observe:
                    with self.assertRaises(OSError) as caught:
                        self.manager.start({"slot": "test", "root": "candidate"})
                    self.assertIs(caught.exception, failure)
                    self.assertIn("test", self.manager.active)
                    item = self.manager.active["test"]
                    self.assertTrue(item["directory"].exists())
                    self.assertEqual(len(item["processes"]), 1)
                    owner = item["processes"][0]
                    self.assertIs(owner.proc, spawned[0])
                    self.assertEqual(len(spawned), 1, "initialization failure must stop further launches")
                    self.assertFalse(owner.closed)
                    self.assertTrue(owner._reaped_by_cleanup)
                    self.assertEqual(observe.call_count, 2, "constructor and host must both try cleanup")
                    self.assertTrue(any("Runtime process cleanup failed" in note for note in failure.__notes__))
                    self.assertTrue(any("Runtime environment cleanup failed" in note for note in failure.__notes__))
                # The real worker was reaped, but ownership must survive until
                # observation can verify cleanup. The retry then removes its slot.
                self.assertTrue(self.manager.teardown("test")["stopped"])
                self.assertTrue(owner.closed)
                self.assertFalse(item["directory"].exists())
                self.assertNotIn("test", self.manager.active)

    def test_expired_queued_start_never_spawns(self):
        with patch.object(runtime_host, "ProcessTree", side_effect=AssertionError("expired request spawned")) as spawn:
            result = self.handler("/start", {"slot": "test", "root": "candidate"},
                                  deadline=time.monotonic() - 1)
        spawn.assert_not_called()
        self.assertEqual(result["status"], 400)
        self.assertEqual(self.manager.active, {})

    def test_copy_finishing_after_deadline_never_spawns(self):
        clock = SimpleNamespace(monotonic=Mock(return_value=100), sleep=time.sleep)
        copy = runtime_host.shutil.copy2
        def slow_copy(*args, **kwargs):
            result = copy(*args, **kwargs)
            clock.monotonic.return_value = 102
            return result
        with patch.object(runtime_host, "time", clock), \
                patch.object(runtime_host.shutil, "copy2", side_effect=slow_copy) as copied, \
                patch.object(runtime_host, "ProcessTree", side_effect=AssertionError("expired copy spawned")) as spawn:
            with self.assertRaisesRegex(ValueError, "timed out"):
                self.manager.start({"slot": "test", "root": "candidate"}, deadline=101)
        copied.assert_called_once()
        spawn.assert_not_called()
        self.assertEqual(self.manager.active, {})

    def test_parent_cancellation_during_copy_never_spawns(self):
        copy = runtime_host.shutil.copy2
        def cancelled_copy(*args, **kwargs):
            result = copy(*args, **kwargs)
            self.stopping.set()
            return result
        with patch.object(runtime_host.shutil, "copy2", side_effect=cancelled_copy), \
                patch.object(runtime_host, "ProcessTree", side_effect=AssertionError("cancelled copy spawned")):
            with self.assertRaisesRegex(ValueError, "cancelled"):
                self.manager.start({"slot": "test", "root": "candidate"})
        self.assertEqual(self.manager.active, {})

    def test_shared_deadline_stops_owned_setup_before_app_launch(self):
        clock = SimpleNamespace(monotonic=Mock(return_value=100), sleep=time.sleep)
        self.manager.config["setup"] = [sys.executable, "-c", "import json,os,pathlib,time; "
            "marker=pathlib.Path(os.environ['FACTORY_RUNTIME_STATE'],'setup-started'); "
            "pending=marker.with_suffix('.tmp'); "
            "pending.write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})); "
            "pending.replace(marker); time.sleep(60)"]
        trees = []
        constructor = runtime_host.ProcessTree
        def tracked(*args, **kwargs):
            tree = constructor(*args, **kwargs)
            try:
                # The setup is a real running child. Only the host budget clock
                # is controlled; ProcessTree's cleanup clock remains real.
                marker = self.manager.active["test"]["directory"] / "state/setup-started"
                limit = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < limit:
                    time.sleep(.01)
                self.assertTrue(marker.exists(), "synthetic setup did not start")
                setup = json.loads(marker.read_text())
                self.assertNotEqual(setup["pid"], tree.proc.pid)
                self.assertEqual(setup["pgid"], tree.proc.pid)
                self.assertEqual(os.getpgid(setup["pid"]), tree.proc.pid)
                self.assertTrue(runtime_process.group_has_live_members(tree.proc.pid))
            except BaseException:
                tree.close()
                raise
            trees.append(tree)
            clock.monotonic.return_value = 102
            return tree
        with patch.object(runtime_host, "ProcessTree", side_effect=tracked), \
                patch.object(runtime_host, "time", clock), \
                patch.object(runtime_host, "START_BUDGET_S", 1):
            with self.assertRaisesRegex(ValueError, "timed out"):
                self.manager.start({"slot": "test", "root": "candidate"}, deadline=160)
        self.assertEqual(len(trees), 1, "the app must not launch after setup consumes the shared budget")
        self.assertIsNotNone(trees[0].proc.returncode)
        self.assertTrue(trees[0].closed)
        # A stopped Linux zombie may still reserve a PID. Only observe the group
        # after cleanup reaps its owner; never send a mutating signal here.
        self.assertFalse(runtime_process.group_has_live_members(trees[0].proc.pid))
        self.assertEqual(self.manager.active, {})

    def test_expiry_during_final_identity_cannot_report_success(self):
        clock = SimpleNamespace(monotonic=Mock(return_value=100), sleep=time.sleep)
        process = Mock(poll=Mock(return_value=0))
        def late_identity(slot):
            clock.monotonic.return_value = 102
            return {"version": 1, "slot": slot}
        with patch.object(runtime_host, "ProcessTree", return_value=process), \
                patch.object(runtime_host, "time", clock), \
                patch.object(self.manager, "identity", side_effect=late_identity) as identity:
            with self.assertRaisesRegex(ValueError, "timed out"):
                self.manager.start({"slot": "test", "root": "candidate"}, deadline=101)
        identity.assert_called_once()
        self.assertTrue(process.close.called)
        self.assertEqual(self.manager.active, {})

    def test_client_sends_absolute_deadline_with_cleanup_headroom(self):
        sent = []
        def response(request, timeout):
            sent.append((request, timeout))
            return io.BytesIO(b'{"version":1}')
        before = time.monotonic()
        with patch.object(runtime_host.HTTP, "open", side_effect=response):
            runtime_host.request("start", {"slot": "test"}, {"url": "http://127.0.0.1:12345", "token": "fixture"})
        request, timeout = sent[0]
        deadline = float(request.get_header("X-factory-deadline"))
        self.assertGreater(deadline, before)
        self.assertGreater(timeout, deadline - before)


if __name__ == "__main__":
    unittest.main()
