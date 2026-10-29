"""Fail-closed process-group observations without mutating signals."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'factory'))
import runtime_process


class GroupObservationTests(unittest.TestCase):
    def observe(self, contents, pgid=432):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for pid, text in enumerate(contents, 100):
                (root / str(pid)).mkdir()
                body = text if isinstance(text, bytes) else text.encode('utf-8')
                (root / str(pid) / 'stat').write_bytes(body)
                task = root / str(pid) / 'task' / str(pid)
                task.mkdir(parents=True)
                (task / 'stat').write_bytes(body)
            with patch.object(runtime_process, '_PROC_ROOT', root, create=True), \
                    patch.object(runtime_process.sys, 'platform', 'linux'), \
                    patch('runtime_process.os.killpg', return_value=None) as signal:
                value = runtime_process.group_has_live_members(pgid)
                self.assertTrue(all(call.args[1] == 0 for call in signal.call_args_list))
                return value

    def test_zombie_only_proc_group_is_not_live(self):
        self.assertFalse(self.observe(['100 (odd ) name) Z 1 432 432 0']))

    def test_non_utf8_comm_does_not_obscure_owned_group(self):
        for state, expected in ((b'Z', False), (b'S', True)):
            with self.subTest(state=state):
                self.assertEqual(self.observe([
                    b'100 (unrelated\xff) S 1 999 999 0',
                    b'101 (owned\xfe) name) ' + state + b' 1 432 432 0',
                ]), expected)

    def test_non_utf8_task_comm_preserves_live_thread_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / '100'
            task = process / 'task' / '101'
            task.mkdir(parents=True)
            (process / 'stat').write_bytes(b'100 (leader) Z 1 432 432 0')
            (task / 'stat').write_bytes(b'101 (worker\xff) S 1 432 432 0')
            with patch.object(runtime_process, '_PROC_ROOT', root), \
                    patch.object(runtime_process.sys, 'platform', 'linux'), \
                    patch('runtime_process.os.killpg', return_value=None) as signal:
                self.assertTrue(runtime_process.group_has_live_members(432))
                self.assertTrue(all(call.args[1] == 0 for call in signal.call_args_list))

    def test_non_ascii_membership_fields_remain_unknown(self):
        for body in (b'100 (name) \xff 1 432', b'100 (name) Z 1 43\xff'):
            with self.subTest(body=body), self.assertRaisesRegex(RuntimeError, 'membership'):
                self.observe([body])

    def test_live_member_alongside_zombies_is_live(self):
        self.assertTrue(self.observe(['100 (dead) Z 1 432 432 0', '101 (live) S 1 432 432 0']))

    def test_unrelated_zombies_do_not_prove_existing_group_dead(self):
        with self.assertRaisesRegex(RuntimeError, 'membership'):
            self.observe(['100 (other) Z 1 999 999 0'])

    def test_malformed_proc_state_is_unknown(self):
        for body in ('truncated', '100 (bad) ? 1 432', '100 (bad) Z not-int 432'):
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                self.observe([body])

    def test_unreadable_membership_is_unknown(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError('private')), \
                self.assertRaisesRegex(RuntimeError, 'membership'):
            self.observe(['100 (dead) Z 1 432 432 0'])

    def test_zombie_leader_with_live_thread_is_still_live(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / '100'
            (process / 'task' / '101').mkdir(parents=True)
            (process / 'stat').write_text('100 (leader) Z 1 432 432 0')
            (process / 'task' / '101' / 'stat').write_text('101 (worker) S 1 432 432 0')
            with patch.object(runtime_process, '_PROC_ROOT', root), \
                    patch.object(runtime_process.sys, 'platform', 'linux'), \
                    patch('runtime_process.os.killpg', return_value=None):
                self.assertTrue(runtime_process.group_has_live_members(432))
                (process / 'task' / '101' / 'stat').unlink()
                (process / 'task' / '101').rmdir()
                with self.assertRaisesRegex(RuntimeError, 'membership'):
                    runtime_process.group_has_live_members(432)

    def test_absent_group_needs_no_process_inspection(self):
        with patch('runtime_process.os.killpg', side_effect=ProcessLookupError), \
                patch('runtime_process.subprocess.run', side_effect=AssertionError('unnecessary ps')):
            self.assertFalse(runtime_process.group_has_live_members(432))

    def test_posix_ps_zombie_and_live_states(self):
        for output, expected in (('432 Z\n432 Z+\n999 S\n', False), ('432 Z\n432 S+\n', True)):
            with self.subTest(output=output), patch.object(runtime_process.sys, 'platform', 'darwin'), \
                    patch('runtime_process.os.killpg', return_value=None), \
                    patch('runtime_process.subprocess.run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                self.assertEqual(runtime_process.group_has_live_members(432), expected)

    def test_unrelated_unknown_ps_state_does_not_obscure_owned_group(self):
        for output, expected in (('999 ?Es\n432 Z\n', False), ('999 ?E\n432 S\n', True)):
            with self.subTest(output=output), patch.object(runtime_process.sys, 'platform', 'darwin'), \
                    patch('runtime_process.os.killpg', return_value=None), \
                    patch('runtime_process.subprocess.run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                self.assertEqual(runtime_process.group_has_live_members(432), expected)

    def test_failed_or_malformed_ps_remains_unknown(self):
        for error in (subprocess.CalledProcessError(1, ['/bin/ps'], stderr='failure'),
                      subprocess.TimeoutExpired(['/bin/ps'], 5)):
            with self.subTest(error=type(error).__name__), \
                    patch.object(runtime_process.sys, 'platform', 'darwin'), \
                    patch('runtime_process.os.killpg', return_value=None), \
                    patch('runtime_process.subprocess.run', side_effect=error) as inspect:
                with self.assertRaisesRegex(RuntimeError, 'membership'):
                    runtime_process.group_has_live_members(432)
                inspect.assert_called_once()
                self.assertIs(inspect.call_args.kwargs['check'], True)
                self.assertGreater(inspect.call_args.kwargs['timeout'], 0)
        for result in (subprocess.CompletedProcess([], 0, '432\n', ''),
                       subprocess.CompletedProcess([], 0, '432 ?Es\n', ''),
                       subprocess.CompletedProcess([], 0, '', '')):
            with self.subTest(result=result), patch.object(runtime_process.sys, 'platform', 'darwin'), \
                    patch('runtime_process.os.killpg', return_value=None), \
                    patch('runtime_process.subprocess.run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, 'membership'):
                    runtime_process.group_has_live_members(432)
