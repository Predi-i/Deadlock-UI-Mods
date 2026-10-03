#!/usr/bin/env python3
"""Receive HUD-Dumper clipboard batches; journal v4 immediately and rebuild JSON offline."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

MAX_CHUNKS = 2048
MAX_CHARS = 8 * 1024 * 1024
MAX_PACKET_CHARS = 8500
MAX_STREAM_CHUNKS = 65536
MAX_STREAM_CHARS = 512 * 1024 * 1024


def checksum(text):
    value = 2166136261
    raw = text.encode("utf-16-le", errors="surrogatepass")
    for i in range(0, len(raw), 2):
        value = ((value ^ (raw[i] | raw[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return f"{value:08x}"


def verified_payload(data, digest):
    if not re.fullmatch(r"[0-9a-f]{8}", digest):
        raise ValueError("invalid checksum header")
    raw_digest = checksum(data)
    if raw_digest == digest:
        return data, False
    # CF_UNICODETEXT uses CR-LF lines. Restore the sender's LF framing only
    # when the original checksum verifies; JSON-escaped label text is untouched.
    restored = data.replace("\r\n", "\n")
    lf_digest = checksum(restored) if restored != data else raw_digest
    if restored != data and lf_digest == digest:
        return restored, True
    raise ValueError(f"packet checksum mismatch (expected={digest}, raw={raw_digest}, LF={lf_digest})")


class RejectedPacketJournal:
    """Keep failed HUD packets for diagnosis; never journal unrelated clipboard text."""
    def __init__(self, directory):
        self.directory, self.handle, self.path = Path(directory), None, None
        self.chars = 0

    def record(self, text, error):
        if not text.startswith(("HUD_DUMP3|", "HUD_DUMP4|")) or len(text) > MAX_PACKET_CHARS:
            return None
        if self.chars + len(text) > MAX_STREAM_CHARS:
            return self.path
        if self.handle is None:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.handle = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="hud_rejected_",
                                                      suffix=".jsonl.part", dir=self.directory, delete=False)
            self.path = Path(self.handle.name)
        self.handle.write(json.dumps({"error": str(error), "packet": text}, ensure_ascii=True) + "\n")
        self.handle.flush()
        self.chars += len(text)
        return self.path

    def close(self):
        if self.handle is not None:
            self.handle.close()


class Receiver:
    def __init__(self, spool_dir=None):
        self.sessions = {}
        self.stream = StreamReceiver(spool_dir)
        self.newline_normalizations = 0

    def accept(self, text):
        if text and text.startswith("HUD_DUMP4|"):
            return self.stream.accept(text)
        if not text or not text.startswith("HUD_DUMP3|"):
            return None
        # Python counts Unicode code points; protocol checksums use UTF-16 units.
        if len(text.encode("utf-16-le", errors="surrogatepass")) // 2 > MAX_PACKET_CHARS:
            raise ValueError("packet too large")
        parts = text.split("|", 5)
        if len(parts) != 6:
            raise ValueError("malformed packet")
        _, session, index, total, digest, data = parts
        if not re.fullmatch(r"[a-z0-9-]{1,48}", session):
            raise ValueError("invalid session ID")
        if not index.isdecimal() or not total.isdecimal():
            raise ValueError("invalid packet index/count")
        index, total = int(index), int(total)
        if not 0 <= index < total <= MAX_CHUNKS:
            raise ValueError("packet index/count outside limits")
        data, normalized = verified_payload(data, digest)
        self.newline_normalizations += int(normalized)
        if session not in self.sessions:
            if len(self.sessions) >= 2:
                del self.sessions[next(iter(self.sessions))]
            self.sessions[session] = {"total": total, "chunks": {}, "chars": 0}
        state = self.sessions[session]
        if state["total"] != total:
            raise ValueError("packet count changed within a session")
        if index in state["chunks"]:
            if state["chunks"][index] != data:
                raise ValueError("conflicting duplicate packet")
            return None
        state["chars"] += len(data.encode("utf-16-le", errors="surrogatepass")) // 2
        if state["chars"] > MAX_CHARS:
            del self.sessions[session]
            raise ValueError("capture size exceeds receiver limit")
        state["chunks"][index] = data
        if len(state["chunks"]) != total:
            return None
        joined = "".join(state["chunks"][i] for i in range(total))
        del self.sessions[session]
        return session, reconstruct(joined)

    def progress(self):
        return [(session, len(state["chunks"]), state["total"])
                for session, state in self.sessions.items()] + self.stream.progress()

    def close(self):
        self.stream.close()

    def normalizations(self):
        return self.newline_normalizations + self.stream.newline_normalizations


class StreamReceiver:
    def __init__(self, spool_dir=None):
        self.spool_dir = Path(spool_dir) if spool_dir is not None else None
        self.sessions, self.completed, self.packet_files = {}, {}, []
        self.newline_normalizations = 0

    def _new_session(self, session):
        if self.spool_dir is not None:
            self.spool_dir.mkdir(parents=True, exist_ok=True)
        if len(self.sessions) >= 2:
            old = self.sessions.pop(next(iter(self.sessions)))  # Preserve the evicted session's journal.
            old["file"].close()
        handle = tempfile.NamedTemporaryFile(mode="w+b", prefix=f"hud_packets_{session}_",
                                             suffix=".jsonl.part", dir=self.spool_dir, delete=False)
        self.packet_files.append(Path(handle.name))
        state = {"file": handle, "chunks": {}, "total": None, "chars": 0, "end": None}
        self.sessions[session] = state
        return state

    @staticmethod
    def _journal(state, index, kind, digest, data):
        handle = state["file"]
        handle.seek(0, os.SEEK_END)
        offset = handle.tell()
        raw = (json.dumps({"index": index, "kind": kind, "checksum": digest, "data": data},
                          ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        handle.write(raw)
        handle.flush()
        return offset, len(raw)

    @staticmethod
    def _read(state, location):
        state["file"].seek(location[0])
        return json.loads(state["file"].read(location[1]))["data"]

    def accept(self, text):
        if len(text.encode("utf-16-le", errors="surrogatepass")) // 2 > MAX_PACKET_CHARS:
            raise ValueError("packet too large")
        parts = text.split("|", 5)
        if len(parts) != 6:
            raise ValueError("malformed stream packet")
        _, session, index, kind, digest, data = parts
        if not re.fullmatch(r"[a-z0-9-]{1,48}", session) or not index.isdecimal():
            raise ValueError("invalid stream session/index")
        index = int(index)
        if not 0 <= index <= MAX_STREAM_CHUNKS or kind not in ("chunk", "end"):
            raise ValueError("invalid stream index/kind")
        data, normalized = verified_payload(data, digest)
        self.newline_normalizations += int(normalized)
        if kind == "chunk" and index == MAX_STREAM_CHUNKS:
            raise ValueError("stream packet index outside limits")
        total = None
        if kind == "end":
            footer = json.loads(data)
            total = footer.get("chunks") if isinstance(footer, dict) else None
            if type(total) is not int or not 0 < total <= MAX_STREAM_CHUNKS or index != total:
                raise ValueError("invalid stream completion count")
        if session in self.completed:
            return None
        state = self.sessions.get(session) or self._new_session(session)
        if kind == "end":
            if state["total"] is not None and state["total"] != total:
                raise ValueError("stream completion count changed")
            if any(i >= total for i in state["chunks"]):
                raise ValueError("stream chunk outside completion count")
            if state["end"] is None:
                self._journal(state, index, kind, digest, data)
                state["end"] = digest
            elif state["end"] != digest:
                raise ValueError("conflicting stream completion marker")
            state["total"] = total
        else:
            if state["total"] is not None and index >= state["total"]:
                raise ValueError("stream chunk outside completion count")
            if index in state["chunks"]:
                if self._read(state, state["chunks"][index]) != data:
                    raise ValueError("conflicting duplicate packet")
                return None
            chars = len(data.encode("utf-16-le", errors="surrogatepass")) // 2
            if state["chars"] + chars > MAX_STREAM_CHARS:
                raise ValueError("stream exceeds disk receiver limit")
            location = self._journal(state, index, kind, digest, data)
            state["chunks"][index] = location
            state["chars"] += chars
        if state["total"] is None or len(state["chunks"]) != state["total"]:
            return None
        # Only Python assembles the complete payload, after every index is present.
        joined = "".join(self._read(state, state["chunks"][i]) for i in range(state["total"]))
        state["file"].close()
        del self.sessions[session]
        result = reconstruct(joined)
        self.completed[session] = True
        if len(self.completed) > 128:
            del self.completed[next(iter(self.completed))]
        return session, result

    def progress(self):
        return [(session, len(state["chunks"]), state["total"] or "streaming")
                for session, state in self.sessions.items()]

    def close(self):
        for state in self.sessions.values():
            state["file"].close()
        self.sessions.clear()


def reconstruct(stream):
    # NDJSON delimiters are LF only; Unicode paragraph separators can be label text.
    records = [json.loads(line) for line in stream.split("\n") if line]
    if any(not isinstance(record, dict) for record in records):
        raise ValueError("invalid stream record")
    if len(records) < 3 or records[0].get("kind") != "start" or records[-1].get("kind") != "end":
        raise ValueError("missing start/end record")
    header, footer = records[0], records[-1]
    if header.get("version") not in ("3.0.0", "4.0.0"):
        raise ValueError("unsupported capture version")
    if header.get("format") == "debugger-rows-v1":
        return reconstruct_debugger_rows(header, footer, records[1:-1])
    if "format" in header:
        raise ValueError("unsupported capture format")
    nodes, depths = [], []
    ids, classes, types = set(), set(), set()
    root = None
    for record in records[1:-1]:
        if record.get("kind") != "node" or type(record.get("index")) is not int or record["index"] != len(nodes):
            raise ValueError("missing, duplicate or out-of-order node record")
        node = record.get("node")
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not isinstance(node.get("type"), str):
            raise ValueError("invalid panel record")
        node_classes = node.get("classes")
        if not isinstance(node_classes, list) or any(not isinstance(c, str) for c in node_classes):
            raise ValueError("invalid class list")
        if "children" in node or "text" in node and not isinstance(node["text"], str):
            raise ValueError("invalid panel payload")
        node["children"] = []
        parent = record.get("parent")
        if parent is None:
            if root is not None or nodes:
                raise ValueError("multiple capture roots")
            root = node
            depth = 0
        elif type(parent) is not int or not 0 <= parent < len(nodes):
            raise ValueError("invalid parent index")
        else:
            depth = depths[parent] + 1
            if depth > 80:
                raise ValueError("capture depth exceeds limit")
            nodes[parent]["children"].append(node)
        nodes.append(node)
        depths.append(depth)
        if node["id"]:
            ids.add(node["id"])
        if node["type"]:
            types.add(node["type"])
        classes.update(node_classes)
        if len(nodes) > 50000:
            raise ValueError("too many nodes")
    summary = footer.get("summary")
    if root is None or not isinstance(summary, dict) or summary.get("totalPanels") != len(nodes):
        raise ValueError("panel count mismatch")
    meta = footer.get("meta")
    if not isinstance(meta, dict) or meta.get("classCoverage") not in ("partial", "GetClasses-returned"):
        raise ValueError("missing capture metadata")
    if not isinstance(meta.get("readErrors"), dict) or any(type(n) is not int or n < 0 for n in meta["readErrors"].values()):
        raise ValueError("invalid read-error metadata")
    warnings = []
    for key in ("truncated", "clipped", "skippedDestroyed", "repeatedPanels", "textTruncated", "classesIncomplete"):
        if meta.get(key):
            warnings.append(f"Capture {key}: {meta[key]}")
    if any(meta.get("readErrors", {}).values()):
        warnings.append("Some native reads failed; inspect meta.readErrors and per-node status.")
    warnings.append("Incremental capture over an interval; native state may change during collection.")
    return {"version": header["version"], "timestampUtc": header.get("timestampUtc"),
            "durationMs": footer.get("durationMs"), "scope": header.get("scope"), "meta": meta,
            "summary": {"totalPanels": len(nodes), "uniqueIdsCount": len(ids),
                        "uniqueClassesCount": len(classes), "uniqueTypesCount": len(types)},
            "uniqueIds": sorted(ids), "uniqueClasses": sorted(classes), "uniqueTypes": sorted(types),
            "warnings": warnings, "domTree": root}


def parse_debugger_open(text):
    """Read native diagnostic syntax: raw attributes, with literal text last.

    The verified client formatter does not XML-escape values. In the capture,
    every text attribute is last; its value may contain quotes, &, <, or >.
    Parsing it as XML would reject valid descriptions or change literal entities.
    """
    if not text.startswith("<") or text.startswith("</") or not text.endswith(">"):
        raise ValueError("not an opening description")
    self_closing = text.endswith("/>")
    body = text[1:-2 if self_closing else -1].rstrip()
    match = re.match(r"([A-Za-z_][\w.:-]*)(?=\s|$)", body)
    if not match:
        raise ValueError("invalid panel type")
    panel_type, position, attrs = match[1], match.end(), {}
    while position < len(body):
        if not body[position].isspace():
            raise ValueError("missing attribute separator")
        while position < len(body) and body[position].isspace():
            position += 1
        if position == len(body):
            break
        field = re.match(r'([A-Za-z_][\w.:-]*)="', body[position:])
        if not field or field[1] in attrs:
            raise ValueError("invalid or duplicate attribute")
        name = field[1]
        position += field.end()
        if name == "text":
            if not body.endswith('"'):
                raise ValueError("unterminated native text")
            attrs[name] = body[position:-1]
            position = len(body)
        else:
            end = body.find('"', position)
            if end < 0:
                raise ValueError("unterminated native attribute")
            attrs[name], position = body[position:end], end + 1
    return panel_type, attrs, self_closing


def reconstruct_debugger_rows(header, footer, records):
    """Preserve native descriptions even when their markup cannot form a tree."""
    meta = footer.get("meta")
    summary = footer.get("summary")
    if (header.get("version") != "4.0.0" or not isinstance(meta, dict)
            or meta.get("classCoverage") != "Debugger-rendered"
            or meta.get("debuggerRowsComplete") is not True
            or meta.get("fullHudCapture") is not False):
        raise ValueError("invalid debugger capture metadata")
    if not isinstance(summary, dict) or type(summary.get("totalRows")) is not int or summary["totalRows"] != len(records):
        raise ValueError("debugger row count mismatch")
    if not 1 <= len(records) <= 100000:
        raise ValueError("debugger row count outside limits")
    opens = closes = failed = 0
    ids, classes, types = set(), set(), set()
    stack, nodes, errors = [], [], []
    roots = []
    collapsed = 0

    def error(message):
        if len(errors) < 20:
            errors.append(message)

    for i, record in enumerate(records):
        if (record.get("kind") != "row" or type(record.get("index")) is not int or record["index"] != i
                or type(record.get("childIndex")) is not int or record["childIndex"] != i
                or record.get("role") not in ("open", "close")
                or not isinstance(record.get("text"), str)
                or not 0 < len(record["text"].encode("utf-16-le", errors="surrogatepass")) // 2 <= 65536
                or type(record.get("hasChildren")) is not bool or type(record.get("collapsed")) is not bool
                or type(record.get("visible")) is not bool):
            raise ValueError("invalid or out-of-order debugger row")
        text = record["text"].strip()
        if record["role"] == "close":
            closes += 1
            match = re.fullmatch(r"</([A-Za-z_][\w.:-]*)\s*>", text)
            if not match or not stack or stack[-1]["type"] != match[1]:
                error(f"Row {i}: unmatched closing description")
            else:
                stack.pop()
            continue
        opens += 1
        if opens > 50000:
            raise ValueError("too many described panels")
        if len(stack) >= 80:
            raise ValueError("debugger description depth exceeds limit")
        collapsed += int(record["collapsed"])
        try:
            panel_type, attrs, self_closing = parse_debugger_open(text)
            node_classes = attrs.get("class", "").split()
            node = {"id": attrs.get("id", ""), "type": panel_type,
                    "classes": list(dict.fromkeys(node_classes)), "classesStatus": "Debugger-rendered",
                    "children": [], "debuggerRowIndex": i, "debuggerRowVisible": record["visible"],
                    "debuggerHasChildren": record["hasChildren"], "debuggerCollapsed": record["collapsed"],
                    "debuggerAttributes": attrs}
            if "text" in attrs:
                node["text"], node["textStatus"] = attrs["text"], "Debugger-rendered"
            elif node["type"] in ("Label", "TextEntry"):
                node["textStatus"] = "unavailable-in-description"
            for flag in ("visible", "enabled", "checked", "hittest", "hittestchildren"):
                if attrs.get(flag) in ("true", "false"):
                    node[flag] = attrs[flag] == "true"
            if node["id"]:
                ids.add(node["id"])
            types.add(node["type"])
            classes.update(node["classes"])
            nodes.append(node)
            if stack:
                stack[-1]["children"].append(node)
            else:
                roots.append(node)
            if record["hasChildren"] and self_closing:
                error(f"Row {i}: branch described as self-closing")
            if not self_closing:
                stack.append(node)
        except ValueError as exc:
            failed += 1
            error(f"Row {i}: invalid opening description: {exc}")
    if (type(summary.get("openRows")) is not int or summary["openRows"] != opens
            or type(summary.get("closeRows")) is not int or summary["closeRows"] != closes):
        raise ValueError("debugger opening/closing count mismatch")
    if type(meta.get("remainingCollapsed")) is not int or meta["remainingCollapsed"] != collapsed:
        raise ValueError("debugger collapsed branch count mismatch")
    if stack:
        error(f"Unclosed descriptions: {len(stack)}")
    if not roots:
        error("No described root")
    unrepresented = sum(n["debuggerHasChildren"] and not n["children"] for n in nodes)
    forest_valid = not errors
    hud_roots = [r for r in roots if r["id"] == "CitadelHudRoot" and r["type"] == "Panel"]
    root = None
    selection = "none"
    if forest_valid:
        if len(hud_roots) == 1:
            root, selection = hud_roots[0], "CitadelHudRoot"
        elif len(roots) == 1:
            root, selection = roots[0], "only-described-root"
    tree_valid = root is not None
    selected_nodes = []
    if root is not None:
        todo = [root]
        while todo:
            node = todo.pop()
            selected_nodes.append(node)
            todo.extend(reversed(node["children"]))
    scope_nodes = selected_nodes if root is not None else nodes
    selected_ids = {n["id"] for n in scope_nodes if n["id"]}
    selected_classes = {c for n in scope_nodes for c in n["classes"]}
    selected_types = {n["type"] for n in scope_nodes}
    meta = dict(meta, treeValid=tree_valid, forestValid=forest_valid, classesIncomplete=failed,
                unrepresentedBranches=unrepresented, descriptionParseErrors=errors,
                domTreeSelection=selection, hudRootMatches=len(hud_roots),
                descriptionEncoding="native raw attributes; literal final text field")
    warnings = ["Native debugger descriptions may retain earlier state; their refresh timing is unverified.",
                "Complete debugger rows do not establish complete live HUD coverage; fullHudCapture is false."]
    if collapsed:
        warnings.append(f"Collapsed debugger branches remain: {collapsed}")
    if unrepresented:
        warnings.append(f"Branches marked as having children without represented descendants: {unrepresented}")
    if not forest_valid:
        warnings.append("Descriptions do not form a verified forest. Raw debuggerRows retained; domTree/domForest are null.")
    elif not tree_valid:
        warnings.append("Multiple described roots without a unique CitadelHudRoot; domForest retained, domTree is null.")
    missing_text = sum(n.get("textStatus") == "unavailable-in-description" for n in scope_nodes)
    meta["textUnavailable"] = missing_text
    meta["debuggerTextUnavailable"] = sum(n.get("textStatus") == "unavailable-in-description" for n in nodes)
    if missing_text:
        warnings.append(f"Label/TextEntry descriptions without a text attribute: {missing_text}")
    return {"version": header["version"], "format": header["format"], "timestampUtc": header.get("timestampUtc"),
            "durationMs": footer.get("durationMs"), "scope": (root["id"] or root["type"]) if root else header.get("scope"), "meta": meta,
            "summary": {"totalPanels": len(scope_nodes), "uniqueIdsCount": len(selected_ids),
                        "uniqueClassesCount": len(selected_classes), "uniqueTypesCount": len(selected_types)},
            "debuggerSummary": {"totalPanels": opens, "totalRows": len(records), "totalRoots": len(roots),
                                "uniqueIdsCount": len(ids), "uniqueClassesCount": len(classes), "uniqueTypesCount": len(types)},
            "uniqueIds": sorted(selected_ids), "uniqueClasses": sorted(selected_classes), "uniqueTypes": sorted(selected_types),
            "debuggerUniqueClasses": sorted(classes), "warnings": warnings, "domTree": root,
            "domForest": roots if forest_valid else None, "debuggerRows": records}


def save_capture(data, session, output_dir, label):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"deadlock_hud_dump_{label}_{session}.json"
    # Keep historical captures intact; even a repeated session never overwrites.
    if destination.exists():
        raise FileExistsError(f"capture already exists: {destination}")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_dir, delete=False) as handle:
            temp_path = Path(handle.name)
            json.dump(data, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        # Publish the complete file atomically without replacing an existing name.
        # Same-directory hard link works on NTFS; unsupported filesystems fail
        # explicitly and retain the complete temporary capture for recovery.
        os.link(temp_path, destination)
    except Exception:
        # Preserve a complete temporary artifact on final-write failure.
        if temp_path is not None:
            print(f"Temporary capture retained at {temp_path}; inspect write failure before use.", file=sys.stderr)
        raise
    else:
        temp_path.unlink()
    return destination


def decode_clipboard(raw):
    # CF_UNICODETEXT ends at an aligned UTF-16 NUL. Allocation padding is not text.
    for end in range(0, len(raw) - 1, 2):
        if raw[end:end + 2] == b"\0\0":
            try:
                return raw[:end].decode("utf-16-le")
            except UnicodeDecodeError:
                return None
    return None


def clipboard_reader():
    if sys.platform != "win32":
        raise RuntimeError("clipboard watching requires Windows")
    user32, kernel32 = ctypes.WinDLL("user32"), ctypes.WinDLL("kernel32")
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_int
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_int
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.GetClipboardData.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_int
    kernel32.GlobalSize.argtypes = [ctypes.c_void_p]
    kernel32.GlobalSize.restype = ctypes.c_size_t

    def read():
        if not user32.OpenClipboard(None):
            return None
        try:
            memory = user32.GetClipboardData(13)  # CF_UNICODETEXT
            if not memory or kernel32.GlobalSize(memory) > MAX_PACKET_CHARS * 2 + 16:
                return None
            pointer = kernel32.GlobalLock(memory)
            if not pointer:
                return None
            try:
                # Bound reads even if another application supplies malformed text.
                raw = ctypes.string_at(pointer, kernel32.GlobalSize(memory))
                return decode_clipboard(raw)
            finally:
                kernel32.GlobalUnlock(memory)
        finally:
            user32.CloseClipboard()
    return read


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "captures")
    parser.add_argument("--label", default="unspecified", help="scenario label: match, hero-testing, hideout, etc.")
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", args.label) or not 0 < args.timeout <= 3600:
        parser.error("invalid label or timeout")
    read = clipboard_reader()
    receiver, last, last_progress = Receiver(args.output_dir), None, 0
    rejected = RejectedPacketJournal(args.output_dir)
    reported_journals = 0
    reported_newlines = False
    reported_rejections = False
    started = time.monotonic()
    print("Ready. Watching clipboard for v3/v4 packets. V4 batches are written to disk immediately.", flush=True)
    print(f"Output directory: {args.output_dir}", flush=True)
    try:
        while time.monotonic() - started < args.timeout:
            text = read()
            if text and text != last:
                last = text
                try:
                    result = receiver.accept(text)
                    if receiver.normalizations() and not reported_newlines:
                        print("Clipboard CR-LF framing restored to LF; original checksum verified.", flush=True)
                        reported_newlines = True
                    for journal in receiver.stream.packet_files[reported_journals:]:
                        print(f"Packet journal: {journal}", flush=True)
                    reported_journals = len(receiver.stream.packet_files)
                    if result:
                        session, data = result
                        data["transport"] = {"clipboardNewlineNormalizations": receiver.normalizations()}
                        destination = save_capture(data, session, args.output_dir, args.label)
                        print(f"Saved verified complete packet set: {destination}", flush=True)
                        print(f"Panels: {data['summary']['totalPanels']}; classes: {data['meta']['classCoverage']}")
                        for warning in data["warnings"]:
                            print(f"NOTE: {warning}")
                        return 0
                except ValueError as error:
                    path = rejected.record(text, error)
                    if path and not reported_rejections:
                        print(f"Rejected packet journal: {path}", flush=True)
                        reported_rejections = True
                    print(f"Rejected packet/capture: {error}", flush=True)
            if time.monotonic() - last_progress >= 2:
                for session, received, total in receiver.progress():
                    print(f"{session}: {received}/{total} packets received", flush=True)
                last_progress = time.monotonic()
            time.sleep(0.01)
    except KeyboardInterrupt:
        print("Stopped. Incomplete captures were not saved.")
        return 1
    finally:
        pending_progress = receiver.progress()
        receiver.close()
        rejected.close()
    print(f"Timed out; incomplete captures were not saved. Pending: {pending_progress}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
