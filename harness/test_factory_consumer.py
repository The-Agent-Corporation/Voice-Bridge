"""Merging launches require an explicit, valid project merge policy."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'factory_consumer', Path(__file__).resolve().parents[1] / 'factory/consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class MergePolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='factory-policy-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.policy = self.root / 'harness/harness.config.json'
        self.policy.parent.mkdir()
        self.valid = {
            'required_checks': 'Factory required checks, lint',
            'protected_paths': 'MISSION.md,harness/**,factory/**',
        }

    def write_policy(self, value):
        self.policy.write_text(json.dumps(value), encoding='utf-8')

    def assert_invalid(self, *details):
        for workflow in ('archon-lifecycle', 'archon-merge-queue'):
            with self.subTest(workflow=workflow):
                with self.assertRaises(ValueError) as raised:
                    consumer.harness_inputs(self.root, workflow)
                message = str(raised.exception)
                self.assertIn('harness/harness.config.json', message)
                for detail in details:
                    self.assertIn(detail, message)

    def test_missing_policy_refuses_merging_workflows(self):
        self.assert_invalid('required_checks', 'protected_paths')

    def test_unreadable_policy_refuses_merging_workflows(self):
        self.policy.mkdir()
        self.assert_invalid('required_checks', 'protected_paths')

    def test_malformed_policy_refuses_without_echoing_contents(self):
        self.policy.write_text('{"private": "do-not-echo-this",', encoding='utf-8')
        self.assert_invalid('JSON')
        with self.assertRaises(ValueError) as raised:
            consumer.harness_inputs(self.root, 'archon-lifecycle')
        self.assertNotIn('do-not-echo-this', str(raised.exception))

    def test_invalid_encoding_refuses_merging_workflows(self):
        self.policy.write_bytes(b'\xff')
        self.assert_invalid('JSON')

    def test_nonobject_policy_refuses_merging_workflows(self):
        for value in ([], None, 'policy', 42, True):
            with self.subTest(value=value):
                self.write_policy(value)
                self.assert_invalid('JSON object')

    def test_each_policy_key_is_required(self):
        for key in ('required_checks', 'protected_paths'):
            with self.subTest(key=key):
                self.write_policy({k: v for k, v in self.valid.items() if k != key})
                self.assert_invalid(key)

    def test_empty_and_nonstring_declarations_refuse(self):
        for key in ('required_checks', 'protected_paths'):
            for value in ('', ' \t\n ', None, True, 42, [], {}):
                with self.subTest(key=key, value=value):
                    self.write_policy({**self.valid, key: value})
                    self.assert_invalid(key)

    def test_invalid_check_lists_refuse(self):
        for value in (',', 'ci,', ',ci', 'ci,,lint', 'ci,none', 'NONE,ci', '\ufeffnone,ci',
                      '\ufeff', 'check\x00name', 'check\x85name', 'ci\x85'):
            with self.subTest(value=value):
                self.write_policy({**self.valid, 'required_checks': value})
                self.assert_invalid('required_checks')

    def test_invalid_protected_path_lists_refuse(self):
        for value in (',', '/', 'harness/**,', ',factory/**', 'harness/**,,factory/**',
                      'harness/**, /', '\ufeff', '/\ufeff', 'path\x00name', 'path\x85name'):
            with self.subTest(value=value):
                self.write_policy({**self.valid, 'protected_paths': value})
                self.assert_invalid('protected_paths')

    def test_valid_policy_preserves_names_globs_whitespace_and_bom(self):
        self.policy.write_text('\ufeff' + json.dumps({
            'required_checks': '  tests (macOS), lint  ',
            'protected_paths': '  docs with spaces/**, harness/, /factory/**  ',
            'unit': 'ordinary test command',
        }), encoding='utf-8')
        for workflow in ('archon-lifecycle', 'archon-merge-queue'):
            with self.subTest(workflow=workflow):
                self.assertEqual(consumer.harness_inputs(self.root, workflow), {
                    'required_checks': '  tests (macOS), lint  ',
                    'protected_paths': '  docs with spaces/**, harness/, /factory/**  ',
                })

    def test_explicit_none_is_preserved(self):
        self.write_policy({'required_checks': ' NONE ', 'protected_paths': 'none'})
        self.assertEqual(consumer.harness_inputs(self.root, 'archon-lifecycle'), {
            'required_checks': ' NONE ', 'protected_paths': 'none',
        })

    def test_nonmerging_workflows_do_not_require_policy(self):
        for contents in (None, '{bad json', '[]'):
            if contents is not None:
                self.policy.write_text(contents, encoding='utf-8')
            for workflow in ('archon-ship', 'archon-review', 'archon-validate'):
                with self.subTest(contents=contents, workflow=workflow):
                    self.assertEqual(consumer.harness_inputs(self.root, workflow), {})

    def test_direct_caller_inputs_cannot_hide_invalid_declared_policy(self):
        self.write_policy({**self.valid, 'protected_paths': []})
        for options in (
            ['--input', 'required_checks=none', '--input', 'protected_paths=none'],
            ['--input=required_checks=none', '--input=protected_paths=none'],
        ):
            args = ['archon-lifecycle', *options]
            with self.subTest(options=options), self.assertRaisesRegex(
                    ValueError, 'protected_paths'):
                consumer.with_default_inputs('archon-lifecycle', args, args, self.root)

    def test_valid_policy_reaches_direct_workflow_inputs(self):
        self.write_policy(self.valid)
        args = ['archon-merge-queue', '--json']
        self.assertEqual(consumer.with_default_inputs(args[0], args, args, self.root), [
            'archon-merge-queue', '--input', 'required_checks=Factory required checks, lint',
            '--input', 'protected_paths=MISSION.md,harness/**,factory/**', '--json',
        ])

    def test_valid_policy_keeps_existing_explicit_input_override(self):
        self.write_policy(self.valid)
        args = ['archon-merge-queue', '--input', 'required_checks=none']
        self.assertEqual(consumer.with_default_inputs(args[0], args, args, self.root), [
            'archon-merge-queue', '--input', 'protected_paths=MISSION.md,harness/**,factory/**',
            '--input', 'required_checks=none',
        ])

    def test_scheduled_inputs_cannot_hide_invalid_declared_policy(self):
        self.write_policy({**self.valid, 'required_checks': ''})
        schedule = self.root / '.factory/schedule.json'
        schedule.parent.mkdir()
        for workflow in ('archon-lifecycle', 'archon-merge-queue'):
            schedule.write_text(json.dumps({'workflow': workflow, 'inputs': {
                'required_checks': 'none', 'protected_paths': 'none',
            }}), encoding='utf-8')
            # Native discovery, identity and git metadata are external to this boundary.
            with self.subTest(workflow=workflow), \
                    patch.multiple(consumer,
                                   shared_root=lambda root: root,
                                   discover=lambda *_: {workflow: self.root},
                                   repository_slug=lambda _: 'owner/repository',
                                   whoami=lambda *_: 'operator',
                                   base_branch=lambda *_: 'main'), \
                    self.assertRaisesRegex(ValueError, 'required_checks'):
                consumer.trigger_config(self.root, {}, self.root, 600)


if __name__ == '__main__':
    unittest.main()
