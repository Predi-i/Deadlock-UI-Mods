import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import package_releases as releases


class ReleaseTests(unittest.TestCase):
    def test_bridge_variants_only_change_alert_in_copy(self):
        original = (releases.ROOT / "Bridge-Buff-Reminder/panorama/scripts/buff_reminder.js").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            for item in releases.release_plan(["Bridge-Buff-Reminder"]):
                source = releases.prepare_source(item, pathlib.Path(directory))
                result = (source / "panorama/scripts/buff_reminder.js").read_text()
                self.assertIn(f"FIRST_ALERT: {item['first_alert']},", result)
                self.assertIn("INTERVAL: 300,", result)
                self.assertTrue((source / "sounds/mods/buff_alarm.wav").is_file())
        self.assertEqual(original, (releases.ROOT / "Bridge-Buff-Reminder/panorama/scripts/buff_reminder.js").read_bytes())

    def test_missing_or_ambiguous_alert_fails(self):
        for source in ("", "FIRST_ALERT: 290,\nFIRST_ALERT: 290,"):
            with self.assertRaises(ValueError):
                releases.set_bridge_time(source, 270)

    def test_zip_has_one_root_file_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "fixture.bin"
            source.write_bytes(bytes(range(256)) * 20)
            destination = root / "release.zip"
            releases.archive_vpk(source, destination)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual([source.name], archive.namelist())
                self.assertEqual(source.read_bytes(), archive.read(source.name))
            self.assertFalse(destination.with_suffix(".zip.tmp").exists())
            source.write_bytes(b"")
            with self.assertRaises(ValueError):
                releases.archive_vpk(source, destination)

    def test_selection_assets_only_and_paired_nicknames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
            git("init")
            git("config", "user.name", "Release Test")
            git("config", "user.email", "release@example.invalid")
            (root / "initial.txt").write_text("initial")
            git("add", ".")
            git("commit", "-m", "initial")
            for path in ("Show-Nicknames-In-TopBar/panorama/layout/a.xml",
                         "HUD-Dumper/panorama/layout/a.xml", "Parry-Cooldown/README.md"):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture")
            self.assertEqual(sorted(releases.NICKNAMES), releases.changed_mods("2000-01-01", root))


if __name__ == "__main__":
    unittest.main()
