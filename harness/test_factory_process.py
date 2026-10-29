"""Real-process regressions for runtime group identity through final cleanup."""
import json
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
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'factory'))
from runtime_process import ProcessTree
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

    def test_reaped_owner_refuses_group_signals(self):
        tree = self.process('pass')
        tree.proc.wait(timeout=5)
        with patch('runtime_process.os.killpg', side_effect=AssertionError('unreserved group signaled')):
            with self.assertRaisesRegex(RuntimeError, 'reaped'):
                tree.close()

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
