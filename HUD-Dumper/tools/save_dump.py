#!/usr/bin/env python3
"""Receive bounded HUD_DUMP3 clipboard packets; rebuild and validate JSON offline."""
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


def checksum(text):
    value = 2166136261
    raw = text.encode("utf-16-le", errors="surrogatepass")
    for i in range(0, len(raw), 2):
        value = ((value ^ (raw[i] | raw[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return f"{value:08x}"


class Receiver:
    def __init__(self):
        self.sessions = {}

    def accept(self, text):
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
        if checksum(data) != digest:
            raise ValueError("packet checksum mismatch")
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
                for session, state in self.sessions.items()]


def reconstruct(stream):
    # NDJSON delimiters are LF only; Unicode paragraph separators can be label text.
    records = [json.loads(line) for line in stream.split("\n") if line]
    if any(not isinstance(record, dict) for record in records):
        raise ValueError("invalid stream record")
    if len(records) < 3 or records[0].get("kind") != "start" or records[-1].get("kind") != "end":
        raise ValueError("missing start/end record")
    header, footer = records[0], records[-1]
    if header.get("version") != "3.0.0":
        raise ValueError("unsupported capture version")
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
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", args.label) or not 0 < args.timeout <= 3600:
        parser.error("invalid label or timeout")
    read = clipboard_reader()
    receiver, last, last_progress = Receiver(), None, 0
    started = time.monotonic()
    print("Ready. Press M in the repacked HUD-Dumper client; waiting for v3 packets.", flush=True)
    try:
        while time.monotonic() - started < args.timeout:
            text = read()
            if text and text != last:
                last = text
                try:
                    result = receiver.accept(text)
                    if result:
                        session, data = result
                        destination = save_capture(data, session, args.output_dir, args.label)
                        print(f"Saved verified complete packet set: {destination}", flush=True)
                        print(f"Panels: {data['summary']['totalPanels']}; classes: {data['meta']['classCoverage']}")
                        for warning in data["warnings"]:
                            print(f"NOTE: {warning}")
                        return 0
                except ValueError as error:
                    print(f"Rejected packet/capture: {error}", flush=True)
            if time.monotonic() - last_progress >= 2:
                for session, received, total in receiver.progress():
                    print(f"{session}: {received}/{total} packets received", flush=True)
                last_progress = time.monotonic()
            time.sleep(0.01)
    except KeyboardInterrupt:
        print("Stopped. Incomplete captures were not saved.")
        return 1
    print(f"Timed out; incomplete captures were not saved. Pending: {receiver.progress()}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
