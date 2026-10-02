"""Rebase native overrides on a pinned GameTracking checkout (source only)."""
import argparse
import json
import pathlib
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tools/upstream.json"


def normalize(text):
    # Viewer changed how compiled references are printed. Keep the existing
    # compiler-facing convention; this is not a change to the game's API.
    return re.sub(r"\.(vcss|vjs|vts|vxml)(?=[\"'])", r".\1_c", text).replace("\r\n", "\n")


def merge(local, base, upstream):
    with tempfile.TemporaryDirectory() as folder:
        files = [pathlib.Path(folder) / name for name in ("mod", "base", "upstream")]
        for file, content in zip(files, (local, base, upstream)):
            file.write_text(content, encoding="utf-8", newline="\n")
        result = subprocess.run(["git", "merge-file", "-p", *map(str, files)], capture_output=True)
        if result.returncode:
            raise ValueError("native changes overlap mod edits; resolve manually before updating the base")
        return result.stdout.decode("utf-8").replace("\r\n", "\n")


def plan(game, manifest, revision):
    updates = {}
    errors = []
    for entry in manifest["files"]:
        target = ROOT / entry["path"]
        try:
            new = normalize(subprocess.check_output(
                ["git", "-C", str(game), "show", revision + ":" + entry["upstream"]]
            ).decode("utf-8-sig"))
            local = target.read_text(encoding="utf-8-sig")
            if entry["mode"] == "copy":
                content = new
            elif entry["mode"] in ("merge", "owned"):
                old = normalize(subprocess.check_output(
                    ["git", "-C", str(game), "show", entry["base"] + ":" + entry["upstream"]]
                ).decode("utf-8-sig"))
                if entry["mode"] == "owned" and old != new:
                    raise ValueError("fully owned override changed upstream; manual compatibility review required")
                content = local if old == new else merge(local, old, new)
            else:
                raise ValueError(f"Unknown update mode: {entry['mode']}")
            if target.suffix == ".xml":
                ET.fromstring(content)
            if content != local:
                updates[target] = content
            entry["base"] = revision
        except (ValueError, ET.ParseError, subprocess.CalledProcessError) as error:
            errors.append(f"{entry['path']}: {error}")
    if errors:
        raise ValueError("\n".join(errors))
    return updates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-root", required=True, type=pathlib.Path)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--check", action="store_true", help="report pending updates without writing")
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "-C", str(args.game_root), "rev-parse", args.revision], text=True
    ).strip()
    original = MANIFEST.read_text(encoding="utf-8")
    manifest = json.loads(original)
    try:
        updates = plan(args.game_root, manifest, revision)
    except ValueError as error:
        parser.exit(1, f"Update aborted; no files written:\n{error}\n")
    for file in updates:
        print(file.relative_to(ROOT).as_posix())
    print(f"{len(updates)} source files changed at {revision[:12]}")
    if args.check:
        return 1 if updates else 0
    for file, content in updates.items():
        file.write_text(content, encoding="utf-8", newline="\n")
    # Advance per-file bases only after the entire plan merges and validates.
    serialized = json.dumps(manifest, indent=2) + "\n"
    if serialized != original:
        MANIFEST.write_text(serialized, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
