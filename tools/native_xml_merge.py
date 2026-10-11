"""Conservative source-only XML merging; native client behavior still needs review."""

from collections import Counter
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET


def normalize_xml(text):
    text = text.replace("\r\n", "\n")
    text = re.sub(r"^<!-- xml reconstructed by Source 2 Viewer[^\n]*-->\n", "", text)
    return re.sub(r"\.(vcss|vjs|vts|vxml)(?=[\"'])", r".\1_c", text)


def nodes(text):
    result = {}

    def visit(node, path):
        if path in result:
            raise ValueError("ambiguous XML anchor: " + "/".join(path))
        result[path] = node
        counts = Counter()
        for child in node:
            counts[child.tag] += 1
            if "id" in child.attrib:
                key = "id=" + child.attrib["id"]
            elif child.tag == "snippet" and "name" in child.attrib:
                key = "snippet=" + child.attrib["name"]
            elif child.tag == "include" and "src" in child.attrib:
                key = "include=" + child.attrib["src"]
            else:
                key = f"{child.tag}[{counts[child.tag]}]"
            visit(child, path + (key,))

    visit(ET.fromstring(text), ("root",))
    return result


def signature(node):
    return (node.tag, node.attrib, (node.text or "").strip(), (node.tail or "").strip(),
            [signature(child) for child in node])


def choose(base, local, native, path):
    if local != base and native != base and local != native:
        raise ValueError("native changes overlap mod XML at " + "/".join(path))
    return local if local != base else native


def validate_merge(local, base, native, merged):
    old, mod, new, output = map(nodes, (base, local, native, merged))
    for path in old.keys() | mod.keys() | new.keys():
        b, l, n, m = (tree.get(path) for tree in (old, mod, new, output))
        # A moved/type-changed native parent must not silently acquire mod children.
        if b is not None and l is not None and signature(b) != signature(l):
            if n is None or n.tag != b.tag:
                raise ValueError("mod XML anchor removed or changed type: " + "/".join(path))
        if b is None:
            if l is not None and n is not None and signature(l) != signature(n):
                raise ValueError("new native XML collides with mod anchor: " + "/".join(path))
            expected = l if l is not None else n
            if m is None or signature(m) != signature(expected):
                raise ValueError("XML addition was not preserved: " + "/".join(path))
            if l is not None and n is None:
                parent = path[:-1]
                while parent and parent not in old:
                    parent = parent[:-1]
                if parent and (parent not in new or old[parent].tag != new[parent].tag
                               or old[parent].attrib != new[parent].attrib):
                    raise ValueError("mod insertion parent changed: " + "/".join(parent))
            continue
        if l is None or n is None:
            survivor = n if l is None else l
            if survivor is not None and signature(survivor) != signature(b):
                raise ValueError("XML removal overlaps edits: " + "/".join(path))
            if m is not None:
                raise ValueError("XML removal was not preserved: " + "/".join(path))
            continue
        expected_tag = choose(b.tag, l.tag, n.tag, path)
        expected_text = choose((b.text or "").strip(), (l.text or "").strip(),
                               (n.text or "").strip(), path)
        expected_tail = choose((b.tail or "").strip(), (l.tail or "").strip(),
                               (n.tail or "").strip(), path)
        expected_attrs = {}
        for key in b.attrib.keys() | l.attrib.keys() | n.attrib.keys():
            value = choose(b.get(key), l.get(key), n.get(key), path + (key,))
            if value is not None:
                expected_attrs[key] = value
        if m is None or (m.tag, m.attrib, (m.text or "").strip(), (m.tail or "").strip()) != (
                expected_tag, expected_attrs, expected_text, expected_tail):
            raise ValueError("XML edits were not preserved: " + "/".join(path))


def merge_text(local, base, native):
    with tempfile.TemporaryDirectory() as directory:
        files = [Path(directory) / name for name in ("mod", "base", "native")]
        for path, text in zip(files, (local, base, native)):
            path.write_text(text, encoding="utf-8", newline="\n")
        result = subprocess.run(["git", "merge-file", "-p", *map(str, files)], capture_output=True)
        if result.returncode:
            raise ValueError("native changes overlap mod edits; manual review required")
        merged = result.stdout.decode("utf-8").replace("\r\n", "\n")
    return merged


def merge_xml(local, base, native):
    # Viewer comments are not merge conflicts; retain the mod's original header.
    header = re.match(r"^(<!-- xml reconstructed by Source 2 Viewer[^\n]*-->\r?\n)", local)
    local, base, native = map(normalize_xml, (local, base, native))
    merged = merge_text(local, base, native)
    validate_merge(local, base, native, merged)
    return (header.group(1).replace("\r\n", "\n") if header else "") + merged
