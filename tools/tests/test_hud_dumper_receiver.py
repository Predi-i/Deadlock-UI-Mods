"""Portable protocol regressions; no access to the live clipboard or game."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "HUD-Dumper" / "tools" / "save_dump.py"
SPEC = importlib.util.spec_from_file_location("hud_dump_receiver", SOURCE)
receiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receiver)


def stream():
    records = [
        {"kind": "start", "version": "3.0.0", "timestampUtc": "test", "scope": "Hud"},
        {"kind": "node", "index": 0, "parent": None,
         "node": {"id": "Hud", "type": "CitadelHud", "classes": ["alive"]}},
        {"kind": "node", "index": 1, "parent": 0,
         "node": {"id": "", "type": "Label", "classes": ["currentHealthLabel"], "text": "123"}},
        {"kind": "end", "summary": {"totalPanels": 2}, "durationMs": 20,
         "meta": {"classCoverage": "GetClasses-returned", "readErrors": {}, "asynchronous": True}},
    ]
    return "\n".join(json.dumps(r) for r in records) + "\n"


def packet(session, index, total, body):
    return f"HUD_DUMP3|{session}|{index}|{total}|{receiver.checksum(body)}|{body}"


class ReceiverTests(unittest.TestCase):
    def test_clipboard_decoding_stops_before_allocation_padding(self):
        value = "HUD_DUMP3|rocket🚀"
        self.assertEqual(receiver.decode_clipboard(value.encode("utf-16-le") + b"\0\0\xff"), value)
        self.assertIsNone(receiver.decode_clipboard(b"\x00\xd8\0\0"))
        self.assertIsNone(receiver.decode_clipboard(b"missing terminator"))

    def test_loss_duplicates_reordering_and_sessions_do_not_mix(self):
        r = receiver.Receiver()
        value = stream()
        a, b = value[:100], value[100:]
        self.assertIsNone(r.accept(packet("first-1", 1, 2, b)))
        self.assertIsNone(r.accept(packet("second-1", 0, 2, a)))
        self.assertIsNone(r.accept(packet("first-1", 1, 2, b)))
        self.assertEqual(r.progress(), [("first-1", 1, 2), ("second-1", 1, 2)])
        session, data = r.accept(packet("first-1", 0, 2, a))
        self.assertEqual(session, "first-1")
        self.assertEqual(data["domTree"]["children"][0]["text"], "123")
        self.assertEqual(data["uniqueClasses"], ["alive", "currentHealthLabel"])

    def test_corrupted_packets_and_conflicting_duplicates_are_rejected(self):
        r = receiver.Receiver()
        with self.assertRaisesRegex(ValueError, "checksum"):
            r.accept("HUD_DUMP3|test-1|0|1|00000000|bad")
        r.accept(packet("test-1", 0, 2, "a"))
        with self.assertRaisesRegex(ValueError, "conflicting"):
            r.accept(packet("test-1", 0, 2, "b"))
        for data in ["HUD_DUMP3|test-1|-1|2|bad|x", "HUD_DUMP3|test-1|0|99999|bad|x"]:
            with self.assertRaises(ValueError):
                r.accept(data)

    def test_missing_footer_nodes_parents_and_count_mismatch_are_rejected(self):
        records = [json.loads(line) for line in stream().splitlines()]
        for change in (lambda r: r.pop(), lambda r: r[2].update(parent=9),
                       lambda r: r[2].update(index=7), lambda r: r[-1]["summary"].update(totalPanels=3),
                       lambda r: r.append([]), lambda r: r[-1].update(summary=[])):
            copy = json.loads(json.dumps(records))
            change(copy)
            with self.assertRaises(ValueError):
                receiver.reconstruct("\n".join(json.dumps(r) for r in copy))

    def test_verified_capture_is_published_without_overwriting_previous_file(self):
        data = receiver.reconstruct(stream())
        with tempfile.TemporaryDirectory() as folder:
            destination = receiver.save_capture(data, "test-1", folder, "match")
            self.assertEqual(json.loads(destination.read_text())["summary"]["totalPanels"], 2)
            with self.assertRaises(FileExistsError):
                receiver.save_capture(data, "test-1", folder, "match")
            self.assertEqual(len(list(Path(folder).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
