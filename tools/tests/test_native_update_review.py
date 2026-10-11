import copy
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import update_mods as updater
import select_mod_builds as selector


class NativeReviewTests(unittest.TestCase):
    def test_partial_update_keeps_entire_blocked_mod_and_its_merge_bases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            game = root / 'game'
            game.mkdir()

            def git(*args):
                return subprocess.check_output(['git', '-C', str(game), *args]).decode().strip()

            git('init', '-q')
            git('config', 'user.name', 'Predi-i')
            git('config', 'user.email', 'Predi-i@users.noreply.github.com')
            (game / 'a.css').write_text('.native { opacity: 1; }\n')
            (game / 'gone.xml').write_text('<root />\n')
            git('add', '.')
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            (game / 'a.css').write_text('.native { opacity: 0.9; }\n')
            (game / 'gone.xml').unlink()
            git('add', '.')
            git('commit', '-qm', 'new')
            revision = git('rev-parse', 'HEAD')
            entries = []
            for path, native in (('good/a.css', 'a.css'), ('bad/a.css', 'a.css'), ('bad/gone.xml', 'gone.xml')):
                target = root / path
                target.parent.mkdir(exist_ok=True)
                target.write_text('<root />\n' if path.endswith('xml') else '.native { opacity: 1; }\n')
                entries.append({'path': path, 'upstream': native, 'base': base, 'mode': 'copy'})
            manifest = {'files': entries}
            original = copy.deepcopy(manifest)
            with patch.object(updater, 'ROOT', root):
                with self.assertRaises(ValueError):
                    updater.plan(game, manifest, revision)
                self.assertEqual(manifest, original)
                result = updater.plan(game, manifest, revision, allow_partial=True)
                self.assertEqual(set(result), {root / 'good/a.css'})
                self.assertEqual(entries[0]['base'], revision)
                self.assertEqual(entries[1]['base'], base)
                self.assertEqual(entries[2]['base'], base)
                self.assertIn('removed', entries[2]['pending']['reason'])
                repeated = updater.plan(game, manifest, revision, allow_partial=True)
                self.assertNotIn(root / 'bad/a.css', repeated)
                self.assertIn('pending', entries[2])
                entries[2]['mode'] = 'retired'
                resolved = updater.plan(game, manifest, revision, allow_partial=True)
                self.assertIn(root / 'bad/a.css', resolved)
                self.assertNotIn('pending', entries[2])
                self.assertEqual((root / 'bad/gone.xml').read_text(), '<root />\n')

    def test_blocked_variant_excludes_pair_and_preserves_publication_checkpoint(self):
        current = selector.select({})
        previous = dict(current['hashes'])
        for name in selector.NICKNAMES:
            previous[name] = 'last-published'
        result = selector.select(previous, force=True, blocked=['Show-Nicknames-In-TopBar'])
        self.assertFalse(result['nicknames'])
        self.assertFalse(selector.NICKNAMES.intersection(result['mods']))
        for name in selector.NICKNAMES:
            self.assertEqual(result['hashes'][name], 'last-published')
        self.assertTrue(selector.NICKNAMES.issubset(selector.select(result['hashes'])['mods']))

    def test_extension_requires_import_and_tracked_native_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            target = root / 'mod/panorama/styles/native.css'
            target.parent.mkdir(parents=True)
            target.write_text('@import url("s2r://panorama/styles/base/native.vcss_c");\n.mod {}\n')
            base = target.parent / 'base/native.css'
            base.parent.mkdir()
            base.write_text('old')
            manifest = {'files': [
                {'path': target.relative_to(root).as_posix(), 'upstream': 'native.css', 'base': 'old', 'mode': 'extension'},
                {'path': base.relative_to(root).as_posix(), 'upstream': 'native.css', 'base': 'old', 'mode': 'copy'}]}
            response = MagicMock(returncode=0, stdout=b'new')
            with patch.object(updater, 'ROOT', root), patch.object(updater.subprocess, 'run', return_value=response):
                self.assertEqual(updater.plan(root, manifest, 'new'), {base: 'new'})
                target.write_text('/* @import url("s2r://panorama/styles/base/native.vcss_c"); */\n.owned {}')
                with self.assertRaisesRegex(ValueError, 'base import'):
                    updater.plan(root, manifest, 'next')

    def test_clean_text_merge_cannot_change_mod_insertion_context(self):
        middle = ''.join(f'<Panel id="s{i}" />\n' for i in range(10))
        base = '<root>\n<Panel id="anchor">\n' + middle + '</Panel>\n</root>\n'
        local = base.replace('</Panel>', '<Panel id="mod" />\n</Panel>')
        native = base.replace('id="anchor"', 'id="anchor" class="changed"')
        with self.assertRaisesRegex(ValueError, 'insertion parent changed'):
            updater.merge_xml(local, base, native)

    def test_retired_resource_reappearance_blocks_its_mod(self):
        manifest = {'files': [{'path': 'mod/legacy.xml', 'upstream': 'legacy.xml', 'base': 'old', 'mode': 'retired'}]}
        response = MagicMock(returncode=0, stdout=b'<root />')
        with patch.object(updater.subprocess, 'run', return_value=response):
            result = updater.plan(pathlib.Path('.'), manifest, 'new', allow_partial=True)
        self.assertEqual(result, {})
        self.assertIn('reappeared', manifest['files'][0]['pending']['reason'])
        self.assertEqual(manifest['files'][0]['base'], 'old')


if __name__ == '__main__':
    unittest.main()
