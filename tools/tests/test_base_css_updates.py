import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import base_css_updates as css


class BaseCssTests(unittest.TestCase):
    def fixture(self):
        catalog = {'paired': {'sources': ['mod', 'variant']}, 'xml': {'sources': ['other']}}
        files = [
            {'path': 'mod/panorama/styles/base/a.css', 'mode': 'copy', 'upstream': 'a.css', 'base': 'old'},
            {'path': 'variant/panorama/styles/base/a.css', 'mode': 'copy', 'upstream': 'a.css', 'base': 'old'},
            {'path': 'mod/panorama/styles/a.css', 'mode': 'extension', 'upstream': 'a.css', 'base': 'old'},
            {'path': 'variant/panorama/layout/a.xml', 'mode': 'merge', 'upstream': 'a.xml', 'base': 'old'},
            {'path': 'other/panorama/layout/a.xml', 'mode': 'merge', 'upstream': 'a.xml', 'base': 'old'},
        ]
        changes = [{'path': entry['path'], 'status': 'updated'} for entry in files if entry['mode'] in ('copy', 'extension')]
        return catalog, {'files': files}, {'changes': changes}

    def test_pair_selected_together_and_custom_xml_or_pending_variant_block_both(self):
        catalog, manifest, summary = self.fixture()
        dirty = ['mod/panorama/styles/base/a.css', 'variant/panorama/styles/base/a.css']
        self.assertEqual(css.select(summary, manifest, dirty, catalog), ['paired'])
        self.assertEqual(css.select(summary, manifest, dirty + ['variant/panorama/layout/a.xml'], catalog), [])
        manifest['files'][3]['pending'] = {'reason': 'conflict'}
        self.assertEqual(css.select(summary, manifest, dirty, catalog), [])

    def test_native_xml_change_blocks_auto_accept_even_when_merge_leaves_source_unchanged(self):
        catalog, manifest, summary = self.fixture()
        summary['changes'].append({'path': 'variant/panorama/layout/a.xml', 'status': 'updated'})
        self.assertEqual(css.select(summary, manifest, ['mod/panorama/styles/base/a.css'], catalog), [])

    def test_css_preview_cannot_stage_commit_or_push(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            catalog, manifest, summary = self.fixture()
            (root / 'tools').mkdir()
            (root / css.MANIFEST).write_text(json.dumps(manifest))
            output = root / 'report'
            output.mkdir()
            (output / 'summary.json').write_text(json.dumps(summary))
            with patch.object(css, 'ROOT', root), patch.object(css, 'CATALOG', catalog), patch.object(css, 'git', return_value=b'mod/panorama/styles/base/a.css\n') as git:
                result = css.accept(output, dry_run=True)
            self.assertEqual(result['commit'], '')
            git.assert_called_once_with('diff', '--name-only')

    def test_css_and_xml_proposals_split_without_committing_other_sources_or_tracking(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder) / 'work'
            origin = pathlib.Path(folder) / 'origin.git'
            subprocess.run(['git', 'init', '--bare', '-q', str(origin)], check=True)
            root.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'Predi-i')
            git('config', 'user.email', 'Predi-i@users.noreply.github.com')
            catalog, manifest, summary = self.fixture()
            (root / 'tools').mkdir()
            for entry in manifest['files']:
                path = root / entry['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('old', encoding='utf-8')
            (root / css.MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n')
            git('add', '.')
            git('commit', '-qm', 'base')
            git('remote', 'add', 'origin', str(origin))
            git('push', '-q', '-u', 'origin', 'main')
            original = copy.deepcopy(manifest)
            for entry in manifest['files']:
                if entry['mode'] in ('copy', 'extension') or entry['path'].startswith('other/'):
                    entry['base'] = 'new'
            for entry in manifest['files']:
                if entry['mode'] == 'copy' or entry['path'].startswith('other/'):
                    (root / entry['path']).write_text('new', encoding='utf-8')
            summary.update(revision='native-revision', changed=True)
            summary['changes'].append({'path': 'other/panorama/layout/a.xml', 'status': 'updated'})
            for item in summary['changes']:
                item['source_sha256'] = hashlib.sha256((root / item['path']).read_bytes()).hexdigest()
            (root / css.MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n')
            output = root / 'report'
            output.mkdir()
            (output / 'summary.json').write_text(json.dumps(summary))
            with patch.object(css, 'ROOT', root), patch.object(css, 'CATALOG', catalog), patch.object(css, 'hashes', return_value={'mod': 'verified'}):
                result = css.accept(output)
                self.assertTrue(css.attested('paired', {'mod': 'verified'}))
                self.assertFalse(css.attested('paired', {'mod': 'different'}))
            self.assertEqual(result['mods'], ['paired'])
            committed = json.loads(git('show', 'HEAD:' + css.MANIFEST))
            self.assertEqual(committed['files'][-1], original['files'][-1])
            self.assertEqual(committed['files'][0]['base'], 'new')
            self.assertEqual(git('show', 'HEAD:other/panorama/layout/a.xml'), 'old')
            self.assertEqual((root / 'other/panorama/layout/a.xml').read_text(), 'new')
            self.assertEqual(json.loads((root / css.MANIFEST).read_text()), manifest)
            remaining = json.loads((output / 'summary.json').read_text())
            self.assertEqual([item['path'] for item in remaining['changes']], ['other/panorama/layout/a.xml'])

    def test_delta_uses_last_gb_baseline_and_catches_older_unpublished_xml(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
            git('init', '-q')
            git('config', 'user.name', 'Predi-i')
            git('config', 'user.email', 'Predi-i@users.noreply.github.com')
            catalog, manifest, _ = self.fixture()
            for entry in manifest['files']:
                path = root / entry['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('old')
            git('add', '.')
            git('commit', '-qm', 'GB baseline')
            base = git('rev-parse', 'HEAD')
            (root / manifest['files'][0]['path']).write_text('new')
            git('add', '.')
            git('commit', '-qm', 'CSS only')
            current = git('rev-parse', 'HEAD')
            with patch.object(css, 'ROOT', root):
                self.assertTrue(css.css_delta(base, current, catalog['paired']['sources'], manifest)[0])
            (root / 'variant/panorama/layout/a.xml').write_text('unreviewed XML')
            git('add', '.')
            git('commit', '-qm', 'XML before next CSS update')
            (root / manifest['files'][0]['path']).write_text('newer CSS')
            git('add', '.')
            git('commit', '-qm', 'CSS again')
            with patch.object(css, 'ROOT', root):
                self.assertFalse(css.css_delta(base, 'HEAD', catalog['paired']['sources'], manifest)[0])


if __name__ == '__main__':
    unittest.main()
