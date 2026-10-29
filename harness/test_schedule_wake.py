"""A refused new admission must not block durable continuations."""
from contextlib import contextmanager, ExitStack, nullcontext, redirect_stderr
import importlib.util
import io
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
            policy = {'required_checks': 'ci', 'protected_paths': 'harness/**'}
            (root / 'harness').mkdir()
            (root / 'harness/harness.config.json').write_text(json.dumps(policy))
            if isinstance(schedule_data, dict):
                schedule_data = {'workflow': 'archon-lifecycle', 'inputs': {}, **schedule_data}
            workflow = schedule_data.get('workflow') if isinstance(schedule_data, dict) else 'archon-lifecycle'
            inputs = schedule_data.get('inputs', {}) if isinstance(schedule_data, dict) else {}
            values = {**policy, **{k: v if isinstance(v, str) else json.dumps(v) for k, v in inputs.items()}}
            (root / consumer.TRIGGER).write_text(json.dumps({'binding': {'launch': {
                'workflowName': workflow, 'inputs': values}}}))
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

    def test_uncertain_dispatch_is_not_reported_as_refused_and_still_wakes(self):
        with self.tick({}) as (root, mocks):
            mocks['dispatch_bound_trigger'].side_effect = ValueError(
                'Runtime dispatch uncertain; no retry permitted. Inspect dispatch.json')
            output = io.StringIO()
            with redirect_stderr(output):
                self.assertEqual(consumer.schedule(root, ['fire']), 1)
            self.assertIn('Launch phase error (ValueError): Runtime dispatch uncertain; no retry permitted.',
                          output.getvalue())
            self.assertNotIn('Launch refused:', output.getvalue())
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
            output = io.StringIO()
            with redirect_stderr(output):
                self.assertEqual(consumer.schedule(root, ['fire']), 1)
            self.assertIn('ValueError', output.getvalue())
            self.assertIn('.factory/gate.json must contain a JSON object (found list)', output.getvalue())
            self.assertEqual((root / '.factory/gate.json').read_text(), '[]')
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

    def assert_policy_refusal_wakes_without_admission(self, root, mocks):
        output = io.StringIO()
        with redirect_stderr(output):
            self.assertEqual(consumer.schedule(root, ['fire']), 1)
        mocks['launch_decision'].assert_not_called()
        mocks['dispatch_bound_trigger'].assert_not_called()
        self.assertEqual(mocks['execute'].call_count, 1)
        self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])
        return output.getvalue()

    def test_invalid_current_policy_refuses_both_dispatch_paths_but_wakes(self):
        for bound in (True, False):
            for contents in ('{invalid', '[]', '{"required_checks":"", "protected_paths":"none"}'):
                with self.subTest(bound=bound, contents=contents), self.tick({}) as (root, mocks):
                    mocks['runtime_binding_options'].return_value = {'helper': 'fixture'} if bound else None
                    (root / 'harness/harness.config.json').write_text(contents)
                    self.assertIn('merge policy', self.assert_policy_refusal_wakes_without_admission(
                        root, mocks).lower())

    def test_changed_effective_policy_refuses_before_admission_and_wakes(self):
        for key, value in (('required_checks', 'ci,new-required'), ('protected_paths', 'harness/**,factory/**')):
            for bound in (True, False):
                with self.subTest(key=key, bound=bound), self.tick({}) as (root, mocks):
                    mocks['runtime_binding_options'].return_value = {'helper': 'fixture'} if bound else None
                    path = root / 'harness/harness.config.json'
                    policy = json.loads(path.read_text())
                    policy[key] = value
                    path.write_text(json.dumps(policy))
                    self.assertIn('schedule install', self.assert_policy_refusal_wakes_without_admission(root, mocks))

    def test_explicit_schedule_overrides_remain_effective_after_valid_default_change(self):
        with self.tick({'inputs': {'required_checks': 'none', 'protected_paths': 'explicit/**'}}) as (root, mocks):
            (root / 'harness/harness.config.json').write_text(json.dumps({
                'required_checks': 'new-default', 'protected_paths': 'new-default/**'}))
            self.assertEqual(consumer.schedule(root, ['fire']), 0)
            mocks['launch_decision'].assert_called_once()
            mocks['dispatch_bound_trigger'].assert_called_once()
            self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_explicit_schedule_overrides_cannot_hide_invalid_current_policy(self):
        with self.tick({'inputs': {'required_checks': 'none', 'protected_paths': 'none'}}) as (root, mocks):
            (root / 'harness/harness.config.json').unlink()
            self.assert_policy_refusal_wakes_without_admission(root, mocks)

    def test_changed_override_requires_reinstall_before_dispatch(self):
        with self.tick({'inputs': {'required_checks': 'none'}}) as (root, mocks):
            schedule = json.loads((root / consumer.SCHEDULE).read_text())
            schedule['inputs']['required_checks'] = 'ci'
            (root / consumer.SCHEDULE).write_text(json.dumps(schedule))
            self.assertIn('schedule install', self.assert_policy_refusal_wakes_without_admission(root, mocks))

    def test_real_reinstalled_binding_accepts_current_policy_and_explicit_override(self):
        for workflow in ('archon-lifecycle', 'archon-merge-queue'):
            with self.subTest(workflow=workflow), self.tick({
                    'workflow': workflow, 'inputs': {'required_checks': 'none'}}) as (root, mocks):
                (root / 'harness/harness.config.json').write_text(json.dumps({
                    'required_checks': 'new-default', 'protected_paths': 'new-protected/**'}))
                with patch.multiple(consumer, discover=lambda *_: {workflow: root},
                                    repository_slug=lambda _: 'owner/repository',
                                    whoami=lambda *_: 'operator', base_branch=lambda *_: 'main'):
                    config = consumer.trigger_config(root, {}, root, 600)
                self.assertEqual(config['binding']['launch']['inputs']['required_checks'], 'none')
                (root / consumer.TRIGGER).write_text(json.dumps(config))
                self.assertEqual(consumer.schedule(root, ['fire']), 0)
                mocks['dispatch_bound_trigger'].assert_called_once()
                self.assertEqual(mocks['execute'].call_args.args[0], ['native', 'workflow', 'wake'])

    def test_nonmerging_workflow_does_not_require_current_merge_policy(self):
        with self.tick({'workflow': 'archon-review'}) as (root, mocks):
            (root / 'harness/harness.config.json').unlink()
            self.assertEqual(consumer.schedule(root, ['fire']), 0)
            mocks['dispatch_bound_trigger'].assert_called_once()

    def test_nonmerging_malformed_inputs_refuse_before_admission_but_still_wake(self):
        for inputs in ([], None, 'invalid', 42, True):
            with self.subTest(inputs=inputs), self.tick({'workflow': 'archon-review'}) as (root, mocks):
                (root / consumer.SCHEDULE).write_text(json.dumps({'workflow': 'archon-review', 'inputs': inputs}))
                (root / 'harness/harness.config.json').unlink()
                mocks['runtime_binding_options'].return_value = None
                with patch.object(consumer, 'harness_inputs') as policy:
                    output = self.assert_policy_refusal_wakes_without_admission(root, mocks)
                policy.assert_not_called()
                self.assertIn('schedule.json requires an inputs object', output)

    def test_changed_workflow_cannot_bypass_installed_merging_policy(self):
        with self.tick({}) as (root, mocks):
            (root / consumer.SCHEDULE).write_text(json.dumps({'workflow': 'archon-review', 'inputs': {}}))
            (root / 'harness/harness.config.json').unlink()
            self.assertIn('schedule install', self.assert_policy_refusal_wakes_without_admission(root, mocks))

    def test_malformed_installed_policy_refuses_and_wakes(self):
        for binding in ({}, {'binding': []}, {'binding': {'launch': None}},
                        {'binding': {'launch': {'workflowName': 'archon-lifecycle', 'inputs': {}}}}):
            with self.subTest(binding=binding), self.tick({}) as (root, mocks):
                (root / consumer.TRIGGER).write_text(json.dumps(binding))
                self.assert_policy_refusal_wakes_without_admission(root, mocks)


if __name__ == '__main__':
    unittest.main()
