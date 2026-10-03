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


def stream_packet(session, index, kind, body):
    return f"HUD_DUMP4|{session}|{index}|{kind}|{receiver.checksum(body)}|{body}"


class ReceiverTests(unittest.TestCase):
    def test_windows_crlf_framing_restores_checksum_and_preserves_escaped_label_text(self):
        records = [json.loads(line) for line in stream().splitlines()]
        records[2]['node']['text'] = '123\r\nnext\nline'
        value = '\n'.join(json.dumps(r) for r in records) + '\n'
        with tempfile.TemporaryDirectory() as folder:
            r = receiver.Receiver(folder)
            try:
                _, legacy = r.accept(packet('crlf-3', 0, 1, value).replace('\n', '\r\n'))
                self.assertEqual(legacy['domTree']['children'][0]['text'], '123\r\nnext\nline')
                self.assertIsNone(r.accept(stream_packet('crlf-4', 0, 'chunk', value).replace('\n', '\r\n')))
                _, current = r.accept(stream_packet('crlf-4', 1, 'end', '{"chunks":1}'))
                self.assertEqual(current['domTree']['children'][0]['text'], '123\r\nnext\nline')
                self.assertEqual(r.normalizations(), 2)
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    receiver.verified_payload(value.replace('\n', '\r\n') + 'corrupt', receiver.checksum(value))
            finally:
                r.close()

    def test_rejected_packet_journal_keeps_raw_bytes_without_recording_other_clipboard_text(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = receiver.RejectedPacketJournal(folder)
            try:
                self.assertIsNone(journal.record('unrelated private clipboard text', 'bad'))
                self.assertEqual(list(Path(folder).iterdir()), [])
                raw = 'HUD_DUMP4|test-1|0|chunk|00000000|broken\r\n'
                file = journal.record(raw, 'checksum mismatch')
                self.assertEqual(json.loads(file.read_text())['packet'], raw)
            finally:
                journal.close()

    def test_stream_journals_immediately_then_accepts_end_first_and_reordered_chunks(self):
        value = stream().replace('3.0.0', '4.0.0')
        a, b = value[:100], value[100:]
        with tempfile.TemporaryDirectory() as folder:
            r = receiver.Receiver(folder)
            self.addCleanup(r.close)
            self.assertIsNone(r.accept(stream_packet('live-1', 1, 'chunk', b)))
            journal = r.stream.packet_files[0]
            self.assertEqual(json.loads(journal.read_text().splitlines()[0])['data'], b)
            self.assertTrue(all(isinstance(n, int) for n in r.stream.sessions['live-1']['chunks'][1]))
            self.assertIsNone(r.accept(stream_packet('live-1', 1, 'chunk', b)))
            self.assertIsNone(r.accept(stream_packet('live-1', 2, 'end', json.dumps({'chunks': 2}))))
            _, data = r.accept(stream_packet('live-1', 0, 'chunk', a))
            self.assertEqual(data['domTree']['children'][0]['text'], '123')
            self.assertIsNone(r.accept(stream_packet('live-1', 2, 'end', json.dumps({'chunks': 2}))))
            self.assertEqual(len(journal.read_text().splitlines()), 3)
            r.close()

    def test_stream_large_capture_crosses_v3_size_and_packet_count_limits(self):
        records = [json.loads(line) for line in stream().splitlines()]
        records[0]['version'] = '4.0.0'
        nodes = [{"kind": "node", "index": i, "parent": 0,
                  "node": {"id": str(i), "type": "Label", "classes": [], "text": "x" * 7200}}
                 for i in range(1, 1201)]
        records[-1]['summary']['totalPanels'] = 1201
        value = '\n'.join(json.dumps(r) for r in [records[0], records[1], *nodes, records[-1]]) + '\n'
        self.assertGreater(len(value), receiver.MAX_CHARS)
        chunks = [value[i:i + 4096] for i in range(0, len(value), 4096)]
        self.assertGreater(len(chunks), receiver.MAX_CHUNKS)
        with tempfile.TemporaryDirectory() as folder:
            r = receiver.Receiver(folder)
            try:
                for i, body in enumerate(chunks):
                    self.assertIsNone(r.accept(stream_packet('large-1', i, 'chunk', body)))
                _, data = r.accept(stream_packet('large-1', len(chunks), 'end', json.dumps({'chunks': len(chunks)})))
                self.assertEqual(data['summary']['totalPanels'], 1201)
                self.assertEqual(data['domTree']['children'][-1]['text'], 'x' * 7200)
            finally:
                r.close()

    def test_incomplete_stream_keeps_journal_and_rejects_conflicting_chunks_and_end(self):
        with tempfile.TemporaryDirectory() as folder:
            r = receiver.Receiver(folder)
            r.accept(stream_packet('lost-1', 0, 'chunk', 'a'))
            with self.assertRaisesRegex(ValueError, 'conflicting'):
                r.accept(stream_packet('lost-1', 0, 'chunk', 'b'))
            self.assertIsNone(r.accept(stream_packet('lost-1', 2, 'end', '{"chunks":2}')))
            with self.assertRaises(ValueError):
                r.accept(stream_packet('lost-1', 3, 'end', '{"chunks":3}'))
            journal = r.stream.packet_files[0]
            r.close()
            self.assertTrue(journal.exists())
            self.assertEqual(len(journal.read_text().splitlines()), 2)

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
