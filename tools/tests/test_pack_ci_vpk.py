import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import pack_ci_vpk

try:
    import vpk
except ImportError:
    vpk = None


@unittest.skipIf(vpk is None, "Install vpk==1.4.0 for package integration tests")
class PackTests(unittest.TestCase):
    def test_mixed_resources_round_trip_and_detect_changed_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "resources"
            for name in ("panorama/scripts/test.vjs_c", "sounds/mods/alarm.vsnd_c",
                         "soundevents/test.vsndevts_c", "panorama/html/bridge.html"):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bytes(range(256)) * 8)
            output = root / "mod.vpk"
            self.assertEqual(4, pack_ci_vpk.pack(source, output))
            archive = vpk.open(str(output))
            self.assertEqual(2, archive.version)
            self.assertTrue(archive.verify())
            (source / "panorama/scripts/test.vjs_c").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "differs from compiler output"):
                pack_ci_vpk.verify_contents(archive, source)
            (source / "extra.txt").write_bytes(b"unexpected")
            with self.assertRaisesRegex(ValueError, "paths differ"):
                pack_ci_vpk.verify_contents(archive, source)
            with self.assertRaisesRegex(ValueError, "existing package"):
                pack_ci_vpk.pack(source, output)

    def test_empty_input_and_output_inside_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            with self.assertRaisesRegex(ValueError, "missing or empty"):
                pack_ci_vpk.pack(root, root.parent / "unused.vpk")
            (root / "file.vcss_c").write_bytes(b"test")
            with self.assertRaisesRegex(ValueError, "outside"):
                pack_ci_vpk.pack(root, root / "mod.vpk")


if __name__ == "__main__":
    unittest.main()
