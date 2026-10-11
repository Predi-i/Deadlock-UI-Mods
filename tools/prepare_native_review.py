"""Maintain one source-only native update PR without replacing maintainer edits."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BRANCH = "codex/native-resource-update"
SUBJECT = "chore: review updated native resources"


def command(*args, check=True):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed: {result.stderr.strip()}")
    return result


def body_file(text, operation):
    with tempfile.TemporaryDirectory() as folder:
        path = pathlib.Path(folder) / "body.md"
        path.write_text(text, encoding="utf-8")
        return operation(str(path))


def mark_notified(url, fingerprint):
    body = json.loads(command("gh", "pr", "view", url, "--json", "body").stdout)["body"]
    marker = f"<!-- notified:{fingerprint} -->"
    if marker not in body:
        body_file(body.rstrip() + "\n\n" + marker + "\n",
                  lambda path: command("gh", "pr", "edit", url, "--body-file", path))


def prepare(directory, base, dry_run=False):
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    result = {"changed": summary["changed"], "fingerprint": summary["fingerprint"], "notified": False, "pr_url": ""}
    if not summary["changed"] or dry_run:
        return result
    fingerprint = summary["fingerprint"]
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise ValueError("Invalid review fingerprint")
    marker = f"<!-- native-review:{fingerprint} -->"
    reviews = json.loads(command("gh", "pr", "list", "--head", BRANCH, "--base", base,
                                 "--state", "all", "--limit", "100", "--json", "url,body,state").stdout)
    opened = [review for review in reviews if review.get("state", "OPEN") == "OPEN"]
    if not opened and any(marker in review["body"] for review in reviews):
        print("This unchanged native proposal was already closed or merged; no replacement PR created.")
        return result
    if opened and marker in opened[0]["body"]:
        result.update(pr_url=opened[0]["url"], notified=f"<!-- notified:{fingerprint} -->" in opened[0]["body"])
        (directory / "pr-url.txt").write_text(result["pr_url"] + "\n", encoding="utf-8")
        return result
    # Fetching all branches makes the lease and maintainer-commit check authoritative.
    command("git", "fetch", "origin", "+refs/heads/*:refs/remotes/origin/*")
    ref = f"refs/remotes/origin/{BRANCH}"
    exists = command("git", "rev-parse", "--verify", ref, check=False)
    previous = exists.stdout.strip() if exists.returncode == 0 else ""
    if previous:
        subjects = command("git", "log", f"origin/{base}..{ref}", "--format=%s").stdout.splitlines()
        if any(subject != SUBJECT for subject in subjects):
            raise RuntimeError("The review branch contains maintainer commits. Merge or preserve those fixes before regenerating it.")
        recorded_heads = {match[1] for review in reviews
                          for match in re.finditer(r"<!-- native-commit:([0-9a-f]{40}) -->", review["body"])}
        if subjects and reviews and previous not in recorded_heads:
            raise RuntimeError("The review branch changed after the bot recorded it. Preserve amended maintainer fixes before regenerating it.")
    tracked = command("git", "ls-files").stdout.splitlines()
    sources = [path for path in tracked if len(path.split("/")) > 2 and path.split("/")[1] == "panorama"]
    command("git", "add", "--", "tools/upstream.json", *sources)
    diff = command("git", "diff", "--cached", "--quiet", check=False)
    if diff.returncode == 0:
        print("No source or tracking changes to propose; unresolved overrides remain in the report.")
        return result
    if diff.returncode != 1:
        raise RuntimeError("Could not inspect staged source changes")
    command("git", "switch", "-C", BRANCH)
    command("git", "config", "user.name", "Predi-i")
    command("git", "config", "user.email", "Predi-i@users.noreply.github.com")
    command("git", "commit", "-m", SUBJECT)
    commit = command("git", "rev-parse", "HEAD").stdout.strip()
    command("git", "push", f"--force-with-lease=refs/heads/{BRANCH}:{previous}", "origin", f"HEAD:refs/heads/{BRANCH}")
    body = ((directory / "report.md").read_text(encoding="utf-8").rstrip() + "\n\n" + marker +
            f"\n<!-- native-commit:{commit} -->\n")
    if opened:
        url = opened[0]["url"]
        body_file(body, lambda path: command("gh", "pr", "edit", url, "--body-file", path))
    else:
        url = body_file(body, lambda path: command("gh", "pr", "create", "--head", BRANCH, "--base", base,
                                                  "--title", "Review updated native resources", "--body-file", path)).stdout.strip()
    (directory / "pr-url.txt").write_text(url + "\n", encoding="utf-8")
    result["pr_url"] = url
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / ".upstream-review")
    parser.add_argument("--base", default=os.environ.get("BASE_BRANCH", "main"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--acknowledge", action="store_true")
    args = parser.parse_args()
    if args.acknowledge:
        summary = json.loads((args.output / "summary.json").read_text(encoding="utf-8"))
        mark_notified((args.output / "pr-url.txt").read_text().strip(), summary["fingerprint"])
        return
    result = prepare(args.output, args.base, args.dry_run)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            for key, value in result.items():
                stream.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")


if __name__ == "__main__":
    main()
