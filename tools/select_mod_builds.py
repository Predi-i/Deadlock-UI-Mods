"""Select source changes since the last successful publication, including retries."""
import argparse
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
NICKNAMES = {"Show-Nicknames-In-TopBar", "Show-Nicknames-In-TopBar-No-Offsets"}


def source_hash(mod):
    digest = hashlib.sha256()
    for file in sorted((mod / "panorama").rglob("*")):
        if not file.is_file():
            continue
        digest.update(file.relative_to(mod).as_posix().encode())
        digest.update(b"\0")
        # Checkout line endings must not make identical sources look changed.
        data = file.read_bytes()
        if file.suffix in (".xml", ".js", ".css", ".svg", ".html", ".json", ".txt"):
            data = data.replace(b"\r\n", b"\n")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def select(previous, force=False):
    hashes = {mod.name: source_hash(mod) for mod in sorted(ROOT.iterdir())
              if mod.is_dir() and (mod / "panorama").is_dir()}
    mods = [mod for mod, value in hashes.items() if force or previous.get(mod) != value]
    nicknames = bool(NICKNAMES.intersection(mods))
    if nicknames:
        mods = sorted(set(mods) | NICKNAMES)
    return {"hashes": hashes, "mods": mods, "nicknames": nicknames}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--all", default="false", choices=("true", "false"))
    args = parser.parse_args()
    state = ROOT / ".github/mod-build-state.json"
    previous = json.loads(state.read_text())["hashes"] if state.exists() else {}
    result = select(previous, args.all == "true")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("Builds: " + ", ".join(result["mods"]))


if __name__ == "__main__":
    main()
