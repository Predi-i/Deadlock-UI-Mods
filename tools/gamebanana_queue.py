"""Report compiled mod releases that have no acknowledged GameBanana publication."""
import argparse
import json
import os
import pathlib
import tempfile

from mod_releases import CATALOG, ROOT, hashes, latest, read_releases, gh
from notify_mod_updates import send


def download_record(repository, release, name):
    if name not in {asset["name"] for asset in release["assets"]}:
        return None
    with tempfile.TemporaryDirectory() as folder:
        gh("release", "download", release["tag"], "--repo", repository, "--pattern", name, "--dir", folder)
        return json.loads((pathlib.Path(folder) / name).read_text(encoding="utf-8"))


def store_record(repository, tag, name, record):
    with tempfile.TemporaryDirectory() as folder:
        path = pathlib.Path(folder) / name
        path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        gh("release", "upload", tag, "--repo", repository, "--clobber", str(path))


def pending(repository, releases):
    ready, waiting = [], []
    current = latest(releases)
    manifest = json.loads((ROOT / "tools/upstream.json").read_text(encoding="utf-8"))
    blocked = {entry["path"].split("/")[0] for entry in manifest["files"] if "pending" in entry}
    for mod, config in CATALOG.items():
        if not config["gamebanana_id"]:
            continue
        if blocked.intersection(config["sources"]):
            waiting.append({"mod": mod, "reason": "unresolved native overrides"})
            continue
        release = current.get(mod)
        if release is None or release["hashes"] != hashes(mod):
            waiting.append({"mod": mod, "reason": "waiting for a matching compiled release"})
            continue
        published = download_record(repository, release, "gamebanana-published.json")
        if published and published.get("hashes") == release["hashes"] and published.get("update_id"):
            continue
        notified = download_record(repository, release, "gamebanana-notified.json")
        ready.append({**release, "gamebanana_id": config["gamebanana_id"],
                      "notified": bool(notified and notified.get("hashes") == release["hashes"])})
    return {"ready": ready, "waiting": waiting}


def notify(repository, queue):
    # Chunk before delivery so a truncated message can never acknowledge omitted mods.
    chunks, batch, size = [], [], 0
    for item in queue["ready"]:
        if item["notified"]:
            continue
        line = f"\n- {item['mod']}\n  {item['url']}"
        if size + len(line) > 1500 and batch:
            chunks.append(batch)
            batch, size = [], 0
        batch.append((item, line))
        size += len(line)
    if batch:
        chunks.append(batch)
    for batch in chunks:
        content = ("Compiled UI Mods need a GameBanana update.\nChoose a mod in the Publish GameBanana update action:\n"
                   f"https://github.com/{repository}/actions/workflows/gamebanana-update.yml" +
                   "".join(line for _, line in batch))
        if not send(content):
            return
        for item, _ in batch:
            store_record(repository, item["tag"], "gamebanana-notified.json", {"hashes": item["hashes"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--notify", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / ".upstream-review/gamebanana-queue.json")
    args = parser.parse_args()
    if not args.repository:
        parser.error("Specify the GitHub repository")
    queue = pending(args.repository, read_releases(args.repository))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(queue, indent=2) + "\n", encoding="utf-8")
    for item in queue["ready"]:
        print("GameBanana update ready: " + item["mod"])
    for item in queue["waiting"]:
        print(item["mod"] + ": " + item["reason"])
    if args.notify:
        notify(args.repository, queue)


if __name__ == "__main__":
    main()
