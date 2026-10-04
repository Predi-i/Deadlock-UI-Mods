"""Build GameBanana releases locally and package each VPK in its own ZIP."""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTENT_ROOTS = {
    "panorama", "soundevents", "sounds", "materials", "models", "particles",
    "scripts", "resource", "maps", "shaders", "vscripts",
}
# Published mods whose sources exist here (including the paired nickname variant).
PUBLISHED = {
    "Active-Stats", "Anti-Toxic-Chat", "Good-Game-After-Death",
    "Well-Played-On-Kill", "DL-Arcade-Cloudflare", "Match-History-Cards-Redesign",
    "Commend-Everyone-Button", "Parry-Cooldown", "Bridge-Buff-Reminder",
    "Old-Minimap-Player-Icon", "Show-Nicknames-Above-Heroes", "Old-Progress-Bars",
    "Show-Nicknames-In-TopBar", "Show-Nicknames-In-TopBar-No-Offsets",
    "No-Incoming-Damage", "Smaller-Commend-Box",
}
NICKNAMES = {"Show-Nicknames-In-TopBar", "Show-Nicknames-In-TopBar-No-Offsets"}
BRIDGE_TIMES = (290, 285, 280, 275, 270)


def git(*args, root=ROOT):
    return subprocess.check_output(
        ["git", "-c", "core.quotepath=false", *args], cwd=root, encoding="utf-8"
    )


def changed_mods(since, root=ROOT):
    # Include intervening edits, even when a later commit reverted a file, as well
    # as local tracked/untracked assets. Documentation alone does not select a mod.
    paths = git("log", f"--since={since}", "--format=", "--name-only", root=root).splitlines()
    paths += git("diff", "HEAD", "--name-only", root=root).splitlines()
    paths += git("ls-files", "--others", "--exclude-standard", root=root).splitlines()
    mods = set()
    for path in paths:
        parts = pathlib.PurePosixPath(path).parts
        if len(parts) > 2 and parts[0] in PUBLISHED and parts[1] in CONTENT_ROOTS:
            mods.add(parts[0])
    if mods & NICKNAMES:
        mods |= NICKNAMES
    return sorted(mods)


def release_plan(mods):
    plan = []
    for mod in sorted(set(mods)):
        if mod not in PUBLISHED:
            raise ValueError(f"Not in the published mod catalog: {mod}")
        if mod == "Bridge-Buff-Reminder":
            for seconds in BRIDGE_TIMES:
                name = f"{mod}-{seconds // 60}m{seconds % 60:02d}s"
                plan.append({"mod": mod, "name": name, "first_alert": seconds})
        else:
            plan.append({"mod": mod, "name": mod, "first_alert": None})
    return plan


def set_bridge_time(source, seconds):
    pattern = r"(\bFIRST_ALERT\s*:\s*)\d+(\s*,)(?:[^\S\r\n]*//[^\r\n]*)?"
    updated, count = re.subn(
        pattern, lambda m: f"{m[1]}{seconds}{m[2]} // {seconds // 60}:{seconds % 60:02d}", source
    )
    if count != 1:
        raise ValueError("Expected exactly one FIRST_ALERT in buff_reminder.js")
    return updated


def prepare_source(item, staging, root=ROOT):
    source = root / item["mod"]
    target = staging / item["name"]
    if not (source / "panorama").is_dir():
        raise ValueError(f"Missing Panorama sources: {source}")
    target.mkdir()
    for name in sorted(CONTENT_ROOTS):
        if (source / name).is_dir():
            shutil.copytree(source / name, target / name, ignore=shutil.ignore_patterns(".*"))
    if item["first_alert"] is not None:
        script = target / "panorama/scripts/buff_reminder.js"
        script.write_text(set_bridge_time(script.read_text(encoding="utf-8-sig"),
                                         item["first_alert"]), encoding="utf-8")
    return target


def archive_vpk(vpk, destination):
    if not vpk.is_file() or not vpk.stat().st_size:
        raise ValueError(f"Missing or empty VPK: {vpk}")
    # The local packer produces a single VPK. Fail instead of silently shipping
    # an incomplete release if its output format changes to split volumes.
    if list(vpk.parent.glob(f"{vpk.stem.removesuffix('_dir')}_[0-9][0-9][0-9].vpk")):
        raise ValueError(f"Split VPK output is not supported: {vpk}")
    temporary = destination.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(vpk, arcname=vpk.name)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None or archive.namelist() != [vpk.name]:
                raise ValueError(f"ZIP verification failed: {destination}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def build_releases(plan, output):
    output = output.resolve()
    # Every invocation uses a new directory: stale archives cannot masquerade as
    # successful builds, and previous release batches remain available.
    output.mkdir(parents=True, exist_ok=False)
    report = {"commit": git("rev-parse", "HEAD").strip(), "complete": False, "releases": []}
    report_path = output / "release-report.json"

    def save_report():
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    save_report()
    with tempfile.TemporaryDirectory(prefix="deadlock-releases-") as temporary:
        staging = pathlib.Path(temporary).resolve()
        for index, item in enumerate(plan, 1):
            print(f"\n[{index}/{len(plan)}] {item['name']}", flush=True)
            record = {**item, "status": "building"}
            report["releases"].append(record)
            save_report()
            try:
                source = prepare_source(item, staging)
                vpk = output / f"{item['name']}.vpk"
                command = [
                    shutil.which("pwsh") or "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(ROOT / "tools/build_mod.ps1"),
                    "-ModFolderName", item["name"], "-Batch", "-Force",
                    "-SourcePath", str(source), "-OutputPath", str(vpk),
                ]
                log = output / f"{item['name']}.log"
                with log.open("w", encoding="utf-8") as stream:
                    result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
                if result.returncode:
                    raise RuntimeError(f"Build failed (exit {result.returncode}); see {log}")
                destination = output / f"{item['name']}.zip"
                archive_vpk(vpk, destination)
                with vpk.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                record.update(status="ready", zip=destination.name, vpk_sha256=digest)
                print(f"  Ready: {destination.name}", flush=True)
            except Exception as error:
                record.update(status="failed", error=str(error))
                save_report()
                raise
            save_report()
    report["complete"] = True
    save_report()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--since", help="Select published mods with asset edits since this date")
    selection.add_argument("--all", action="store_true", help="Build every published mod in the catalog")
    selection.add_argument("--mods", nargs="+", choices=sorted(PUBLISHED))
    parser.add_argument("--plan", action="store_true", help="Print selection without building or writing files")
    parser.add_argument("--output", type=pathlib.Path, help="New output directory (must not exist)")
    args = parser.parse_args()
    if not (args.since or args.all or args.mods):
        suggested = dt.date.today().replace(day=1).isoformat()
        args.since = input(f"Asset changes since [YYYY-MM-DD; Enter = {suggested}, all = every mod]: ").strip()
        if args.since.lower() == "all":
            args.all = True
        else:
            args.since = args.since or suggested
    if args.since:
        # Make midnight explicit; Git's date-only parsing otherwise retains the
        # current time of day and can omit commits made earlier on the first day.
        since = dt.datetime.combine(dt.date.fromisoformat(args.since), dt.time()).astimezone().isoformat()
        mods = changed_mods(since)
    else:
        mods = args.mods or sorted(PUBLISHED)
    plan = release_plan(mods)
    for item in plan:
        print(f"  {item['name']}.zip")
    print(f"\n{len(mods)} mods, {len(plan)} ZIP archives.", flush=True)
    if args.plan or not plan:
        return
    output = args.output or ROOT / "tools/releases" / dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
    print(f"Output: {build_releases(plan, output)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"ERROR: {error}")
