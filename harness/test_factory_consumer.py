"""Merging launches require an explicit, valid project merge policy."""
import importlib.util
import importlib.machinery
from contextlib import ExitStack, closing, redirect_stdout
import hashlib
import io
import json
import os
import plistlib
import py_compile
from pathlib import Path
import sqlite3
import subprocess
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

    def test_mixed_none_protected_path_is_native_literal_pattern(self):
        self.write_policy({**self.valid, 'protected_paths': 'none,harness/**'})
        self.assertEqual(consumer.harness_inputs(self.root, 'archon-lifecycle')['protected_paths'],
                         'none,harness/**')

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


class LocalBrakeEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='factory-brake-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        subprocess.run(['git', 'init', '-q', str(self.root)], env=self.environment, check=True)

    def test_main_local_brakes_allow_benign_git_environment(self):
        environment = {**self.environment, 'GIT_ASKPASS': '/unused-helper',
                       'GIT_EDITOR': '/unused-editor', 'GIT_AUTHOR_NAME': 'Fixture'}
        with patch.dict(os.environ, environment, clear=True), patch.object(consumer.Path, 'cwd', return_value=self.root), redirect_stdout(io.StringIO()):
            self.assertEqual(consumer.main(['halt']), 0)
            self.assertEqual(consumer.main(['pause']), 0)
        self.assertTrue((self.root / '.factory/STOP').is_file())
        self.assertTrue((self.root / '.factory/PAUSE').is_file())

    def test_brakes_and_admission_still_reject_repository_redirects(self):
        for key, value in {'GIT_DIR': str(self.root / '.git'), 'GIT_WORK_TREE': str(self.root),
                           'GIT_CONFIG_COUNT': '0', 'GIT_CONFIG_PARAMETERS': ''}.items():
            with self.subTest(key=key), patch.dict(os.environ, {**self.environment, key: value}, clear=True), patch.object(consumer.Path, 'cwd', return_value=self.root):
                self.assertEqual(consumer.main(['halt']), 1)
                self.assertEqual(consumer.main(['pause']), 1)
        with patch.dict(os.environ, {**self.environment, 'GIT_ASKPASS': '/unused-helper'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'Git environment redirects'):
                consumer.project_root()
        self.assertFalse((self.root / '.factory/STOP').exists())
        self.assertFalse((self.root / '.factory/PAUSE').exists())


class SharedAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='factory-shared-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'project'
        self.home = self.base / 'home'
        self.archon = self.home / '.archon'
        self.controller_dir = self.base / 'controller'
        for path in (self.root, self.root / '.factory', self.home, self.archon, self.controller_dir):
            path.mkdir(mode=0o700)
            path.chmod(0o700)
        self.controller = self.controller_dir / 'factoryctl.py'
        (self.root / 'factory').mkdir(mode=0o700)
        (self.root / 'factory').chmod(0o700)
        (self.root / 'factory/consumer.py').write_bytes(Path(consumer.__file__).read_bytes())
        (self.root / 'factory/pack.json').write_bytes((consumer.HERE / 'pack.json').read_bytes())
        self.controller.write_text('# controller fixture\n')
        (self.controller_dir / 'controls.py').write_text('# dependency fixture\n')
        for path in (self.root / 'factory/consumer.py', self.root / 'factory/pack.json',
                     self.controller, self.controller_dir / 'controls.py'):
            path.chmod(0o600)
        self.config_path = self.controller_dir / 'controls-config.json'
        self.registry_path = self.archon / consumer.ADMISSION_REGISTRY
        self.config = {'archon_home': str(self.archon), 'projects': {'voice-bridge': {
            'identifier': 'voice-bridge', 'registered_root': str(self.root), 'consumer_root': str(self.root),
            'source_root': str(self.base / ('a' * 40)), 'source_revision': 'a' * 40,
            'consumer_sha256': hashlib.sha256(Path(consumer.__file__).read_bytes()).hexdigest(),
            'pack_sha256': hashlib.sha256((consumer.HERE / 'pack.json').read_bytes()).hexdigest(),
            'schedule': {'interval_seconds': 600}}}}
        project = self.config['projects']['voice-bridge']
        self.registry = {'schema': 'factory-controller-v1', 'controller': str(self.controller),
            'config': str(self.config_path), 'config_sha256': '',
            'controller_files': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in self.controller_dir.glob('*.py')},
            'projects': {str(self.root): {'project': 'voice-bridge', **{key: project[key] for key in
                ('source_root', 'source_revision', 'consumer_sha256', 'pack_sha256')}}}}
        self.save_config()
        self.marker = self.root / consumer.ADMISSION_MARKER
        self.write_private(self.marker, {'schema': 'factory-enrolled-v1', 'registry': str(self.registry_path), 'project': 'voice-bridge'})
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(consumer.Path, 'home', return_value=self.home))
        stack.enter_context(patch.object(consumer, 'default_admission_home', return_value=self.archon))
        environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        stack.enter_context(patch.dict(os.environ, {**environment, 'ARCHON_HOME': str(self.archon)}, clear=True))
        stack.enter_context(patch.object(consumer, 'shared_root', side_effect=lambda path, **_: Path(path)))
        self.execute = stack.enter_context(patch.object(consumer, 'execute', return_value=subprocess.CompletedProcess([], 0)))

    def write_private(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def save_config(self):
        self.write_private(self.config_path, self.config)
        self.registry['config_sha256'] = hashlib.sha256(self.config_path.read_bytes()).hexdigest()
        self.write_private(self.registry_path, self.registry)

    def test_fire_uses_only_pinned_typed_controller_without_native_fallback(self):
        self.execute.return_value = subprocess.CompletedProcess([], 7)
        self.assertEqual(consumer.schedule(self.root, ['fire']), 7)
        self.assertEqual(self.execute.call_count, 1)
        argv = self.execute.call_args.args[0]
        self.assertEqual(argv[:6], [consumer.sys.executable, '-E', '-s', '-S', '-B', '-X'])
        self.assertTrue(argv[6].startswith('pycache_prefix='))
        self.assertFalse(Path(argv[6].split('=', 1)[1]).exists())
        self.assertEqual(argv[7:], [str(self.controller), '--config', str(self.config_path), 'schedule-tick', 'voice-bridge'])
        self.assertIsNone(self.execute.call_args.kwargs['timeout'])

    def test_sibling_import_shadows_fail_closed(self):
        for filename in ('controls.pyc', 'controls.abi3.so', 'controls.pyd'):
            shadow = self.controller_dir / filename
            shadow.write_bytes(b'unpinned executable')
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, 'import shadow'):
                consumer.schedule(self.root, ['fire'])
            shadow.unlink()
        package = self.controller_dir / 'controls'
        package.mkdir()
        (package / '__init__.py').write_text('raise RuntimeError("not pinned")')
        with self.assertRaisesRegex(ValueError, 'import shadow'):
            consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_extension_package_shadows_fail_closed_for_each_pinned_module(self):
        for module in ('factoryctl', 'controls'):
            package = self.controller_dir / module
            package.mkdir()
            for suffix in importlib.machinery.EXTENSION_SUFFIXES:
                shadow = package / ('__init__' + suffix)
                shadow.write_bytes(b'inert fixture: never load this extension')
                with self.subTest(module=module, suffix=suffix), self.assertRaisesRegex(ValueError, 'import shadow'):
                    consumer.schedule(self.root, ['fire'])
                shadow.unlink()
            package.rmdir()
        self.execute.assert_not_called()

    def test_exact_mapping_does_not_probe_broken_unrelated_repository(self):
        unrelated = self.base / 'unrelated-nonrepository'
        unrelated.mkdir()
        self.config['projects']['unrelated'] = {'registered_root': str(unrelated)}
        self.save_config()
        def roots(path, **_):
            if Path(path) == unrelated:
                raise ValueError('unrelated repository unavailable')
            return Path(path)
        with patch.object(consumer, 'shared_root', side_effect=roots):
            self.assertEqual(consumer.shared_admission(self.root)['project'], 'voice-bridge')
            # Once an alias proves enrollment, report the missing mapping rather
            # than probing unrelated repositories and replacing the refusal cause.
            self.registry['projects'].clear()
            self.save_config()
            with self.assertRaisesRegex(ValueError, 'Enrolled project mapping is missing; no native fallback'):
                consumer.shared_admission(self.root)

    def test_enrolled_host_without_getuid_refuses_cleanly_without_dispatch(self):
        with patch.object(consumer.os, 'getuid', create=True) as getuid, ExitStack() as cleanup:
            # patch must find its placeholder when it removes a created attribute.
            cleanup.callback(setattr, consumer.os, 'getuid', getuid)
            del consumer.os.getuid
            with self.assertRaisesRegex(ValueError, 'POSIX.*no native fallback'):
                consumer._admission_bytes(self.registry_path)
            with patch.object(consumer, 'project_root', return_value=self.root), \
                    patch('sys.stderr', new=io.StringIO()) as error:
                self.assertEqual(consumer.main(['schedule', 'fire']), 1)
            self.assertIn('Factory refused:', error.getvalue())
            self.assertNotIn('Traceback', error.getvalue())
        self.execute.assert_not_called()

    def test_unenrolled_host_without_getuid_keeps_native_read_only_path(self):
        self.marker.unlink()
        self.registry_path.unlink()
        with patch.object(consumer.os, 'getuid', create=True) as getuid, ExitStack() as cleanup:
            cleanup.callback(setattr, consumer.os, 'getuid', getuid)
            del consumer.os.getuid
            self.assertIsNone(consumer.shared_admission(self.root))
            with patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base,
                                cli=lambda *_: ['native-read']):
                self.assertEqual(consumer.invoke(self.root, 'get', ['exact-run']), 0)
        self.assertIn('exact-run', self.execute.call_args.args[0])

    def test_controller_directory_links_fail_closed_before_import(self):
        target = self.base / 'outside-package'
        target.mkdir()
        link = self.controller_dir / 'controls'
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'Directory symlink creation unavailable: {error}')
        with self.assertRaisesRegex(ValueError, 'import shadow'):
            consumer.shared_admission(self.root)
        target.rmdir()
        with self.assertRaisesRegex(ValueError, 'import shadow'):
            consumer.shared_admission(self.root)

    def test_typed_controller_executes_pinned_source_not_unchecked_bytecode(self):
        module = self.controller_dir / 'controls.py'
        module.write_text("VALUE = 'stale-bytecode'\n")
        py_compile.compile(str(module), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        module.write_text("VALUE = 'pinned-source'\n")
        self.controller.write_text('import controls\nprint(controls.VALUE)\n')
        self.registry['controller_files'] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                             for path in self.controller_dir.glob('*.py')}
        self.save_config()
        old = subprocess.run([consumer.sys.executable, '-E', '-s', str(self.controller)],
                             capture_output=True, text=True, check=True)
        self.assertEqual(old.stdout.strip(), 'stale-bytecode')
        observed = []
        def execute(argv, cwd, **kwargs):
            cache = Path(argv[6].split('=', 1)[1])
            self.assertEqual(cache.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(cache.iterdir()), [])
            result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, check=True)
            observed.append(result.stdout.strip())
            return result
        self.execute.side_effect = execute
        self.assertEqual(consumer.schedule(self.root, ['fire']), 0)
        self.assertEqual(observed, ['pinned-source'])

    def test_enrolled_mutations_refuse_native_passthrough_including_runtime_host(self):
        cases = [('run', ['archon-lifecycle']), ('run', ['archon-lifecycle', '--resume']),
                 ('run', ['archon-lifecycle', '--runtime-host', '/unused']), ('resume', ['run-id']),
                 ('cancel', ['run-id']), ('abandon', ['run-id']), ('unpause', []),
                 ('approve', ['run-id']), ('reject', ['run-id']), ('respond', ['run-id', 'approve'])]
        for action, args in cases:
            with self.subTest(action=action, args=args), self.assertRaisesRegex(ValueError, 'factoryctl|shared capacity'):
                consumer.invoke(self.root, action, args)
        self.execute.assert_not_called()

    def test_missing_registry_or_known_project_mapping_never_falls_back(self):
        self.registry_path.unlink()
        with self.assertRaisesRegex(ValueError, 'registry is missing'):
            consumer.schedule(self.root, ['fire'])
        self.marker.unlink()
        self.registry['projects'] = {}
        self.write_private(self.registry_path, self.registry)
        with self.assertRaisesRegex(ValueError, 'mapping is missing'):
            consumer.invoke(self.root, 'run', ['archon-lifecycle'])
        self.execute.assert_not_called()

    def test_registry_enforces_enrollment_without_marker_or_with_home_override(self):
        self.marker.unlink()
        with self.assertRaisesRegex(ValueError, 'factoryctl start'):
            consumer.invoke(self.root, 'run', ['archon-lifecycle'])
        with patch.dict(os.environ, {'ARCHON_HOME': str(self.base / 'other-home')}):
            with self.assertRaisesRegex(ValueError, 'Archon home changed'):
                consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_changed_controller_dependency_or_extra_module_fails_closed(self):
        dependency = self.controller_dir / 'controls.py'
        original = dependency.read_bytes()
        dependency.write_text('# changed dependency')
        with self.assertRaisesRegex(ValueError, 'module pin changed'):
            consumer.schedule(self.root, ['fire'])
        dependency.write_bytes(original)
        (self.controller_dir / 'new_module.py').write_text('# unexpected module')
        with self.assertRaisesRegex(ValueError, 'module inventory changed'):
            consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_config_source_consumer_and_pack_pins_are_bound(self):
        self.config_path.write_text('{"private":"do-not-echo"}')
        with self.assertRaisesRegex(ValueError, 'config pin changed') as error:
            consumer.schedule(self.root, ['fire'])
        self.assertNotIn('do-not-echo', str(error.exception))
        self.save_config()
        self.config['projects']['voice-bridge']['source_revision'] = 'b' * 40
        self.save_config()
        with self.assertRaisesRegex(ValueError, 'identity or source pins changed'):
            consumer.schedule(self.root, ['fire'])
        self.registry['projects'][str(self.root)]['source_revision'] = 'b' * 40
        self.config['projects']['voice-bridge']['consumer_sha256'] = 'f' * 64
        self.registry['projects'][str(self.root)]['consumer_sha256'] = 'f' * 64
        self.save_config()
        with self.assertRaisesRegex(ValueError, 'consumer or pack pin changed'):
            consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_registry_requires_private_canonical_files(self):
        self.registry_path.chmod(0o644)
        with self.assertRaises(ValueError):
            consumer.schedule(self.root, ['fire'])
        self.registry_path.chmod(0o600)
        self.marker.unlink()
        self.marker.symlink_to(self.registry_path)
        with self.assertRaises(ValueError):
            consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_stop_pause_preserved_and_brakes_work_with_broken_registry(self):
        for name in ('.factory/STOP', consumer.PAUSE):
            path = self.root / name
            path.write_text('existing owner brake')
            self.assertEqual(consumer.schedule(self.root, ['fire']), 0)
            self.assertEqual(path.read_text(), 'existing owner brake')
            path.unlink()
        self.registry_path.unlink()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(consumer.invoke(self.root, 'halt', []), 0)
            self.assertEqual(consumer.invoke(self.root, 'pause', []), 0)
        self.assertTrue((self.root / '.factory/STOP').exists())
        self.assertTrue((self.root / consumer.PAUSE).exists())
        self.execute.assert_not_called()

    def test_enrolled_read_only_get_preserves_pinned_native_inspection(self):
        with patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base,
                            cli=lambda *_: ['native-read']):
            self.assertEqual(consumer.invoke(self.root, 'get', ['exact-run']), 0)
        self.assertEqual(self.execute.call_args.args[0], ['native-read', 'workflow', 'get', '--cwd', str(self.root), 'exact-run'])

    def test_enrolled_wake_sweep_and_direct_bound_dispatch_are_withheld(self):
        with self.assertRaisesRegex(ValueError, 'wake is withheld'):
            consumer.schedule(self.root, ['wake'])
        self.assertEqual(consumer.sweep_stuck(self.root, {}, self.base, [{'id': 'stale', 'status': 'pending'}], lambda _: None), set())
        with self.assertRaisesRegex(ValueError, 'schedule-tick'):
            consumer.dispatch_bound_trigger(self.root, {}, self.base, self.root / 'unused', {}, lambda _: None)
        self.execute.assert_not_called()

    def test_unenrolled_global_wake_cannot_resume_enrolled_roots(self):
        other = self.base / 'unenrolled'
        other.mkdir()
        with closing(sqlite3.connect(self.archon / 'archon.db')) as db:
            db.execute('CREATE TABLE remote_agent_codebases(default_cwd TEXT)')
            db.executemany('INSERT INTO remote_agent_codebases VALUES(?)', [(str(self.root),), (str(other),)])
            db.commit()
        self.assertFalse(consumer.wake_allowed(other, self.base, lambda _: None))
        self.execute.assert_not_called()

    def test_enrolled_fire_rejects_native_flags_or_supplied_target(self):
        for flags in (['--input', 'target=anything'], ['--apply'], ['--', 'arbitrary target']):
            with self.assertRaisesRegex(ValueError, 'no native arguments or target'):
                consumer.schedule(self.root, ['fire', *flags])
        self.execute.assert_not_called()

    def test_git_redirects_cannot_hide_enrollment_before_any_git_call(self):
        for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL'):
            with self.subTest(key=key), patch.dict(os.environ, {key: ''}):
                for operation in (consumer.project_root,
                                  lambda: consumer.invoke(self.root, 'run', ['archon-lifecycle']),
                                  lambda: consumer.schedule(self.root, ['fire'])):
                    with self.assertRaisesRegex(ValueError, 'Git environment redirects'):
                        operation()
        self.execute.assert_not_called()

    def test_harmless_git_environment_does_not_block_shared_route(self):
        with patch.dict(os.environ, {'GIT_PAGER': 'cat', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'}):
            self.assertEqual(consumer.schedule(self.root, ['fire']), 0)
        self.assertEqual(self.execute.call_args.args[0][-2:], ['schedule-tick', 'voice-bridge'])

    def test_enrolled_manual_inspection_refuses_native_dotenv_redirects(self):
        (self.root / '.archon').mkdir()
        (self.root / '.archon/.env').write_text('ARCHON_HOME=/private-do-not-echo\n')
        with self.assertRaisesRegex(ValueError, 'Registry redirect keys') as error:
            consumer.invoke(self.root, 'get', ['exact-run'])
        self.assertNotIn('/private-do-not-echo', str(error.exception))
        self.execute.assert_not_called()

    def test_known_config_worktree_cannot_hide_missing_root_mapping(self):
        worktree = self.base / 'registered-worktree'
        worktree.mkdir()
        self.marker.unlink()
        self.registry['projects'].clear()
        for key in ('registered_root', 'consumer_root'):
            self.config['projects']['voice-bridge'][key] = str(worktree)
        self.save_config()
        with patch.object(consumer, 'shared_root', return_value=self.root), \
                self.assertRaisesRegex(ValueError, 'mapping is missing'):
            consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()

    def test_enrolled_install_keeps_pause_and_native_binding_and_has_no_wake(self):
        pause = self.root / consumer.PAUSE
        pause.write_text('keep paused')
        trigger = self.root / consumer.TRIGGER
        trigger.write_text('original native binding, preserve only')
        with patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base,
                            cli=lambda *_: ['native']), patch.object(consumer.sys, 'platform', 'darwin'), \
                patch.object(consumer, 'configure_launchd') as configure, redirect_stdout(io.StringIO()):
            self.assertEqual(consumer.schedule(self.root, ['install', '--apply']), 0)
        plan = configure.call_args.args[1]
        self.assertEqual(len(plan['launchd']), 1)
        job = plistlib.loads(next(iter(plan['launchd'].values())).encode())
        self.assertEqual(job['ProgramArguments'][-2:], ['schedule', 'fire'])
        self.assertFalse(job['RunAtLoad'])
        self.assertEqual(job['StartInterval'], 600)
        self.assertTrue(plan['retire'][0].name.endswith('.wake.plist'))
        self.assertEqual(pause.read_text(), 'keep paused')
        self.assertEqual(trigger.read_text(), 'original native binding, preserve only')
        self.execute.assert_not_called()

    def test_enrolled_install_rejects_parallel_schedule(self):
        (self.root / consumer.SCHEDULE).write_text(json.dumps({'parallel': 2}))
        with patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base,
                            cli=lambda *_: ['native']), self.assertRaisesRegex(ValueError, 'exactly one project slot'):
            consumer.schedule(self.root, ['install', '--apply'])
        self.execute.assert_not_called()

    def test_enrolled_mac_timer_uses_verified_worktree_consumer_not_common_checkout(self):
        common = self.base / 'main-checkout'
        (common / '.factory').mkdir(parents=True)
        (common / 'factory').mkdir()
        (common / 'factory/consumer.py').write_text('unchecked legacy consumer')
        self.registry['projects'][str(common)] = self.registry['projects'].pop(str(self.root))
        self.save_config()
        with patch.object(consumer, 'shared_root', return_value=common), \
                patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base, cli=lambda *_: ['native']), \
                patch.object(consumer.sys, 'platform', 'darwin'), patch.object(consumer, 'configure_launchd') as configure, redirect_stdout(io.StringIO()):
            self.assertEqual(consumer.schedule(self.root, ['install']), 0)
        job = plistlib.loads(next(iter(configure.call_args.args[1]['launchd'].values())).encode())
        self.assertEqual(job['ProgramArguments'][1], str(self.root / 'factory/consumer.py'))
        self.assertEqual(job['WorkingDirectory'], str(self.root))
        self.assertEqual(job['StandardOutPath'], str(common / '.factory/schedule.log'))
        self.assertIn(hashlib.sha256(str(common).encode()).hexdigest(), job['Label'])

    def test_enrolled_install_hashes_exact_timer_consumer_and_pack_on_every_platform(self):
        for platform in ('darwin', 'linux', 'win32'):
            for name in ('consumer.py', 'pack.json'):
                path = self.root / 'factory' / name
                original = path.read_bytes()
                path.write_bytes(b'unchecked scheduled file')
                with self.subTest(platform=platform, name=name), \
                        patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: self.base, cli=lambda *_: ['native']), \
                        patch.object(consumer.sys, 'platform', platform), \
                        self.assertRaisesRegex(ValueError, 'timer.*pin'):
                    consumer.schedule(self.root, ['install'])
                path.write_bytes(original)
        self.execute.assert_not_called()

    def test_enrolled_fire_cannot_dispatch_while_install_owns_shared_lock(self):
        with consumer.single_flight(self.root / '.factory/fire.lock') as held:
            self.assertTrue(held)
            self.assertEqual(consumer.schedule(self.root, ['fire']), 0)
        self.execute.assert_not_called()

    def test_enrolled_fire_holds_shared_lock_through_dispatch_and_rechecks_pending(self):
        def dispatch(*args, **kwargs):
            with consumer.single_flight(self.root / '.factory/fire.lock') as held:
                self.assertFalse(held, 'installation must not overlap shared dispatch')
            return subprocess.CompletedProcess([], 0)
        self.execute.side_effect = dispatch
        self.assertEqual(consumer.schedule(self.root, ['fire']), 0)
        self.execute.reset_mock()
        with patch.object(consumer, 'verify_registry_environment',
                          side_effect=lambda _: (self.root / consumer.SCHEDULE_INSTALL_PENDING).write_text('{}')):
            with self.assertRaisesRegex(ValueError, 'installation is incomplete'):
                consumer.schedule(self.root, ['fire'])
        self.execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
