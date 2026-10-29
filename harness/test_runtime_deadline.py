"""Bounded startup and best-effort owned cleanup, using synthetic fixtures only."""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http.client import HTTPResponse
import io
import json
import os
from pathlib import Path
import socket
from socketserver import BaseRequestHandler, TCPServer
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

    @contextmanager
    def accepted_request(self, prefix, *, trickle):
        """Real accepted socket and live owned process, with a disposable parent pipe."""
        manager = runtime_host.Environments(self.manager.config, threading.Event())
        directory = manager.base / "existing"
        directory.mkdir()
        item = {"directory": directory, "processes": []}
        manager.active["existing"] = item
        ready, accepted, sender_stop = (threading.Event() for _ in range(3))
        state, failures, parent_threads = {}, [], []
        thread_type = threading.Thread
        read_fd, write_fd = os.pipe()
        parent_reader = os.fdopen(read_fd, "rb", buffering=0)
        parent_writer = os.fdopen(write_fd, "wb", buffering=0)
        fixture_sys = SimpleNamespace(stdin=parent_reader, stderr=sys.stderr,
                                      executable=sys.executable)

        class Server(runtime_host.HTTPServer):
            def server_bind(server):
                # Fixed loopback fixture: no DNS-dependent getfqdn in HTTPServer.
                TCPServer.server_bind(server)
                server.server_name, server.server_port = "127.0.0.1", server.server_address[1]

            def get_request(server):
                connection = super().get_request()
                accepted.set()
                return connection

        def server_factory(*args):
            server = Server(*args)
            state["address"] = server.server_address
            ready.set()
            return server

        def manager_factory(config, stopping):
            manager.stopping = stopping
            return manager

        def parent_thread(*args, **kwargs):
            thread = thread_type(*args, **kwargs)
            parent_threads.append(thread)
            return thread

        def serve():
            try:
                runtime_host.serve({})
            except BaseException as error:
                failures.append(error)

        worker = thread_type(target=serve)
        client, sender = None, None
        try:
            marker = directory / "child-ready"
            owner = runtime_process.ProcessTree([sys.executable, "-c",
                "from pathlib import Path; import sys,time; "
                "Path(sys.argv[1]).write_text('ready'); time.sleep(60)", str(marker)],
                self.root, {}, on_owner_created=item["processes"].append)
            # This fixture represents an existing application, not a worker
            # racing to fork its first child when parent cancellation arrives.
            deadline = time.monotonic() + 5
            while not marker.exists() or marker.read_text() != "ready":
                self.assertLess(time.monotonic(), deadline, "owned child did not become ready")
                time.sleep(.01)
            with patch.object(runtime_host, "Environments", side_effect=manager_factory), \
                    patch.object(runtime_host, "HTTPServer", side_effect=server_factory), \
                    patch.object(runtime_host, "sys", fixture_sys), \
                    patch.object(runtime_host.threading, "Thread", side_effect=parent_thread), \
                    patch.object(runtime_host.secrets, "token_urlsafe", return_value="fixture"), \
                    patch.object(runtime_host.signal, "signal"), redirect_stdout(io.StringIO()):
                worker.start()
                self.assertTrue(ready.wait(5), "owner did not begin listening")
                client = socket.create_connection(state["address"], timeout=5)
                client.sendall(prefix)
                self.assertTrue(accepted.wait(5), "fixture connection was not accepted")

                def send_trickle():
                    while not sender_stop.wait(.02):
                        try:
                            client.sendall(b"x")
                        except OSError:
                            return

                if trickle:
                    sender = thread_type(target=send_trickle)
                    sender.start()
                yield client, parent_writer.close, worker, owner, manager, failures
                parent_writer.close()
                worker.join(5)
        finally:
            parent_writer.close()
            sender_stop.set()
            if client:
                client.close()  # also unblocks the old implementation on test failure
            if sender:
                sender.join(5)
                self.assertFalse(sender.is_alive(), "trickle fixture did not stop")
            try:
                if worker.ident is not None:
                    worker.join(5)
                for thread in parent_threads:
                    thread.join(5)
                    self.assertFalse(thread.is_alive(), "parent-pipe fixture did not stop")
                self.assertFalse(worker.is_alive(), "runtime request remained blocked")
            finally:
                parent_reader.close()
                manager.close()

    def test_inbound_request_line_and_headers_have_total_deadline(self):
        for prefix in (b"POST ", b"POST /identity HTTP/1.1\r\nX-Slow: "):
            with self.subTest(prefix=prefix), self.accepted_request(prefix, trickle=True) as fixture:
                client, close_parent, worker, owner, manager, failures = fixture
                client.settimeout(4)
                # Continuing bytes must not refresh the request's total read budget.
                try:
                    closed = client.recv(1) == b""
                except ConnectionResetError:
                    closed = True
                except TimeoutError:
                    closed = False
                self.assertTrue(closed, "trickled input exceeded the request deadline")
                close_parent()
                worker.join(5)
                self.assertFalse(worker.is_alive())
                self.assertEqual(failures, [], f"server failed before owned cleanup: {failures!r}")
                self.assertTrue(owner.closed)
                self.assertEqual(manager.active, {})

    def test_complete_authenticated_inbound_request_keeps_response_contract(self):
        body = b'{"slot":"existing"}'
        request = (b"POST /teardown HTTP/1.0\r\nAuthorization: Bearer fixture\r\n"
                   b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        with self.accepted_request(request, trickle=False) as fixture:
            client, close_parent, worker, owner, manager, failures = fixture
            with HTTPResponse(client) as response:
                response.begin()
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["stopped"])
            close_parent()
            worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [], f"server failed before owned cleanup: {failures!r}")
            self.assertTrue(owner.closed)
            self.assertEqual(manager.active, {})

    def test_parent_close_cancels_idle_and_partial_inbound_requests_and_cleans_owner(self):
        for prefix in (b"", b"POST ", b"POST /identity HTTP/1.1\r\nX-Slow: "):
            with self.subTest(prefix=prefix), self.accepted_request(prefix, trickle=bool(prefix)) as fixture:
                client, close_parent, worker, owner, manager, failures = fixture
                close_parent()
                worker.join(3)
                self.assertFalse(worker.is_alive(), "accepted request prevented parent cancellation")
                self.assertEqual(failures, [], f"server failed before owned cleanup: {failures!r}")
                self.assertTrue(owner.closed)
                if os.name == "posix":
                    self.assertFalse(runtime_process.group_has_live_members(owner.proc.pid))
                self.assertEqual(manager.active, {})

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

    @unittest.skipUnless(os.name == "posix", "POSIX process-group observation fixture")
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

    @unittest.skipUnless(os.name == "posix", "POSIX setup PID/process-group fixture")
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
        def late_identity(slot, *, deadline=None):
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

    def test_trickled_http_stops_at_deadline_or_cancellation_including_final_identity(self):
        self.manager.config.update(shape="http", health_path="/health", identity_path="/identity")
        for phase, request_number in (("readiness", 1), ("final_identity", 4)):
            for part in ("headers", "body"):
                for reason in ("deadline", "cancellation"):
                    with self.subTest(phase=phase, part=part, reason=reason):
                        clock = SimpleNamespace(monotonic=Mock(return_value=100), sleep=time.sleep)
                        state = {"requests": 0, "trickle_complete": False}
                        stop_server = threading.Event()
                        owner = Mock(poll=Mock(return_value=None))
                        retain = (phase, part, reason) == ("final_identity", "body", "deadline")
                        if retain:
                            owner.close.side_effect = OSError("fixture cleanup unverified")
                        servers = []
                        stopping = self.stopping

                        class Handler(BaseRequestHandler):
                            def handle(handler):
                                handler.request.settimeout(2)
                                request = b""
                                while b"\r\n\r\n" not in request:
                                    chunk = handler.request.recv(4096)
                                    if not chunk:
                                        return
                                    request += chunk
                                state["requests"] += 1
                                body = state["candidate"] if b"GET /identity " in request else b"healthy"
                                headers = (b"Content-Length: " + str(len(body)).encode()
                                           + b"\r\nConnection: close\r\n\r\n")
                                try:
                                    if state["requests"] != request_number:
                                        handler.request.sendall(b"HTTP/1.1 200 OK\r\n" + headers + body)
                                        return
                                    if part == "headers":
                                        prefix = b"HTTP/1.1 200 OK\r\nX-Trickle: "
                                        trickle, suffix = b"x" * 20, b"\r\n" + headers + body
                                    else:
                                        prefix = b"HTTP/1.1 200 OK\r\n" + headers + body[:1]
                                        trickle, suffix = body[1:], b""
                                    handler.request.sendall(prefix)
                                    if reason == "deadline":
                                        clock.monotonic.return_value = 102
                                    else:
                                        stopping.set()
                                    for byte in trickle:
                                        if stop_server.wait(.01):
                                            return
                                        handler.request.sendall(bytes([byte]))
                                    handler.request.sendall(suffix)
                                    state["trickle_complete"] = True
                                except (BrokenPipeError, ConnectionResetError):
                                    pass

                        def spawn(argv, cwd, env, *, on_owner_created):
                            on_owner_created(owner)
                            state["candidate"] = env["FACTORY_RUNTIME_CANDIDATE"].encode()
                            server = TCPServer(("127.0.0.1", int(env["FACTORY_RUNTIME_PORT"])), Handler)
                            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
                            servers.append((server, worker))
                            worker.start()
                            return owner

                        try:
                            with patch.object(runtime_host, "ProcessTree", side_effect=spawn), \
                                    patch.object(runtime_host, "time", clock):
                                with self.assertRaises(ValueError) as caught:
                                    self.manager.start({"slot": "test", "root": "candidate"}, deadline=101)
                            self.assertFalse(state["trickle_complete"], "probe consumed the trickle after cancellation/expiry")
                            owner.close.assert_called_once()
                            if retain:
                                item = self.manager.active["test"]
                                self.assertEqual(item["processes"], [owner])
                                self.assertTrue(item["directory"].exists())
                                self.assertTrue(any("cleanup failed" in note for note in caught.exception.__notes__))
                            else:
                                self.assertEqual(self.manager.active, {})
                        finally:
                            stop_server.set()
                            for server, worker in servers:
                                server.shutdown()
                                server.server_close()
                                worker.join(5)
                                self.assertFalse(worker.is_alive(), "synthetic server did not stop")
                            self.stopping.clear()
                            owner.close.side_effect = None
                            self.manager.teardown("test")

    def test_http_probe_preserves_framing_and_refuses_redirects_wrong_identity_and_large_bodies(self):
        self.manager.config.update(health_path="/health", identity_path="/identity")
        for mode in ("length", "chunked", "close", "redirect", "wrong_identity", "oversized"):
            with self.subTest(mode=mode):
                paths = []

                class Handler(BaseRequestHandler):
                    def handle(handler):
                        handler.request.settimeout(2)
                        request = b""
                        while b"\r\n\r\n" not in request:
                            chunk = handler.request.recv(4096)
                            if not chunk:
                                return
                            request += chunk
                        path = request.split(b" ")[1]
                        paths.append(path)
                        body = b"candidate" if path == b"/identity" else b"healthy"
                        if mode == "wrong_identity" and path == b"/identity":
                            body = b"other"
                        if mode == "oversized":
                            body = b"x" * 65537
                        if mode == "redirect":
                            response = (b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/other\r\n"
                                        b"Content-Length: 0\r\nConnection: close\r\n\r\n")
                        elif mode == "chunked":
                            chunks = [body[:2], body[2:]]
                            response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                            response += b"".join(format(len(chunk), "x").encode() + b"\r\n" + chunk + b"\r\n"
                                                 for chunk in chunks) + b"0\r\nX-Trailer: yes\r\n\r\n"
                        elif mode == "close":
                            response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + body
                        else:
                            response = (b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode()
                                        + b"\r\nConnection: close\r\n\r\n" + body)
                        handler.request.sendall(response)

                with TCPServer(("127.0.0.1", 0), Handler) as server:
                    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
                    worker.start()
                    item = {"proc": Mock(poll=Mock(return_value=None)), "candidate": "candidate",
                            "target": f"http://127.0.0.1:{server.server_address[1]}"}
                    try:
                        if mode in ("redirect", "wrong_identity", "oversized"):
                            with self.assertRaises(ValueError):
                                self.manager.probe(item)
                        else:
                            self.manager.probe(item)
                        self.assertEqual(paths, [b"/health"] if mode in ("redirect", "oversized")
                                         else [b"/health", b"/identity"])
                    finally:
                        server.shutdown()
                        worker.join(5)
                        self.assertFalse(worker.is_alive(), "synthetic server did not stop")


if __name__ == "__main__":
    unittest.main()
