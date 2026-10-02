import copy
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

TOOLS = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater = load("update_mods")
selector = load("select_mod_builds")
uploader = load("gb_upload")
assets = load("prepare_ci_assets")


class UpdaterTests(unittest.TestCase):
    def test_ci_prepares_textures_and_preserves_raw_html(self):
        with tempfile.TemporaryDirectory() as folder:
            content = pathlib.Path(folder) / "content"
            game = pathlib.Path(folder) / "game"
            content.mkdir()
            (content / "image.png").write_bytes(b"fixture image")
            (content / "custom.png").write_bytes(b"fixture image")
            (content / "custom.vtex").write_text('"m_algorithm" "string" "LegacyProcessor"')
            (content / "bridge.html").write_text('<html>bridge</html>')
            assets.prepare(content, game)
            self.assertIn('"image.png"', (content / "image.vtex").read_text())
            self.assertEqual((content / "custom.vtex").read_text(), '"m_algorithm" "string" ""')
            self.assertEqual((game / "bridge.html").read_text(), '<html>bridge</html>')

    def test_nonoverlapping_edits_and_conflict(self):
        middle = "\n".join(str(i) for i in range(10)) + "\n"
        self.assertEqual(updater.merge("MOD\n" + middle + "end\n", "start\n" + middle + "end\n",
                                       "start\n" + middle + "NEW\n"), "MOD\n" + middle + "NEW\n")
        with self.assertRaises(ValueError):
            updater.merge("MOD\n", "old\n", "NEW\n")

    def test_compiled_references_are_normalized_without_doubling(self):
        self.assertEqual(updater.normalize('<include src="x.vts" />\r\n<img src="x.vtex" />'),
                         '<include src="x.vts_c" />\n<img src="x.vtex" />')
        self.assertEqual(updater.normalize('"x.vcss_c"'), '"x.vcss_c"')

    def test_plan_is_atomic_and_advances_bases_after_native_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            game = root / "game"
            game.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(game), *args]).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Predi-i")
            git("config", "user.email", "Predi-i@users.noreply.github.com")
            native = game / "native.xml"
            middle = "<Panel />\n" * 10
            native.write_text("<root>\n<Panel />\n" + middle + "</root>\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            target = root / "mod.xml"
            target.write_text("<root>\n<Panel />\n" + middle + "<!-- MOD -->\n</root>\n")
            native.write_text('<root>\n<Panel id="new" />\n' + middle + '</root>\n')
            git("add", ".")
            git("commit", "-qm", "new")
            revision = git("rev-parse", "HEAD")
            manifest = {"files": [{"path": "mod.xml", "upstream": "native.xml", "base": base, "mode": "merge"}]}
            before = target.read_bytes()
            with patch.object(updater, "ROOT", root):
                result = updater.plan(game, copy.deepcopy(manifest), revision)
                self.assertIn('id="new"', result[target])
                self.assertIn('<!-- MOD -->', result[target])
                self.assertEqual(target.read_bytes(), before)
                target.write_text("<root>\n<Conflicting />\n</root>\n")
                before = target.read_bytes()
                with self.assertRaises(ValueError):
                    updater.plan(game, copy.deepcopy(manifest), revision)
                self.assertEqual(target.read_bytes(), before)

    def test_failed_publication_is_retried_and_nickname_pair_is_built(self):
        result = selector.select({})
        self.assertTrue(result["nicknames"])
        self.assertTrue(selector.NICKNAMES.issubset(result["mods"]))
        self.assertEqual(selector.select(result["hashes"])["mods"], [])
        previous = dict(result["hashes"])
        previous["Show-Nicknames-In-TopBar"] = "old"
        self.assertEqual(set(selector.select(previous)["mods"]), selector.NICKNAMES)


class UploadTests(unittest.TestCase):
    def test_ai_matrix_uses_live_names_values_and_maintainer_choices(self):
        html = '<table><tr><th>Mod Area</th><th>N/A This area is not part</th><th>None No AI was used</th><th>Minor Limited assistance</th></tr>'
        for area in ("Code", "Textures", "Audio", "Models"):
            html += '<tr><th>' + area + '</th>'
            for value in ("not-applicable", "no", "some"):
                html += f'<td><input type="radio" name="hash[{area}]" value="{value}"></td>'
            html += '</tr>'
        html += '</table>'
        instance = uploader.GameBananaUploader.__new__(uploader.GameBananaUploader)
        fields = instance._ai_usage_fields(uploader.BeautifulSoup(html, "html.parser"))
        self.assertEqual(dict(fields), {"hash[Code]": "some", "hash[Textures]": "no",
                                       "hash[Audio]": "no", "hash[Models]": "no"})
        with self.assertRaises(RuntimeError):
            instance._ai_usage_fields(uploader.BeautifulSoup("<form />", "html.parser"))


if __name__ == "__main__":
    unittest.main()
