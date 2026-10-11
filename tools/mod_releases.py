"""Plan separate mod releases and retain publication checkpoints outside main."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess

from package_releases import CONTENT_ROOTS, release_plan, prepare_source

ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / "tools/release_catalog.json").read_text(encoding="utf-8"))
MARKER = re.compile(r"<!-- mod-release:(\{[^\n]+\}) -->")


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=True)
    return result.stdout


def asset_hash(mod, root=ROOT):
    digest = hashlib.sha256()
    for name in sorted(CONTENT_ROOTS):
        for path in sorted((root / mod / name).rglob("*")):
            if not path.is_file():
                continue
            digest.update(path.relative_to(root / mod).as_posix().encode() + b"\0")
            data = path.read_bytes()
            if path.suffix in (".xml", ".css", ".js", ".svg", ".json", ".html", ".txt"):
                data = data.replace(b"\r\n", b"\n")
            digest.update(data + b"\0")
    return digest.hexdigest()


def hashes(mod):
    return {source: asset_hash(source) for source in CATALOG[mod]["sources"]}


def read_releases(repository):
    pages = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repository}/releases?per_page=100"))
    return [record for page in pages for record in page]


def latest(releases):
    result = {}
    for release in sorted(releases, key=lambda value: value.get("published_at") or "", reverse=True):
        if release.get("draft") or release.get("prerelease"):
            continue
        marker = MARKER.search(release.get("body") or "")
        if not marker:
            continue
        record = json.loads(marker[1])
        mod = record.get("mod")
        if mod in CATALOG and mod not in result and set(record.get("hashes", {})) == set(CATALOG[mod]["sources"]):
            result[mod] = {**record, "tag": release["tag_name"], "url": release["html_url"], "assets": release["assets"]}
    return result


def selection(releases, commit, chosen=None):
    previous = latest(releases)
    manifest = json.loads((ROOT / "tools/upstream.json").read_text(encoding="utf-8"))
    blocked = {entry["path"].split("/")[0] for entry in manifest["files"] if "pending" in entry}
    if chosen and chosen not in CATALOG:
        raise ValueError("Unknown release catalog mod")
    selected = []
    for mod in sorted([chosen] if chosen else CATALOG):
        if blocked.intersection(CATALOG[mod]["sources"]):
            continue
        current = hashes(mod)
        if mod in previous and previous[mod]["hashes"] == current:
            continue
        selected.append({"mod": mod, "commit": commit, "hashes": current, "tag": f"mods/{mod}/{commit}"})
    return selected


def write_manifest(mod, commit, folder):
    records = []
    for item in release_plan(CATALOG[mod]["sources"]):
        file = folder / (item["name"] + ".zip")
        if not file.is_file() or not file.stat().st_size:
            raise ValueError("Missing release archive: " + file.name)
        records.append({"name": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                        "size": file.stat().st_size})
    record = {"mod": mod, "commit": commit, "hashes": hashes(mod), "files": records}
    (folder / "release.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    notes = (f"{mod}\n\nSource commit: `{commit}`.\n\n"
             "These archives contain only this mod and its supported variants.\n\n"
             f"<!-- mod-release:{json.dumps({key: record[key] for key in ('mod', 'commit', 'hashes')}, sort_keys=True)} -->\n")
    (folder / "release-notes.md").write_text(notes, encoding="utf-8")
    return record


def publish(mod, commit, folder, repository):
    record = write_manifest(mod, commit, folder)
    tag = f"mods/{mod}/{commit}"
    found = subprocess.run(["gh", "release", "view", tag, "--repo", repository], capture_output=True)
    if found.returncode == 0:
        existing = json.loads(gh("release", "view", tag, "--repo", repository, "--json", "isDraft,body"))
        marker = MARKER.search(existing.get("body") or "")
        expected = {key: record[key] for key in ("mod", "commit", "hashes")}
        if not marker or json.loads(marker[1]) != expected:
            raise ValueError("An existing tag has different release metadata; it was preserved")
        if not existing["isDraft"]:
            print("Release already published; immutable archives were preserved.")
            return
    else:
        gh("release", "create", tag, "--repo", repository, "--target", commit, "--draft", "--latest=false",
           "--title", f"{mod} ({commit[:7]})", "--notes-file", str(folder / "release-notes.md"))
    gh("release", "upload", tag, "--repo", repository, "--clobber", str(folder / "release.json"),
       *[str(folder / file["name"]) for file in record["files"]])
    gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest=false",
       "--notes-file", str(folder / "release-notes.md"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("plan", "publish", "stage"))
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--mod")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "builds")
    args = parser.parse_args()
    if not args.repository and args.operation != "stage":
        parser.error("Specify the GitHub repository")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if args.operation == "plan":
        result = {"include": selection(read_releases(args.repository), commit, args.mod)}
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "selection.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write("matrix=" + json.dumps(result) + "\n")
                stream.write(f"changed={str(bool(result['include'])).lower()}\n")
    elif args.operation == "stage" and args.mod in CATALOG:
        args.output.mkdir(parents=True, exist_ok=True)
        result = []
        for item in release_plan(CATALOG[args.mod]["sources"]):
            target = prepare_source(item, args.output)
            result.append({**item, "content": str(target)})
        (args.output / "build-plan.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    elif args.mod in CATALOG:
        publish(args.mod, commit, args.output, args.repository)
    else:
        parser.error("Select a catalog mod")


if __name__ == "__main__":
    main()
