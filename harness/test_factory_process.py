"""Real-process regressions for runtime group identity through final cleanup."""
import json
import io
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'factory'))
from runtime_process import ProcessTree
import runtime_process
from runtime_host import Environments


class ProcessOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def process(self, code):
        return ProcessTree([sys.executable, '-c', code], self.root, dict(os.environ))

    def emergency_cleanup(self, tree):
        if tree.proc.returncode is None:
            os.killpg(tree.proc.pid, signal.SIGKILL)
            tree.proc.wait(timeout=5)

    def test_owner_registration_failure_never_spawns(self):
        failure = OSError('fixture registration failed')
        owners = []
        def register(owner):
            owners.append(owner)
            self.assertIsNone(owner.proc)
            self.assertIsNone(owner.job)
            self.assertFalse(owner.closed)
            self.assertFalse(owner._reaped_by_cleanup)
            raise failure
        with patch('runtime_process.subprocess.Popen') as spawn:
            with self.assertRaises(OSError) as caught:
                ProcessTree([sys.executable, '-c', 'pass'], self.root, dict(os.environ),
                            on_owner_created=register)
        self.assertIs(caught.exception, failure)
        spawn.assert_not_called()
        self.assertTrue(owners[0].closed)

    def test_spawn_failure_closes_registered_empty_owner(self):
        failure = OSError('fixture spawn failed')
        owners = []
        with patch('runtime_process.subprocess.Popen', side_effect=failure), \
                patch('runtime_process.os.killpg', side_effect=AssertionError('no child exists')):
            with self.assertRaises(OSError) as caught:
                ProcessTree([sys.executable, '-c', 'pass'], self.root, dict(os.environ),
                            on_owner_created=owners.append)
            self.assertIs(caught.exception, failure)
            self.assertEqual(len(owners), 1)
            self.assertIsNone(owners[0].proc)
            self.assertTrue(owners[0].closed)
            owners[0].close()

    def test_wait_exit_preserves_group_owner_until_close(self):
        manager = Environments({'version': 1, 'roots': {}}, threading.Event())
        tree = self.process('raise SystemExit(7)')
        try:
            manager.wait_exit(tree, 5)
            self.assertIsNone(tree.proc.returncode, 'wait_exit released the group leader PID')
            self.assertEqual(tree.poll(), 7)
            tree.close()
            self.assertEqual(tree.proc.returncode, 7)
            tree.close()
        finally:
            self.emergency_cleanup(tree)
            manager.close()

    def test_owned_command_can_retain_stdout_and_stderr_in_private_log(self):
        path = self.root / 'command.log'
        manager = Environments({'version': 1, 'roots': {}}, threading.Event())
        tree = None
        try:
            with path.open('xb') as output:
                tree = ProcessTree([sys.executable, '-c',
                    'import sys; print("ordinary-out", flush=True); print("ordinary-err", file=sys.stderr, flush=True)'],
                    self.root, dict(os.environ), output=output)
                manager.wait_exit(tree, 5)
                self.assertEqual(tree.poll(), 0)
                tree.close()
                self.assertFalse(output.closed, 'the caller owns the log handle')
            self.assertEqual(path.read_bytes(), b'ordinary-out\nordinary-err\n')
        finally:
            if tree is not None:
                self.emergency_cleanup(tree)
            manager.close()

    def test_reaped_owner_refuses_group_signals(self):
        tree = self.process('pass')
        tree.proc.wait(timeout=5)
        with patch('runtime_process.os.killpg', side_effect=AssertionError('unreserved group signaled')):
            with self.assertRaisesRegex(RuntimeError, 'reaped'):
                tree.close()

    def test_cleanup_retry_after_own_reap_only_observes_and_closes_stdin(self):
        tree = self.process('pass')
        tree.proc.stdin = io.BytesIO()
        killpg = os.killpg
        def owned_signal(pid, signum):
            if signum and tree.proc.returncode is not None:
                self.fail('cleanup retry signaled a released process group')
            return killpg(pid, signum)
        try:
            with patch('runtime_process.os.killpg', side_effect=owned_signal), \
                    patch('runtime_process.group_has_live_members', create=True,
                          side_effect=[RuntimeError('membership unavailable'), False]):
                with self.assertRaisesRegex(RuntimeError, 'membership unavailable'):
                    tree.close()
                self.assertTrue(tree.proc.stdin.closed)
                self.assertIsNotNone(tree.proc.returncode)
                self.assertEqual(tree.poll(), tree.proc.returncode)
                self.assertFalse(tree.closed)
                tree.close()
                self.assertTrue(tree.closed)
        finally:
            self.emergency_cleanup(tree)

    def test_live_members_time_out_then_retry_without_signaling(self):
        tree = self.process('pass')
        try:
            ticks = iter((0, 16))
            with patch('runtime_process.group_has_live_members', create=True, return_value=True), \
                    patch.object(runtime_process, 'time', SimpleNamespace(
                        monotonic=lambda: next(ticks), sleep=lambda _: None)):
                with self.assertRaisesRegex(TimeoutError, 'group'):
                    tree.close()
            self.assertFalse(tree.closed)
            with patch('runtime_process.group_has_live_members', create=True, return_value=False), \
                    patch('runtime_process.os.killpg', side_effect=AssertionError('retry signaled')):
                tree.close()
            self.assertTrue(tree.closed)
        finally:
            self.emergency_cleanup(tree)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux subreaper zombie proof')
    def test_real_zombie_only_group_is_cleaned_without_waiting_for_reaper(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        tree = None
        descendant = None
        marker = self.root / 'zombie-pid'
        code = ("import os,pathlib; child=os.fork()\n"
                "if child == 0: os._exit(0)\n"
                f"pathlib.Path({str(marker)!r}).write_text(str(child))\n"
                "os._exit(0)\n")
        try:
            tree = self.process(code)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            descendant = int(marker.read_text())
            stat = Path(f'/proc/{descendant}/stat')
            while time.monotonic() < deadline:
                if tree.poll() is not None and stat.read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                    break
                time.sleep(.01)
            self.assertEqual(stat.read_text().rsplit(')', 1)[1].split()[0], 'Z')
            os.killpg(tree.proc.pid, 0)
            tree.close()
            self.assertTrue(tree.closed)
            os.killpg(tree.proc.pid, 0)  # The adopted zombie still reserves the group.
            self.assertEqual(stat.read_text().rsplit(')', 1)[1].split()[0], 'Z')
        finally:
            try:
                if tree:
                    self.emergency_cleanup(tree)
                if descendant is not None:
                    os.waitpid(descendant, 0)
            finally:
                libc.prctl(36, previous.value, 0, 0, 0)

    def test_missing_waitid_refuses_before_spawning(self):
        with patch('runtime_process.os.waitid', None, create=True), \
                patch('runtime_process.subprocess.Popen', side_effect=AssertionError('unsupported host spawned')):
            with self.assertRaisesRegex(RuntimeError, 'waitid'):
                self.process('pass')

    def test_early_exit_descendant_is_stopped_before_owner_reap(self):
        marker = self.root / 'listener.json'
        child = ("import json,os,pathlib,socket,time; s=socket.socket(); "
                 "s.bind(('127.0.0.1',0)); s.listen(); "
                 f"pathlib.Path({str(marker)!r}).write_text(json.dumps([os.getpid(),s.getsockname()[1]])); "
                 "time.sleep(60)")
        code = ("import subprocess,sys,pathlib,time; "
                f"subprocess.Popen([sys.executable,'-c',{child!r}]); "
                f"p=pathlib.Path({str(marker)!r})\n"
                "while not p.exists(): time.sleep(.01)\n")
        tree = self.process(code)
        late_signals = []
        killpg = os.killpg

        def signal_reserved_group(pid, signum):
            if signum and tree.proc.returncode is not None:
                late_signals.append(signum)
                raise AssertionError('process-group identity was already released')
            return killpg(pid, signum)

        try:
            deadline = time.monotonic() + 5
            while tree.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(tree.poll(), 0)
            _, port = json.loads(marker.read_text())
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                pass
            with patch('runtime_process.os.killpg', side_effect=signal_reserved_group):
                tree.close()
            self.assertEqual(late_signals, [])
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', port), timeout=1)
        finally:
            self.emergency_cleanup(tree)

    def test_finite_runtime_retains_exit_code_and_reserves_before_cleanup(self):
        (self.root / 'app.py').write_text('raise SystemExit(7)\n')
        manager = Environments({'version': 1, 'roots': {'candidate': str(self.root)},
            'shape': 'cli', 'include': ['app.py'], 'timeout_s': 5,
            'command': [sys.executable, 'app.py']}, threading.Event())
        reaped = []
        close = ProcessTree.close

        def reserved_close(tree):
            if not tree.closed and tree.proc.returncode is not None:
                reaped.append(tree.proc.pid)
            return close(tree)

        try:
            with patch.object(ProcessTree, 'close', reserved_close):
                result = manager.start({'slot': 'test', 'root': 'candidate'})
            self.assertEqual(result['exit_code'], 7)
            self.assertEqual(reaped, [])
        finally:
            manager.close()

    def test_runtime_cleanup_failure_preserves_startup_error(self):
        (self.root / 'app.py').write_text('pass\n')
        manager = Environments({'version': 1, 'roots': {'candidate': str(self.root)},
            'shape': 'cli', 'include': ['app.py'], 'timeout_s': 5,
            'command': [sys.executable, 'app.py']}, threading.Event())
        try:
            with patch('runtime_host.ProcessTree', side_effect=ValueError('primary startup refusal')), \
                    patch.object(manager, 'teardown', side_effect=[None, OSError('cleanup failed')]):
                with self.assertRaisesRegex(ValueError, 'primary startup refusal') as failure:
                    manager.start({'slot': 'test', 'root': 'candidate'})
            self.assertTrue(any('cleanup' in note for note in failure.exception.__notes__))
        finally:
            manager.close()


if __name__ == '__main__':
    unittest.main()
