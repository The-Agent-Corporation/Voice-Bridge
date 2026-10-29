"""Mutation evidence and writes must stay within disposable candidates."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('mutation_safety_runner',
    Path(__file__).parent / 'mutations/run.py')
mutations = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mutations)


class MutationSafetyTests(unittest.TestCase):
    def test_source_check_infrastructure_error_is_inconclusive(self):
        verdict = mutations.classify(1, 'Source checks failed: report missing\nGATE_FAILED: unit\n')
        self.assertEqual(verdict.outcome, 'INCONCLUSIVE')

    def test_apply_refuses_checkout_and_nested_checkout_without_writing(self):
        for marker in ('directory', 'worktree-file'):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if marker == 'directory':
                    (root / '.git').mkdir()
                else:
                    (root / '.git').write_text('gitdir: /not-used')
                for candidate in (root, root / 'nested'):
                    candidate.mkdir(exist_ok=True)
                    target = candidate / 'fixture.txt'
                    target.write_text('original')
                    injected, reason = mutations.apply(candidate, {
                        'file': 'fixture.txt', 'find': 'original', 'replace': 'mutated'})
                    self.assertFalse(injected)
                    self.assertIn('disposable', reason)
                    self.assertEqual(target.read_text(), 'original')

    def test_apply_refuses_its_own_source_copy_without_git_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'harness/mutations').mkdir(parents=True)
            target = root / 'fixture.txt'
            target.write_text('original')
            from unittest.mock import patch
            with patch.object(mutations, 'HERE', root / 'harness/mutations'):
                injected, reason = mutations.apply(root, {
                    'file': 'fixture.txt', 'find': 'original', 'replace': 'mutated'})
            self.assertFalse(injected)
            self.assertIn('disposable', reason)
            self.assertEqual(target.read_text(), 'original')

    def test_external_disposable_copy_changes_only_unique_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'fixture.txt'
            target.write_text('original')
            injected, reason = mutations.apply(root, {
                'file': 'fixture.txt', 'find': 'original', 'replace': 'mutated'})
            self.assertTrue(injected, reason)
            self.assertEqual(target.read_text(), 'mutated')

    def test_apply_refuses_nested_git_target_inside_disposable_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'nested/.git').mkdir(parents=True)
            target = root / 'nested/fixture.txt'
            target.write_text('original')
            injected, reason = mutations.apply(root, {
                'file': 'nested/fixture.txt', 'find': 'original', 'replace': 'mutated'})
            self.assertFalse(injected)
            self.assertIn('disposable', reason)
            self.assertEqual(target.read_text(), 'original')
