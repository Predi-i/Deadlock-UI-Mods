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


def debugger_stream(texts):
    rows = [{"kind": "row", "index": i, "childIndex": i,
             "role": "close" if text.startswith("</") else "open", "text": text,
             "visible": True, "hasChildren": i == 0, "collapsed": False} for i, text in enumerate(texts)]
    footer = {"kind": "end", "summary": {"totalRows": len(rows),
              "openRows": sum(r["role"] == "open" for r in rows),
              "closeRows": sum(r["role"] == "close" for r in rows)},
              "meta": {"classCoverage": "Debugger-rendered", "debuggerRowsComplete": True,
                       "fullHudCapture": False, "remainingCollapsed": 0, "readErrors": {}}}
    records = [{"kind": "start", "version": "4.0.0", "format": "debugger-rows-v1"}, *rows, footer]
    return "\n".join(json.dumps(r) for r in records) + "\n"


class ReceiverTests(unittest.TestCase):
    def test_debugger_classes_and_tree_are_reconstructed_from_tags_not_ui_depth_or_visibility(self):
        text = '<Label id="health" class="native-only statNumber statNumber" text="123 &amp; &quot;x&quot;" />'
        value = debugger_stream(['<Panel id="CitadelHudRoot" class="WindowRoot alive">', text, '</Panel>'])
        rows = [json.loads(line) for line in value.splitlines()]
        rows[2]["visible"] = False
        data = receiver.reconstruct("\n".join(json.dumps(r) for r in rows))
        self.assertTrue(data['meta']['treeValid'])
        self.assertFalse(data['meta']['fullHudCapture'])
        self.assertEqual(data['summary']['totalPanels'], 2)
        label = data['domTree']['children'][0]
        self.assertEqual(label['classes'], ['native-only', 'statNumber'])
        self.assertEqual(label['text'], '123 & "x"')
        self.assertFalse(label['debuggerRowVisible'])
        self.assertNotIn('visible', label)  # Inspector visibility is not HUD visibility.
        self.assertEqual(data['debuggerRows'][1]['text'], text)

    def test_debugger_malformed_and_unbalanced_markup_retains_raw_rows_without_a_guessed_tree(self):
        for texts in [
            ['<Panel>', '<Label class="safe" text="unescaped & value" />', '</Panel>'],
            ['<Panel>', '<Label class="safe" />', '</Wrong>'],
            ['<Panel>', '<Panel>', '</Panel>'],
            ['<Panel />', '<Panel />'],
        ]:
            data = receiver.reconstruct(debugger_stream(texts))
            self.assertFalse(data['meta']['treeValid'])
            self.assertIsNone(data['domTree'])
            self.assertTrue(data['meta']['descriptionParseErrors'])
            self.assertEqual([r['text'] for r in data['debuggerRows']], texts)

    def test_debugger_empty_classes_and_missing_label_text_are_distinct_from_failed_descriptions(self):
        value = debugger_stream(['<Panel>', '<Label />', '<Panel class="nativeClass" />', '</Panel>'])
        data = receiver.reconstruct(value)
        self.assertTrue(data['meta']['treeValid'])
        label = data['domTree']['children'][0]
        self.assertEqual(label['classes'], [])
        self.assertEqual(label['classesStatus'], 'Debugger-rendered')
        self.assertEqual(label['textStatus'], 'unavailable-in-description')
        self.assertNotIn('text', label)
        self.assertEqual(data['meta']['textUnavailable'], 1)
        self.assertEqual(data['meta']['classesIncomplete'], 0)

    def test_debugger_schema_rejects_missing_rows_false_completeness_and_unknown_formats(self):
        original = [json.loads(line) for line in debugger_stream(['<Panel>', '</Panel>']).splitlines()]
        for mode in ['index', 'count', 'completeness', 'format', 'state']:
            records = json.loads(json.dumps(original))
            if mode == 'index': records[1]['index'] = 1
            if mode == 'count': records[-1]['summary']['totalRows'] = 3
            if mode == 'completeness': records[-1]['meta']['fullHudCapture'] = True
            if mode == 'format': records[0]['format'] = 'unknown'
            if mode == 'state': records[1]['collapsed'] = 'false'
            with self.assertRaises(ValueError, msg=mode):
                receiver.reconstruct('\n'.join(json.dumps(r) for r in records))

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
