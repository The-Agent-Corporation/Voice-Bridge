"""Schedule previews preserve bindings; Linux units preserve literal host paths."""
from contextlib import ExitStack, contextmanager, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'install_consumer', Path(__file__).resolve().parents[1] / 'factory/consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class ScheduleInstallTests(unittest.TestCase):
    @contextmanager
    def project(self, platform='linux'):
        with tempfile.TemporaryDirectory(prefix='factory-install-') as folder, ExitStack() as stack:
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
                    if path.parent == binding.parent and mode in ('w', 'x'):
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
