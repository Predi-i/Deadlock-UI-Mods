"""Accept native base CSS copies independently of resources that need review."""
import argparse
import copy
import hashlib
import json
import os
import pathlib
import re
import subprocess

from mod_releases import CATALOG, CONTENT_ROOTS, ROOT, TEXT_ASSETS, hashes
from update_mods import review

MARKER = re.compile(r"^native-css-auto:(\{[^\n]+\})$", re.M)
MANIFEST = "tools/upstream.json"


def git(*args, input=None):
    result = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=ROOT, input=input, capture_output=True)
    if result.returncode:
        raise RuntimeError("Git " + args[0] + " failed: " + result.stderr.decode(errors="replace"))
    return result.stdout


def copied_css(entry):
    path = pathlib.PurePosixPath(entry["path"])
    return entry.get("mode") == "copy" and path.suffix == ".css" and path.parts[1:4] == ("panorama", "styles", "base")


def select(summary, manifest, changed_paths, catalog=CATALOG):
    entries = {entry["path"]: entry for entry in manifest["files"]}
    selected = []
    for mod, config in catalog.items():
        sources = set(config["sources"])
        changes = [item for item in summary["changes"] if item["path"].split("/")[0] in sources]
        dirty = {path for path in changed_paths if path.split("/")[0] in sources}
        copies = {path for path, entry in entries.items() if path.split("/")[0] in sources and copied_css(entry)}
        if not changes or not dirty or not dirty.issubset(copies):
            continue
        if any("pending" in entry for entry in entries.values() if entry["path"].split("/")[0] in sources):
            continue
        for item in changes:
            entry = entries.get(item["path"], {})
            is_extension = entry.get("mode") == "extension" and item["path"].endswith(".css") and item["path"] not in dirty
            if item["status"] != "updated" or not (item["path"] in copies or is_extension):
                break
        else:
            selected.append(mod)
    return selected


def asset_paths(ref, sources):
    return git("ls-tree", "-r", "--name-only", ref, "--",
               *[source + "/" + root for source in sources for root in sorted(CONTENT_ROOTS)]).decode().splitlines()


def css_delta(base, current, sources, manifest):
    allowed = {entry["path"] for entry in manifest["files"] if copied_css(entry) and entry["path"].split("/")[0] in sources}
    before, after = set(asset_paths(base, sources)), set(asset_paths(current, sources))
    changed = []
    for path in sorted(before | after):
        a = git("show", base + ":" + path) if path in before else None
        b = git("show", current + ":" + path) if path in after else None
        if pathlib.PurePosixPath(path).suffix.lower() in TEXT_ASSETS:
            a = a.replace(b"\r\n", b"\n") if a is not None else None
            b = b.replace(b"\r\n", b"\n") if b is not None else None
        if a != b:
            if path not in allowed or path not in before or path not in after:
                return False, [path]
            changed.append(path)
    return bool(changed), changed


def attested(mod, current_hashes):
    commits = git("log", "HEAD", "--grep=^native-css-auto:", "--format=%H").decode().splitlines()
    for commit in commits:
        message = git("show", "-s", "--format=%B", commit).decode()
        for match in MARKER.finditer(message):
            if json.loads(match[1]).get(mod) == current_hashes:
                return True
    return False


def accept(directory, base="main", dry_run=False):
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    dirty = git("diff", "--name-only").decode().splitlines()
    mods = select(summary, manifest, dirty, catalog=CATALOG)
    result = {"mods": mods, "commit": ""}
    if not mods or dry_run:
        print("Automatic base CSS candidates: " + ", ".join(mods))
        return result
    if git("diff", "--cached", "--name-only").strip():
        raise RuntimeError("Unexpected staged changes; base CSS was not committed")
    git("fetch", "origin", base)
    if git("rev-parse", "HEAD").strip() != git("rev-parse", "origin/" + base).strip():
        raise RuntimeError("Main changed during the native check; retry without overwriting it")
    original = json.loads(git("show", "HEAD:" + MANIFEST))
    sources = {source for mod in mods for source in CATALOG[mod]["sources"]}
    entries = {entry["path"]: entry for entry in manifest["files"]}
    if {entry["path"] for entry in original["files"] if entry["path"].split("/")[0] in sources} != {entry["path"] for entry in manifest["files"] if entry["path"].split("/")[0] in sources}:
        raise RuntimeError("Tracking entries changed; base CSS was not committed")
    partial = copy.deepcopy(original)
    for index, entry in enumerate(partial["files"]):
        if entry["path"].split("/")[0] in sources:
            updated = entries[entry["path"]]
            if any(entry.get(key) != updated.get(key) for key in ("mode", "upstream")):
                raise RuntimeError("Tracking contract changed; base CSS was not committed")
            partial["files"][index] = updated
    paths = [path for path in dirty if path.split("/")[0] in sources]
    expected = {item["path"]: item["source_sha256"] for item in summary["changes"]}
    if any(hashlib.sha256((ROOT / path).read_text(encoding="utf-8-sig").encode()).hexdigest() != expected.get(path) for path in paths):
        raise RuntimeError("Base CSS changed after its native proposal; no source committed")
    git("add", "--", *paths)
    blob = git("hash-object", "-w", "--stdin", input=(json.dumps(partial, indent=2) + "\n").encode()).decode().strip()
    git("update-index", "--cacheinfo", "100644", blob, MANIFEST)
    git("config", "user.name", "Predi-i")
    git("config", "user.email", "Predi-i@users.noreply.github.com")
    message = "chore: refresh native base CSS\n\nnative-css-auto:" + json.dumps({mod: hashes(mod) for mod in mods}, sort_keys=True)
    git("commit", "-m", message)
    git("push", "origin", "HEAD:refs/heads/" + base)
    result["commit"] = git("rev-parse", "HEAD").decode().strip()
    remaining = [item for item in summary["changes"] if item["path"].split("/")[0] not in sources]
    review(manifest, summary["revision"], directory, remaining)
    (directory / "automatic-css.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("Automatically accepted native base CSS: " + ", ".join(mods))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / ".upstream-review")
    parser.add_argument("--base", default=os.environ.get("BASE_BRANCH", "main"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    result = accept(args.output, args.base, args.dry_run)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write("commit=" + result["commit"] + "\n")


if __name__ == "__main__":
    main()
