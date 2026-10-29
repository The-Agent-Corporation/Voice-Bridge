"""A refused new admission must not block durable continuations."""
from contextlib import contextmanager, ExitStack, nullcontext
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('wake_consumer', Path(__file__).resolve().parents[1] / 'factory/consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class WakeAfterRefusal(unittest.TestCase):
    @contextmanager
    def tick(self, schedule_data=None):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            root = Path(folder)
            (root / consumer.TRIGGER).parent.mkdir(parents=True, exist_ok=True)
            (root / consumer.TRIGGER).write_text('{}')
            (root / consumer.SCHEDULE).write_text(json.dumps(schedule_data))
            stack.enter_context(patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: root,
                shared_root=lambda _: root, cli=lambda *_: ['native'], archon_home=lambda: root,
                verify_registry_environment=lambda _: None, windowless=lambda: False,
                single_flight=lambda _: nullcontext(True), wake_allowed=lambda *_: True))
            mocks = {name: stack.enter_context(patch.object(consumer, name, return_value=value))
                for name, value in [('launch_decision', True), ('runtime_binding_options', {'helper': 'fixture'}),
                                    ('dispatch_bound_trigger', 0), ('execute', subprocess.CompletedProcess([], 0))]}
            yield root, mocks

    def test_admission_refusals_still_wake(self):
        for refused in ('launch_decision', 'runtime_binding_options', 'dispatch_bound_trigger'):
            for error in (ValueError('invalid policy'), KeyError('binding'), OSError('unavailable'),
                          AttributeError('malformed gate'), RuntimeError('unexpected admission failure'),
                          subprocess.TimeoutExpired('helper', 180)):
                with self.subTest(refused=refused, error=type(error).__name__), self.tick({}) as (root, mocks):
                    mocks[refused].side_effect = error
                    self.assertEqual(consumer.schedule(root, ['fire']), 1)
                    self.assertEqual(mocks['execute'].call_count, 1)
                    self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_non_object_schedule_refuses_before_launch_and_still_wakes(self):
        for data in ([], None, 'invalid', 42, True):
            with self.subTest(data=data), self.tick(data) as (root, mocks):
                self.assertEqual(consumer.schedule(root, ['fire']), 1)
                mocks['launch_decision'].assert_not_called()
                mocks['dispatch_bound_trigger'].assert_not_called()
                self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_unbound_native_launch_error_still_wakes(self):
        for error in (OSError('native unavailable'), subprocess.TimeoutExpired('native', 180)):
            with self.subTest(error=type(error).__name__), self.tick({}) as (root, mocks):
                mocks['runtime_binding_options'].return_value = None
                mocks['execute'].side_effect = [error, subprocess.CompletedProcess([], 0)]
                self.assertEqual(consumer.schedule(root, ['fire']), 1)
                self.assertEqual(mocks['execute'].call_count, 2)
                self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_wake_failure_is_not_hidden_by_successful_admission(self):
        with self.tick({}) as (root, mocks):
            mocks['execute'].return_value = subprocess.CompletedProcess([], 7)
            self.assertEqual(consumer.schedule(root, ['fire']), 7)

    def test_missing_trigger_refuses_launch_but_still_wakes(self):
        with self.tick({}) as (root, mocks):
            (root / consumer.TRIGGER).unlink()
            self.assertEqual(consumer.schedule(root, ['fire']), 1)
            mocks['dispatch_bound_trigger'].assert_not_called()
            self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_malformed_persisted_gate_still_wakes(self):
        with self.tick({}) as (root, mocks):
            (root / '.factory/gate.json').write_text('[]')
            mocks['launch_decision'].side_effect = lambda *_: consumer.tick_state(root, last_launch=1)
            self.assertEqual(consumer.schedule(root, ['fire']), 1)
            mocks['dispatch_bound_trigger'].assert_not_called()
            self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_operator_interrupt_is_not_swallowed(self):
        with self.tick({}) as (root, mocks):
            mocks['launch_decision'].side_effect = KeyboardInterrupt
            with self.assertRaises(KeyboardInterrupt):
                consumer.schedule(root, ['fire'])
            mocks['execute'].assert_not_called()

    def test_launch_lock_failure_still_wakes(self):
        with self.tick({}) as (root, mocks), patch.object(consumer, 'single_flight',
                side_effect=[OSError('launch lock unavailable'), nullcontext(True)]):
            self.assertEqual(consumer.schedule(root, ['fire']), 1)
            mocks['dispatch_bound_trigger'].assert_not_called()
            self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_registry_refusal_still_blocks_both_launch_and_wake(self):
        with self.tick({}) as (root, mocks), \
                patch.object(consumer, 'verify_registry_environment', side_effect=ValueError('registry refused')):
            with self.assertRaisesRegex(ValueError, 'registry refused'):
                consumer.schedule(root, ['fire'])
            mocks['dispatch_bound_trigger'].assert_not_called()
            mocks['execute'].assert_not_called()

    def test_binding_parser_rejects_non_object_for_all_callers(self):
        for data in ([], None, 'invalid', 42, True):
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, 'JSON object'):
                consumer.runtime_binding_options(Path('.'), data)


if __name__ == '__main__':
    unittest.main()
