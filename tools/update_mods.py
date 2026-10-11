"""Rebase native overrides on a pinned GameTracking checkout (source only)."""
import argparse
import json
import pathlib
import re
import subprocess
import xml.etree.ElementTree as ET

try:
    from native_xml_merge import merge_text, merge_xml
except ModuleNotFoundError:
    from tools.native_xml_merge import merge_text, merge_xml

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tools/upstream.json"


def normalize(text):
    # Viewer changed how compiled references are printed. Keep the existing
    # compiler-facing convention; this is not a change to the game's API.
    return re.sub(r"\.(vcss|vjs|vts|vxml)(?=[\"'])", r".\1_c", text).replace("\r\n", "\n")


def merge(local, base, upstream):
    return merge_text(local, base, upstream)


def mod_name(path):
    return pathlib.PurePosixPath(path).parts[0]


def plan(game, manifest, revision, allow_partial=False, accept_reviews=()):
    proposals, errors, blobs = {}, {}, {}

    def read(ref, path):
        key = (ref, path)
        if key not in blobs:
            result = subprocess.run(["git", "-C", str(game), "show", ref + ":" + path], capture_output=True)
            if result.returncode:
                subprocess.run(["git", "-C", str(game), "cat-file", "-e", ref + "^{commit}"],
                               check=True, capture_output=True)
                blobs[key] = None
            else:
                blobs[key] = normalize(result.stdout.decode("utf-8-sig"))
        return blobs[key]

    for entry in manifest["files"]:
        target = ROOT / entry["path"]
        try:
            new = read(revision, entry["upstream"])
            if entry["mode"] == "retired":
                if new is not None:
                    raise ValueError("retired native resource reappeared; review before re-enabling tracking")
                continue
            if new is None:
                raise ValueError("native resource was removed; retire or migrate this override explicitly")
            local = target.read_text(encoding="utf-8-sig")
            if entry["mode"] == "copy":
                content = new
            elif entry["mode"] == "extension":
                base_path = target.parent / "base" / target.name
                base_entry = next((item for item in manifest["files"]
                                   if ROOT / item["path"] == base_path and item["mode"] == "copy"
                                   and item["upstream"] == entry["upstream"]), None)
                include = f's2r://panorama/styles/base/{target.stem}.vcss_c'
                imports = re.findall(r'@import\s+url\(\s*(["\'])(.*?)\1\s*\)',
                                     re.sub(r'/\*.*?\*/', '', local, flags=re.S))
                if base_entry is None or include not in {source for _, source in imports}:
                    raise ValueError("CSS extension has no matching tracked native base import")
                content = local
            elif entry["mode"] in ("merge", "owned"):
                old = read(entry["base"], entry["upstream"])
                if old is None:
                    raise ValueError("native merge base is missing")
                if entry["mode"] == "owned" and old != new and entry["path"] not in accept_reviews:
                    raise ValueError("fully owned override changed upstream; manual compatibility review required")
                if old == new or entry["mode"] == "owned":
                    content = local
                elif target.suffix == ".xml":
                    content = merge_xml(local, old, new)
                else:
                    content = merge(local, old, new)
            else:
                raise ValueError(f"Unknown update mode: {entry['mode']}")
            if target.suffix == ".xml":
                ET.fromstring(content)
            proposals[entry["path"]] = (target, content, local)
        except (ValueError, ET.ParseError, subprocess.CalledProcessError, OSError) as error:
            errors[entry["path"]] = str(error)
    if errors and not allow_partial:
        raise ValueError("\n".join(f"{path}: {error}" for path, error in errors.items()))
    blocked = {mod_name(path) for path in errors}
    updates = {}
    for entry in manifest["files"]:
        path = entry["path"]
        if path in errors:
            entry["pending"] = {"revision": revision, "reason": errors[path]}
        else:
            entry.pop("pending", None)
        if mod_name(path) in blocked or entry["mode"] == "retired":
            continue
        target, content, local = proposals[path]
        if content != local:
            updates[target] = content
        entry["base"] = revision
    return updates


def review(manifest, revision, output):
    pending = [{"path": entry["path"], **entry["pending"]}
               for entry in manifest["files"] if "pending" in entry]
    summary = {"revision": revision, "blocked_mods": sorted({mod_name(item["path"]) for item in pending}),
               "pending": pending}
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    lines = ["# Native resource review", "", f"Upstream: `{revision}`", "",
             "Blocked mods are excluded from publication; their sources and merge bases are preserved.", "",
             "| File | Reason |", "| --- | --- |"]
    lines += [f"| `{item['path']}` | {item['reason'].replace('|', '/').replace(chr(10), ' ')} |" for item in pending]
    if not pending:
        lines.append("No unresolved overrides.")
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-root", required=True, type=pathlib.Path)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--check", action="store_true", help="report pending updates without writing")
    parser.add_argument("--allow-partial", action="store_true", help="update only mods without unresolved overrides")
    parser.add_argument("--accept-review", action="append", default=[], metavar="MOD_PATH",
                        help="acknowledge a reviewed fully owned replacement at this revision")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / ".upstream-review")
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "-C", str(args.game_root), "rev-parse", args.revision], text=True
    ).strip()
    original = MANIFEST.read_text(encoding="utf-8")
    manifest = json.loads(original)
    try:
        unknown = set(args.accept_review) - {entry["path"] for entry in manifest["files"]}
        if unknown:
            raise ValueError("Unknown review paths: " + ", ".join(sorted(unknown)))
        updates = plan(args.game_root, manifest, revision, args.allow_partial, args.accept_review)
    except ValueError as error:
        parser.exit(1, f"Update aborted; no files written:\n{error}\n")
    for file in updates:
        print(file.relative_to(ROOT).as_posix())
    print(f"{len(updates)} source files changed at {revision[:12]}")
    summary = review(manifest, revision, args.output)
    if summary["blocked_mods"]:
        print("Manual review required: " + ", ".join(summary["blocked_mods"]))
    if args.check:
        return 1 if updates or summary["blocked_mods"] else 0
    for file, content in updates.items():
        file.write_text(content, encoding="utf-8", newline="\n")
    # Advance per-file bases only after the entire plan merges and validates.
    serialized = json.dumps(manifest, indent=2) + "\n"
    if serialized != original:
        MANIFEST.write_text(serialized, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
