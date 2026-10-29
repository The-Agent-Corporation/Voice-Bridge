"""Authenticated ordinary project environments, owned until the parent pipe closes."""
from __future__ import annotations
import argparse
import errno
import hashlib
import hmac
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from http.client import HTTPConnection, HTTPException, HTTPResponse
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import URLError

from runtime_process import ProcessTree
from runtime_resource import FORBIDDEN, MARKER, owned_destination, resource_digest

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirect())
# One cooperative budget includes queueing, preparation and both execution
# phases. Blocking filesystem calls are checked between operations, not killed.
START_BUDGET_S = 610
START_CLEANUP_HEADROOM_S = 60


class ProbeReader(io.RawIOBase):
    """Let the standard HTTP parser read through cancellable socket operations."""
    def __init__(self, transport):
        self.transport = transport

    def readable(self):
        return True

    def readinto(self, buffer):
        return self.transport.receive(buffer)


class ProbeSocket:
    """A single-threaded socket with one absolute deadline for all I/O."""
    def __init__(self, sock, deadline, stopping):
        self.sock, self.deadline, self.stopping = sock, deadline, stopping
        sock.setblocking(False)

    def check(self):
        remaining = self.deadline - time.monotonic()
        if self.stopping.is_set() or remaining <= 0:
            raise ValueError("runtime HTTP probe cancelled or timed out")
        return remaining

    def wait(self, *, writing=False):
        while True:
            remaining = self.check()
            readable, writable, _ = select.select(
                [] if writing else [self.sock], [self.sock] if writing else [], [], min(.05, remaining))
            self.check()
            if readable or writable:
                return

    def connect(self, address):
        self.check()
        error = self.sock.connect_ex(address)
        if error not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY):
            raise OSError(error, "runtime probe connection failed")
        if error:
            self.wait(writing=True)
            error = self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error:
                raise OSError(error, "runtime probe connection failed")
        self.check()

    def sendall(self, data):
        pending = memoryview(data)
        while pending:
            self.wait(writing=True)
            try:
                sent = self.sock.send(pending)
            except BlockingIOError:
                continue
            if not sent:
                raise ConnectionError("runtime probe connection closed")
            pending = pending[sent:]
        self.check()

    def receive(self, buffer):
        while True:
            self.wait()
            try:
                count = self.sock.recv_into(buffer)
            except BlockingIOError:
                continue
            self.check()
            return count

    def makefile(self, mode):
        if mode != "rb":
            raise ValueError("runtime probe requires binary reads")
        return io.BufferedReader(ProbeReader(self))

    def close(self):
        self.sock.close()


def probe_http(target, path, deadline, stopping):
    """Read one bounded loopback response, retaining standard HTTP framing."""
    address = urlsplit(target)
    if (address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port
            or address.username or address.password or address.path or address.query or address.fragment):
        raise ValueError("runtime probe requires an owned loopback target")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        transport = ProbeSocket(sock, deadline, stopping)
        transport.connect(("127.0.0.1", address.port))
        connection = HTTPConnection("127.0.0.1", address.port)
        connection.sock = transport
        try:
            connection.request("GET", path, headers={"Connection": "close"})
            # Parse directly so HTTPConnection does not close a Connection:close
            # socket before this explicitly owned reader has consumed its body.
            with HTTPResponse(transport, method="GET") as response:
                response.begin()
                if response.status != 200:
                    raise ValueError("redirected or unhealthy target")
                body = response.read(65537)
                transport.check()
                if len(body) > 65536:
                    raise ValueError("runtime probe response is too large")
                return body.decode("utf-8")
        finally:
            connection.close()


def safe_path(root, relative):
    if (not isinstance(relative, str) or not relative or Path(relative).anchor
            or Path(relative).drive):
        raise ValueError("source paths must be relative")
    path = root / relative
    if any(p.lower() in FORBIDDEN or p == ".." for p in Path(relative).parts):
        raise ValueError("private or escaping source path refused")
    if not path.resolve().is_relative_to(root):
        raise ValueError("source path escapes configured root")
    cursor = path
    while cursor != root:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("source links are unsupported")
        cursor = cursor.parent
    return path


def source_files(root, includes, *, directories=None):
    files = {}
    for rel in includes:
        path = safe_path(root, rel)
        if not path.exists():
            raise ValueError("configured source missing")
        if directories is not None and path.is_dir():
            directories.add(path.relative_to(root).as_posix())
        candidates = path.rglob("*") if path.is_dir() else [path]
        for child in candidates:
            name = child.relative_to(root).as_posix()
            safe_path(root, name)
            if child.is_file():
                files[name] = child
            elif directories is not None and child.is_dir():
                directories.add(name)
    if not files:
        raise ValueError("empty source snapshot")
    return files


def digest(files):
    result = hashlib.sha256()
    for name, path in sorted(files.items()):
        content = path.read_bytes()
        result.update(name.encode() + b"\0" + str(len(content)).encode() + b"\0" + content)
    return result.hexdigest()


def tree_digest(root):
    return digest(source_files(root, [p.name for p in root.iterdir()]))


def remove_tree(root):
    def writable(function, path, exc):
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        function(path)
    deadline = time.monotonic() + 5
    while root.exists():
        try:
            shutil.rmtree(root, onerror=writable)
        except PermissionError:
            # Windows can report zero job members just before final file handles
            # are released. Bound the wait and surface a persistent cleanup error.
            if time.monotonic() >= deadline:
                raise
            time.sleep(.05)


def command(value, variables):
    if not isinstance(value, list) or not value or not all(isinstance(s, str) and s for s in value):
        raise ValueError("commands require nonempty argv arrays")
    argv = []
    for item in value:
        for key, replacement in variables.items():
            item = item.replace("{" + key + "}", replacement)
        argv.append(item)
    executable = shutil.which(argv[0]) or argv[0]
    # A narrow ordinary runtime surface. Scripts remain trusted operator code;
    # this is deliberately not a same-user sandbox or a script-content scanner.
    if not re.fullmatch(r"(?:python(?:\d+(?:\.\d+)*)?|node)(?:\.exe)?", Path(executable).name.lower()):
        raise ValueError("only ordinary Python/Node executables are supported; no shells or provider CLIs")
    argv[0] = executable
    return argv


class Environments:
    def __init__(self, config, stopping):
        if config.get("version") != 1 or not isinstance(config.get("roots"), dict):
            raise ValueError("runtime config requires version 1 and named roots")
        self.config = config
        self.roots = {}
        self.bindings = {}
        for name, raw in config["roots"].items():
            bound = isinstance(raw, dict)
            path = Path(raw.get("path", "")) if bound else Path(raw)
            if not path.is_absolute() or path.is_symlink() or (not bound and not path.is_dir()):
                raise ValueError("roots must be explicit absolute directories")
            path = path.resolve()
            if bound:
                if set(raw) != {"path", "binding"} or raw["binding"] != MARKER:
                    raise ValueError("bound roots require path and .factory-resource.json binding")
                self.bindings[name] = True
            self.roots[name] = path
        self.stopping = stopping
        self.base = Path(tempfile.mkdtemp(prefix="factory-runtime-")).resolve()
        self.active = {}
        self.used_ports = set()

    def teardown(self, slot):
        item = self.active.get(slot)
        if item:
            failures = []
            for proc in reversed(item["processes"]):
                try:
                    proc.close()
                except Exception as error:
                    failures.append(error)
            if failures:
                # Retain ownership and the directory until every process is
                # confirmed stopped; a later teardown may retry failed cleanup.
                raise ExceptionGroup("Runtime process cleanup incomplete", failures)
            remove_tree(item["directory"])
            del self.active[slot]
        return {"version": 1, "stopped": True}

    def teardown_all(self):
        failures = []
        for slot in list(self.active):
            try:
                self.teardown(slot)
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("Runtime environment cleanup incomplete", failures)

    def close(self):
        self.teardown_all()
        remove_tree(self.base)

    def check_start(self, deadline):
        if self.stopping.is_set() or time.monotonic() >= deadline:
            raise ValueError("runtime startup cancelled or timed out")

    def start(self, request, *, deadline=None):
        limit = time.monotonic() + START_BUDGET_S
        if deadline is not None and (not isinstance(deadline, (int, float)) or not math.isfinite(deadline)):
            raise ValueError("invalid startup deadline")
        deadline = min(deadline, limit) if deadline is not None else limit
        self.check_start(deadline)
        slot = request.get("slot")
        if not isinstance(slot, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", slot):
            raise ValueError("invalid slot")
        # Replacement is cleanup-first, including a malformed retry request.
        self.teardown(slot)
        self.check_start(deadline)
        if set(request) - {"slot", "root", "mutation", "expected_source", "expected_revision"}:
            raise ValueError("unknown start fields; commands and paths cannot be supplied by callers")
        root = self.roots.get(request.get("root"))
        if root is None:
            raise ValueError("unknown configured root")
        binding = None
        if self.bindings.get(request.get("root")):
            if not owned_destination(root):
                raise ValueError("bound root is not an owned runtime resource")
            binding = json.loads((root / MARKER).read_text(encoding="utf-8"))
            expected_revision = request.get("expected_revision")
            if not isinstance(expected_revision, str) or expected_revision != binding["source_revision"]:
                raise ValueError("stale expected candidate revision")
            if resource_digest(root) != binding["resource_digest"]:
                raise ValueError("prepared candidate resource changed")
            self.check_start(deadline)
        cfg = self.config
        if cfg.get("shape") not in {"http", "cli", "library"}:
            raise ValueError("supported shapes: http, cli, library")
        directories = set()
        original = source_files(root, cfg["include"], directories=directories)
        self.check_start(deadline)
        before = digest(original)
        self.check_start(deadline)
        if request.get("expected_source", before) != before:
            raise ValueError("stale requested source")
        directory = self.base / secrets.token_hex(16)
        source, state = directory / "source", directory / "state"
        source.mkdir(parents=True)
        state.mkdir()
        item = {"directory": directory, "source": source, "processes": []}
        self.active[slot] = item
        try:
            # Directory entries are part of the selected layout even when no
            # files below them contribute to the existing byte-only digest.
            for rel in sorted(directories):
                self.check_start(deadline)
                safe_path(source, rel).mkdir(parents=True, exist_ok=True)
            for rel, path in original.items():
                self.check_start(deadline)
                target = source / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                self.check_start(deadline)
            if tree_digest(source) != before or digest(source_files(root, cfg["include"])) != before:
                raise ValueError("source changed during snapshot")
            self.check_start(deadline)
            mutation = request.get("mutation")
            if mutation:
                matches = [d for d in cfg.get("mutations", []) if d.get("id") == mutation]
                if len(matches) != 1:
                    raise ValueError("unknown or ambiguous mutation")
                defect = matches[0]
                target = safe_path(source, defect["file"])
                body = target.read_bytes()
                find, replace = defect["find"].encode(), defect["replace"].encode()
                if not find or find == replace or body.count(find) != 1:
                    raise ValueError("mutation requires a unique changing anchor")
                target.write_bytes(body.replace(find, replace, 1))
                self.check_start(deadline)
            for _ in range(100):
                with socket.socket() as lease:
                    lease.bind(("127.0.0.1", 0))
                    port = lease.getsockname()[1]
                if port not in self.used_ports:
                    self.used_ports.add(port)
                    break
            else:
                raise ValueError("cannot allocate a fresh target")
            variables = {"source": str(source), "state": str(state), "port": str(port),
                         "python": sys.executable}
            env = {k: v for k, v in os.environ.items() if k.upper() in
                   {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG"}}
            env.update({"HOME": str(state), "USERPROFILE": str(state), "TMP": str(state),
                        "TEMP": str(state), "TMPDIR": str(state), "PYTHONDONTWRITEBYTECODE": "1",
                        "FACTORY_RUNTIME_STATE": str(state), "FACTORY_RUNTIME_PORT": str(port)})
            for key, value in cfg.get("env", {}).items():
                if not isinstance(value, str) or key.startswith("FACTORY_RUNTIME_"):
                    raise ValueError("invalid environment configuration")
                for var, replacement in variables.items():
                    value = value.replace("{" + var + "}", replacement)
                env[key] = value
            timeout = float(cfg.get("timeout_s", 30))
            if not 0 < timeout <= 300:
                raise ValueError("timeout_s must be between 0 and 300")
            if cfg.get("setup"):
                self.check_start(deadline)
                setup = ProcessTree(command(cfg["setup"], variables), source, env,
                                    on_owner_created=item["processes"].append)
                if self.wait_exit(setup, timeout, deadline=deadline) != 0:
                    raise ValueError("project setup failed (output withheld)")
                setup.close()
                item["processes"].remove(setup)
            self.check_start(deadline)
            selected = source_files(source, cfg["include"])
            self.check_start(deadline)
            actual = digest(selected)
            self.check_start(deadline)
            argv = command(cfg["command"], variables)
            identity = "factory-v1:" + hashlib.sha256(json.dumps(
                {"source": actual, "argv": argv, "env": env}, sort_keys=True).encode()).hexdigest()
            env["FACTORY_RUNTIME_CANDIDATE"] = identity
            for path in selected.values():
                self.check_start(deadline)
                path.chmod(stat.S_IREAD)
            self.check_start(deadline)
            proc = ProcessTree(argv, source, env,
                               on_owner_created=item["processes"].append)
            item.update(candidate=identity, digest=actual, proc=proc, shape=cfg["shape"],
                        target=f"http://127.0.0.1:{port}", original=before, binding=binding)
            if cfg["shape"] == "http":
                ready_deadline = min(deadline, time.monotonic() + timeout)
                while True:
                    self.check_start(ready_deadline)
                    if self.stopping.is_set() or proc.poll() is not None:
                        raise ValueError("app stopped before readiness")
                    try:
                        self.probe(item, deadline=ready_deadline)
                        break
                    except (URLError, OSError, ValueError, HTTPException):
                        if time.monotonic() >= ready_deadline:
                            raise ValueError("app readiness/identity refused") from None
                        self.stopping.wait(.05)
            else:
                item["exit_code"] = self.wait_exit(proc, timeout, deadline=deadline)
                proc.close()  # includes descendants of finite commands
            self.check_start(deadline)
            result = self.identity(slot, deadline=deadline)
            self.check_start(deadline)
            return result
        except BaseException as failure:
            try:
                self.teardown(slot)
            except BaseException as cleanup_error:
                failure.add_note(f"Runtime environment cleanup failed: {cleanup_error}")
            raise

    def wait_exit(self, proc, timeout, *, deadline=None):
        phase_deadline = time.monotonic() + timeout
        deadline = min(deadline, phase_deadline) if deadline is not None else phase_deadline
        while True:
            self.check_start(deadline)
            status = proc.poll()
            if status is not None:
                return status
            self.stopping.wait(.05)

    def probe(self, item, *, deadline=None):
        deadline = time.monotonic() + 1 if deadline is None else deadline
        self.check_start(deadline)
        if item["proc"].poll() is not None:
            raise ValueError("owned app is dead")
        for key in ("health_path", "identity_path"):
            path = self.config.get(key)
            if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
                raise ValueError("HTTP requires health_path and identity_path")
            body = probe_http(item["target"], path, min(deadline, time.monotonic() + .5), self.stopping)
            if key == "identity_path" and body.strip() != item["candidate"]:
                raise ValueError("wrong target identity")
        self.check_start(deadline)
        if item["proc"].poll() is not None:
            raise ValueError("owned app died during probe")

    def identity(self, slot, *, deadline=None):
        item = self.active.get(slot)
        if not item or digest(source_files(item["source"], self.config["include"])) != item["digest"]:
            raise ValueError("missing or changed candidate snapshot")
        if item["shape"] == "http":
            self.probe(item, deadline=deadline)
            if digest(source_files(item["source"], self.config["include"])) != item["digest"]:
                raise ValueError("candidate changed during probe")
        result = {"version": 1, "slot": slot, "candidate": item["candidate"],
                "source_digest": item["digest"], "input_digest": item["original"],
                "shape": item["shape"], "target": item["target"] if item["shape"] == "http" else None,
                "exit_code": item.get("exit_code"), "snapshot": str(item["source"]),
                "state": str(item["directory"] / "state")}
        if item["binding"]:
            result.update(source_revision=item["binding"]["source_revision"],
                          source_tree=item["binding"]["source_tree"],
                          resource_digest=item["binding"]["resource_digest"])
        return result


def serve(config):
    stopping = threading.Event()
    manager = Environments(config, stopping)
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.connection.settimeout(2)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("invalid request size")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("request must be an object")
                if self.path == "/start":
                    # The local client uses the same host monotonic clock so
                    # queueing cannot grant an abandoned request a fresh budget.
                    raw_deadline = self.headers.get("X-Factory-Deadline")
                    deadline = float(raw_deadline) if raw_deadline is not None else None
                    result = manager.start(data, deadline=deadline)
                elif self.path == "/setup":
                    # setup is a cleanup boundary; start performs provisioning atomically.
                    result = manager.teardown(data["slot"])
                elif self.path == "/teardown":
                    result = manager.teardown(data["slot"])
                elif self.path == "/identity":
                    result = manager.identity(data["slot"])
                else:
                    raise ValueError("unknown operation")
                status = 200
            except Exception:
                # Never echo caller text, project output, paths or secrets on failure.
                try:
                    manager.teardown_all()
                except Exception:
                    status, result = 500, {"error": "runtime request refused; cleanup incomplete"}
                else:
                    status, result = 400, {"error": "runtime request refused; active environments cleaned"}
            payload = json.dumps(result).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except OSError:
                if self.path == "/start" and status == 200:
                    try:
                        manager.teardown(data["slot"])
                    except Exception:
                        # Keep failed ownership records for an explicit retry.
                        print("Runtime start response lost; cleanup incomplete", file=sys.stderr, flush=True)

    def parent_pipe():
        # Raw fd read: a daemon thread blocked in the buffered reader holds
        # its lock, and closing stdin at shutdown then aborts the interpreter.
        while os.read(sys.stdin.fileno(), 65536):
            pass
        stopping.set()
    threading.Thread(target=parent_pipe, daemon=True).start()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stopping.set())
    server = None
    try:
        server = HTTPServer(("127.0.0.1", 0), Handler)
        server.timeout = .2
        # Private handshake over a pipe. Parent exit here must also clean up.
        print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "token": token}), flush=True)
        while not stopping.is_set():
            server.handle_request()
    finally:
        if server:
            server.server_close()
        manager.close()


class RuntimeHost:
    def __init__(self, config):
        self.config = Path(config).resolve()

    def __enter__(self):
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                      "_serve", str(self.config)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
        line = self.proc.stdout.readline()
        if not line:
            self.proc.stdin.close()
            self.proc.wait(timeout=15)
            self.proc.stdout.close()
            raise ValueError("runtime host configuration refused")
        self.connection = json.loads(line)
        return self

    def environment(self):
        return {"FACTORY_RUNTIME_URL": self.connection["url"],
                "FACTORY_RUNTIME_TOKEN": self.connection["token"]}

    def __exit__(self, *exc):
        self.proc.stdin.close()
        rc = self.proc.wait(timeout=30)
        self.proc.stdout.close()
        if rc:
            raise RuntimeError("runtime owner cleanup failed")


def request(action, data, connection=None):
    connection = connection or {"url": os.environ["FACTORY_RUNTIME_URL"],
                                "token": os.environ["FACTORY_RUNTIME_TOKEN"]}
    # Environment is trusted, but credentials must never be sent to remote hosts.
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", connection["url"]):
        raise ValueError("runtime control must be loopback")
    headers = {"Authorization": "Bearer " + connection["token"], "Content-Type": "application/json"}
    if action == "start":
        headers["X-Factory-Deadline"] = str(time.monotonic() + START_BUDGET_S)
    req = Request(connection["url"] + "/" + action, data=json.dumps(data).encode(), headers=headers)
    # Leave the owner time to clean an expired startup before the client gives up.
    timeout = START_BUDGET_S + START_CLEANUP_HEADROOM_S if action == "start" else 310
    with HTTP.open(req, timeout=timeout) as response:
        return json.load(response)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    serve_parser = sub.add_parser("_serve", help=argparse.SUPPRESS)
    serve_parser.add_argument("config")
    manual = sub.add_parser("serve", help="foreground owner; credentials go to a private connection file")
    manual.add_argument("--config", required=True)
    manual.add_argument("--connection-file", required=True, type=Path)
    for action in ("setup", "start", "teardown", "identity", "describe"):
        node = sub.add_parser(action)
        node.add_argument("--slot", required=True)
        node.add_argument("--connection-file", type=Path)
        if action == "start":
            node.add_argument("--root", required=True)
            node.add_argument("--mutation")
            node.add_argument("--expected-source")
            node.add_argument("--expected-revision")
    args = parser.parse_args(argv)
    try:
        if args.action == "_serve":
            serve(json.loads(Path(args.config).read_text(encoding="utf-8")))
        elif args.action == "serve":
            with RuntimeHost(args.config) as host:
                # Exclusive creation avoids overwriting user data or following links.
                fd = os.open(args.connection_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    with os.fdopen(fd, "w") as stream:
                        json.dump(host.connection, stream)
                    print("Runtime owner ready; keep this process foreground.", flush=True)
                    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
                    while host.proc.poll() is None:
                        time.sleep(.2)
                finally:
                    args.connection_file.unlink(missing_ok=True)
        else:
            connection = json.loads(args.connection_file.read_text()) if args.connection_file else None
            data = {k: v for k, v in vars(args).items()
                    if k not in {"action", "connection_file"} and v is not None}
            result = request("identity" if args.action == "describe" else args.action, data, connection)
            print(result["candidate"] if args.action == "identity" else json.dumps(result))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception:
        print("Runtime host operation failed; check trusted project configuration and owner liveness.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
