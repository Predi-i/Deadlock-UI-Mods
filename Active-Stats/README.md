# Active Stats

Mirrors the active modifiers from the native `hudActivePlayerStats` panel beside
the crosshair. The October 2026 layout separates the weapon, spirit and vitality
columns under `StatList`; weapon power and spirit power belong to `HudStatBlock`.
The script resolves its own native ancestor and reads only these branches.

Values use the native `statNumber` and optional `statPostfix` labels. The core
panel is identified by its class, not by an invented ID. Caster affiliation uses
the direct `casterSnippet` children without scanning each caster's modifiers.
The removed bullet-evasion and damage-amplification containers are no longer
polled. Existing polling rates and presentation settings remain unchanged.

The scoreboard class and event both suppress the readout. Reload retires the
previous tick and listener; destroyed source panels and labels are resolved again.

Run the offline capture regression from the repository root:

```text
node tools/audit_hud_lookups.cjs <full-capture.json> [baseline-git-ref]
```

This counts JavaScript tree operations and checks modifier values, scoreboard
recovery and reload. It does not measure native performance or rendering. After
compiling/repacking, check buffs/debuffs, postfix units, death/respawn and scoreboard
transitions in the client, including core weapon/spirit modifiers.
