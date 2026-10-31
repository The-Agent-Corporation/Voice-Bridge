"""Schedule previews preserve bindings; Linux units preserve literal host paths."""
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'install_consumer', Path(__file__).resolve().parents[1] / 'factory/consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class ScheduleInstallTests(unittest.TestCase):
    def test_git_hook_environment_is_isolated_and_restored(self):
        inherited = {'GIT_DIR': '/unrelated-hook.git', 'GIT_INDEX_FILE': '/unrelated-index'}
        with patch.dict(os.environ, inherited):
            with self.project() as (root, _, commands, __):
                self.assertEqual(consumer.schedule(root, ['install']), 0)
                self.assertEqual(commands, [])
            self.assertEqual({key: os.environ[key] for key in inherited}, inherited)

    @contextmanager
    def project(self, platform='linux'):
        with tempfile.TemporaryDirectory(prefix='factory-install-') as folder, ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ,
                {key: value for key, value in os.environ.items() if not key.startswith('GIT_')
                 and key not in {'DATABASE_URL', 'ARCHON_DOCKER', 'WORKSPACE_PATH'}}, clear=True))
            root = Path(folder) / 'project'
            root.mkdir()
            home = Path(folder) / 'home'
            home.mkdir()
            (root / 'harness').mkdir()
            (root / 'harness/harness.config.json').write_text(json.dumps({
                'required_checks': 'ci', 'protected_paths': 'harness/**'}))
            (root / '.factory').mkdir()
            (root / consumer.SCHEDULE).write_text(json.dumps({
                'workflow': 'archon-lifecycle', 'inputs': {}}))
            stack.enter_context(patch.object(consumer.sys, 'platform', platform))
            stack.enter_context(patch.object(consumer.Path, 'home', return_value=home))
            stack.enter_context(patch.multiple(consumer, read_settings=lambda _: {},
                verify_source=lambda _: root, shared_root=lambda _: root,
                cli=lambda *_: ['native'], archon_home=lambda: home,
                default_admission_home=lambda: home,
                discover=lambda *_: {'archon-lifecycle': root},
                repository_slug=lambda _: 'owner/repository', whoami=lambda *_: 'operator',
                base_branch=lambda *_: 'main'))
            # Only the external OS scheduler command is replaced; config generation and
            # all filesystem effects are real and confined to these temporary roots.
            commands = []
            stack.enter_context(patch.object(consumer, 'checked',
                side_effect=lambda argv, *_: commands.append(argv) or ''))
            stack.enter_context(patch.object(consumer, 'execute',
                side_effect=AssertionError('preview must not query or run the scheduler')))
            output = stack.enter_context(redirect_stdout(io.StringIO()))
            yield root, home, commands, output

    def test_preview_preserves_existing_binding_and_scheduler_files(self):
        for platform in ('linux', 'darwin', 'win32'):
            with self.subTest(platform=platform), self.project(platform) as (root, home, commands, output):
                binding = root / consumer.TRIGGER
                original = b'{"installed": "keep these exact bytes"}\n'
                binding.write_bytes(original)
                before = binding.stat().st_mtime_ns
                self.assertEqual(consumer.schedule(root, ['install']), 0)
                self.assertEqual(binding.read_bytes(), original)
                self.assertEqual(binding.stat().st_mtime_ns, before)
                self.assertEqual(sorted(path.relative_to(root) for path in root.rglob('*') if path.is_file()),
                                 [Path('.factory/schedule.json'), Path('.factory/trigger.json'),
                                  Path('harness/harness.config.json')])
                self.assertEqual(list(home.rglob('*')), [])
                self.assertEqual(commands, [])
                self.assertIn('Would write', output.getvalue())
                self.assertNotIn('Wrote ', output.getvalue())

    def test_preview_does_not_create_binding(self):
        with self.project() as (root, home, commands, _):
            self.assertEqual(consumer.schedule(root, ['install']), 0)
            self.assertFalse((root / consumer.TRIGGER).exists())
            self.assertEqual(list(home.rglob('*')), [])
            self.assertEqual(commands, [])

    def test_apply_persists_generated_binding_and_linux_units(self):
        with self.project() as (root, home, commands, output):
            self.assertEqual(consumer.schedule(root, ['install', '--apply']), 0)
            binding = json.loads((root / consumer.TRIGGER).read_text())
            self.assertEqual(binding['binding']['launch']['workflowName'], 'archon-lifecycle')
            self.assertEqual(binding['binding']['launch']['inputs']['required_checks'], 'ci')
            directory = home / '.config/systemd/user'
            self.assertTrue((directory / 'archonfactory-project.service').is_file())
            self.assertTrue((directory / 'archonfactory-project.timer').is_file())
            self.assertEqual(commands, [['systemctl', '--user', 'daemon-reload'],
                ['systemctl', '--user', 'enable', '--now', 'archonfactory-project.timer']])
            self.assertIn('Wrote ', output.getvalue())

    def test_interrupted_binding_write_preserves_previous_state_and_does_not_install(self):
        for existing in (False, True):
            with self.subTest(existing=existing), self.project() as (root, home, commands, _):
                binding = root / consumer.TRIGGER
                original = b'{"installed": "keep exact bytes"}\n'
                if existing:
                    binding.write_bytes(original)
                real_open = Path.open

                class InterruptedWrite:
                    def __init__(self, stream):
                        self.stream = stream
                    def __enter__(self):
                        return self
                    def __exit__(self, *args):
                        return self.stream.__exit__(*args)
                    def __getattr__(self, name):
                        return getattr(self.stream, name)
                    def write(self, text):
                        self.stream.write(text[:max(1, len(text) // 2)])
                        self.stream.flush()
                        raise OSError('interrupted binding write')

                def interrupt(path, mode='r', *args, **kwargs):
                    stream = real_open(path, mode, *args, **kwargs)
                    if path.parent == binding.parent and path.name.startswith(binding.name + '.') and mode in ('w', 'x'):
                        return InterruptedWrite(stream)
                    return stream

                with patch.object(Path, 'open', interrupt), self.assertRaisesRegex(OSError, 'interrupted'):
                    consumer.schedule(root, ['install', '--apply'])
                self.assertEqual(binding.exists(), existing)
                if existing:
                    self.assertEqual(binding.read_bytes(), original)
                self.assertEqual(list(binding.parent.glob('*.tmp')), [])
                self.assertEqual(list(home.rglob('*')), [])
                self.assertEqual(commands, [])

    def test_guard_sync_failure_preserves_binding_before_installation(self):
        with self.project() as (root, home, commands, _):
            binding = root / consumer.TRIGGER
            original = b'{"installed": "original"}\n'
            binding.write_bytes(original)
            real_fsync = os.fsync
            def fail_directory_sync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError('synthetic guard sync failure')
                return real_fsync(fd)
            with patch.object(consumer.os, 'fsync', fail_directory_sync), \
                    self.assertRaisesRegex(OSError, 'guard sync failure'):
                consumer.schedule(root, ['install', '--apply'])
            self.assertEqual(binding.read_bytes(), original)
            self.assertTrue((root / '.factory/schedule-install-pending.json').exists())
            self.assertEqual(commands, [])
            self.assertEqual(list(home.rglob('*')), [])

    def test_post_replace_sync_failures_block_dispatch_until_successful_reinstall(self):
        for operation in ('open', 'fsync'):
            with self.subTest(operation=operation), self.project() as (root, home, commands, _):
                binding = root / consumer.TRIGGER
                binding.write_text('{"old": true}')
                replaced = []
                real_replace, real_open, real_fsync = os.replace, os.open, os.fsync
                def replace(source, target):
                    real_replace(source, target)
                    if target == binding:
                        replaced.append(target)
                def open_directory(path, flags, *args, **kwargs):
                    if operation == 'open' and replaced and path == binding.parent:
                        raise OSError('synthetic directory open failure')
                    return real_open(path, flags, *args, **kwargs)
                def sync(fd):
                    if operation == 'fsync' and replaced and stat.S_ISDIR(os.fstat(fd).st_mode):
                        raise OSError('synthetic directory sync failure')
                    return real_fsync(fd)
                with patch.object(consumer.os, 'replace', replace), \
                        patch.object(consumer.os, 'open', open_directory), \
                        patch.object(consumer.os, 'fsync', sync), \
                        self.assertRaisesRegex(OSError, 'synthetic directory') as raised:
                    consumer.schedule(root, ['install', '--apply'])
                self.assertEqual(replaced, [binding])
                self.assertIn('binding', json.loads(binding.read_text()))
                pending = root / '.factory/schedule-install-pending.json'
                self.assertTrue(pending.exists(), 'post-commit failure must leave a durable dispatch guard')
                self.assertIn('scheduled launches remain blocked', '\n'.join(raised.exception.__notes__))
                errors = io.StringIO()
                with patch.object(consumer, 'project_root', return_value=root), \
                        patch.object(consumer, 'invoke', side_effect=raised.exception), redirect_stderr(errors):
                    self.assertEqual(consumer.main(['schedule', 'install', '--apply']), 1)
                self.assertIn('partially committed', errors.getvalue())
                self.assertIn('scheduled launches remain blocked', errors.getvalue())
                self.assertEqual(commands, [])
                with patch.multiple(consumer, verify_registry_environment=lambda _: None,
                                    windowless=lambda: False, wake_allowed=lambda *_: True), \
                        patch.object(consumer, 'execute', return_value=type('Result', (), {'returncode': 0})()) as execute, \
                        patch.object(consumer, 'launch_decision') as launch:
                    self.assertEqual(consumer.schedule(root, ['fire']), 1)
                launch.assert_not_called()
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(execute.call_args.args[0], ['native', 'workflow', 'wake'])
                self.assertEqual(consumer.schedule(root, ['install', '--apply']), 0)
                self.assertFalse(pending.exists())
                self.assertEqual(len(commands), 2)

    def test_install_holds_launch_lock_and_keeps_guard_after_scheduler_interrupt(self):
        with self.project() as (root, home, commands, _):
            pending = root / '.factory/schedule-install-pending.json'
            def interrupted_scheduler(*_):
                self.assertTrue(pending.exists())
                with consumer.single_flight(root / '.factory/fire.lock') as held:
                    self.assertFalse(held, 'a tick must not launch during installation')
                raise KeyboardInterrupt('synthetic scheduler interruption')
            with patch.object(consumer, 'checked', side_effect=interrupted_scheduler), \
                    self.assertRaises(KeyboardInterrupt):
                consumer.schedule(root, ['install', '--apply'])
            self.assertTrue(pending.exists())
            with consumer.single_flight(root / '.factory/fire.lock') as held:
                self.assertTrue(held, 'failed installation must release the transient lock')
            self.assertEqual(consumer.schedule(root, ['install', '--apply']), 0)
            self.assertFalse(pending.exists())

    def test_install_refuses_busy_launch_lock_before_writing_binding(self):
        with self.project() as (root, home, commands, _):
            with consumer.single_flight(root / '.factory/fire.lock') as held:
                self.assertTrue(held)
                with self.assertRaisesRegex(ValueError, 'launching or installing'):
                    consumer.schedule(root, ['install', '--apply'])
            self.assertFalse((root / consumer.TRIGGER).exists())
            self.assertEqual(commands, [])
            self.assertEqual(list(home.rglob('*')), [])

    def test_linux_unit_preserves_spaces_quotes_backslashes_and_expansion_characters(self):
        # Hand-checked systemd grammar: quoted words, C escaping, %% for specifiers,
        # ':' disables ExecStart dollar expansion; Environment never expands dollars.
        root = Path('/srv/project %n ${HOME} "quoted" \\tail ')
        with patch.object(consumer.sys, 'platform', 'linux'), \
                patch.object(consumer.sys, 'executable', '/opt/python %n $PY "quoted"/bin/python'), \
                patch.dict(consumer.os.environ, {'PATH': '/opt/tool box/%n/$HOME/"q"/\\bin:/usr/bin'}):
            plan = consumer.timer_commands(root, 600)
        service = next(body for name, body in plan['systemd'].items() if name.endswith('.service'))
        self.assertIn('ExecStart=":/opt/python %%n $PY \\"quoted\\"/bin/python" '
                      '"/srv/project %%n ${HOME} \\"quoted\\" \\\\tail /factory/consumer.py" '
                      '"schedule" "fire"\n', service)
        self.assertIn('Environment="PATH=/opt/tool box/%%n/$HOME/\\"q\\"/\\\\bin:/usr/bin"\n', service)
        # WorkingDirectory does not unquote or C-unescape. The final /. keeps a real
        # trailing space/backslash in the directory name from becoming unit syntax.
        self.assertIn('WorkingDirectory=/srv/project %%n ${HOME} "quoted" \\tail /.\n', service)
        self.assertIn('EnvironmentFile=-%h/.factory-env\n', service)

    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('systemd-analyze'),
                         'requires Linux systemd-analyze for unit parser qualification')
    def test_generated_linux_units_are_accepted_by_systemd_parser(self):
        with tempfile.TemporaryDirectory(prefix='factory-systemd-') as folder:
            root = Path(folder) / 'project %n ${HOME} "quoted" \\tail '
            root.mkdir()
            (root / 'factory').mkdir()
            (root / 'factory/consumer.py').write_text('pass\n')
            with patch.dict(consumer.os.environ, {'PATH': '/opt/tool box/%n/$HOME/"q"/\\bin:/usr/bin'}):
                plan = consumer.timer_commands(root, 600)
            units = []
            for name, body in plan['systemd'].items():
                path = Path(folder) / name
                path.write_text(body)
                units.append(str(path))
            version = subprocess.check_output(['systemd-analyze', '--version'], text=True).splitlines()[0]
            result = subprocess.run(['systemd-analyze', '--man=no', 'verify', *units],
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, version + '\n' + result.stdout + result.stderr)

    def test_linux_generation_refuses_control_characters_before_binding_write(self):
        with self.project() as (root, home, commands, _), \
                patch.dict(consumer.os.environ, {'PATH': '/bin\nExecStart=/bad'}):
            with self.assertRaisesRegex(ValueError, 'control characters'):
                consumer.schedule(root, ['install', '--apply'])
            self.assertFalse((root / consumer.TRIGGER).exists())
            self.assertEqual(list(home.rglob('*')), [])
            self.assertEqual(commands, [])


if __name__ == '__main__':
    unittest.main()
