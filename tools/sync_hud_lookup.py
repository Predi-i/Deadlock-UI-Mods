"""Copy the shared lookup source into mods that ship it as a standalone asset."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODS = ("Anti-Toxic-Chat", "Bridge-Buff-Reminder", "Good-Game-After-Death",
        "Well-Played-On-Kill", "Parry-Cooldown", "Minimap-Cheat", "Rem-Bug-Abuse",
        "Minigames", "DL-Arcade-Cloudflare")


def main():
    source = (ROOT / "tools/hud_lookup.js").read_bytes()
    for mod in MODS:
        target = ROOT / mod / "panorama/scripts/hud_lookup.js"
        if not target.exists() or target.read_bytes() != source:
            target.write_bytes(source)


if __name__ == "__main__":
    main()
