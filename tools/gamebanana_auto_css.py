"""Publish acknowledged-baseline CSS updates, and notify only after GB success."""
import argparse
import json
import os

from base_css_updates import attested, css_delta
from gamebanana_queue import download_record, store_record, notify_published
from mod_releases import CATALOG, ROOT, latest, read_releases, gh, MARKER, hashes
from notify_mod_updates import send


def published_baseline(repository, mod, releases):
    for release in sorted(releases, key=lambda item: item.get("published_at") or "", reverse=True):
        if release.get("draft") or release.get("prerelease"):
            continue
        marker = MARKER.search(release.get("body") or "")
        if not marker:
            continue
        record = json.loads(marker[1])
        if record.get("mod") != mod:
            continue
        candidate = {**record, "tag": release["tag_name"], "assets": release["assets"]}
        receipt = download_record(repository, candidate, "gamebanana-published.json")
        if receipt and receipt.get("hashes") == record.get("hashes") and receipt.get("update_id"):
            return {**candidate, "receipt": receipt}
    return None


def eligibility(repository, mod, releases, manifest):
    release = latest(releases).get(mod)
    current = hashes(mod)
    if not CATALOG[mod]["gamebanana_id"]:
        return None, "No verified GameBanana submission"
    if any("pending" in entry for entry in manifest["files"] if entry["path"].split("/")[0] in CATALOG[mod]["sources"]):
        return None, "Unresolved native resources"
    done = download_record(repository, release, "gamebanana-published.json") if release and release["hashes"] == current else None
    if done and done.get("hashes") == current and done.get("update_id"):
        notice = download_record(repository, release, "gamebanana-published-notified.json")
        if (done.get("automatic_css") or done.get("notification_requested")) and (not notice or notice.get("update_id") != done["update_id"]):
            return {"mod": mod, "publish": False}, "Retry success notification"
        return None, "Already published"
    if not attested(mod, current):
        return None, "No automatic native base CSS checkpoint"
    if not release or release["hashes"] != current:
        return None, "Waiting for matching compiled release"
    base = published_baseline(repository, mod, releases)
    if not base:
        return None, "GB source baseline unknown; publish the reviewed version manually once"
    safe, paths = css_delta(base["commit"], release["commit"], CATALOG[mod]["sources"], manifest)
    if not safe:
        return None, "Changes since GB include XML/custom assets or no base CSS changes: " + ", ".join(paths)
    return {"mod": mod, "publish": True, "baseline": base["receipt"]}, "Only tracked native base CSS differs from the last GB publication"


def plan(repository):
    releases = read_releases(repository)
    manifest = json.loads((ROOT / "tools/upstream.json").read_text(encoding="utf-8"))
    tasks, needs_build = [], False
    for mod in sorted(CATALOG):
        task, reason = eligibility(repository, mod, releases, manifest)
        print(mod + ": " + reason)
        if task:
            tasks.append(task)
        needs_build |= reason == "Waiting for matching compiled release"
    # GITHUB_TOKEN pushes do not trigger push workflows. Acceptance dispatches
    # the first build; a scheduled check retries failed dispatch/build attempts.
    if needs_build and os.environ.get("GITHUB_EVENT_NAME") in ("schedule", "workflow_dispatch"):
        gh("workflow", "run", "mod-releases.yml", "--repo", repository, "--ref", "main")
    return tasks


def failure_notice(repository, mod):
    release = latest(read_releases(repository)).get(mod)
    if not release:
        return
    done = download_record(repository, release, "gamebanana-published.json")
    if done and done.get("hashes") == release["hashes"] and done.get("update_id"):
        print("GameBanana publication succeeded; Discord success notification remains retryable")
        return
    previous = download_record(repository, release, "gamebanana-auto-failure-notified.json")
    if previous and previous.get("hashes") == release["hashes"]:
        return
    run = os.environ.get("GITHUB_RUN_ID", "")
    if send(f"Automatic base CSS publication needs attention: {mod}.\n"
            "GameBanana publication was not acknowledged. Inspect the run before retrying:\n"
            f"https://github.com/{repository}/actions/runs/{run}"):
        store_record(repository, release["tag"], "gamebanana-auto-failure-notified.json", {"hashes": release["hashes"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("plan", "publish", "failure"))
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--mod")
    args = parser.parse_args()
    if not args.repository:
        parser.error("Specify the GitHub repository")
    if args.operation == "plan":
        result = {"include": plan(args.repository)}
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write("matrix=" + json.dumps(result) + "\n")
                stream.write("changed=" + str(bool(result["include"])).lower() + "\n")
    elif args.mod not in CATALOG:
        parser.error("Select a catalog mod")
    elif args.operation == "failure":
        failure_notice(args.repository, args.mod)
    else:
        from gamebanana_api import publish
        manifest = json.loads((ROOT / "tools/upstream.json").read_text(encoding="utf-8"))
        task, reason = eligibility(args.repository, args.mod, read_releases(args.repository), manifest)
        if not task:
            print("Automatic publication skipped: " + reason)
            return
        if task["publish"]:
            publish(args.repository, args.mod, automatic_css=True, expected_base=task["baseline"])
        if not notify_published(args.repository, args.mod):
            raise RuntimeError("Publication succeeded but Discord delivery was not acknowledged; notification remains retryable")


if __name__ == "__main__":
    main()
