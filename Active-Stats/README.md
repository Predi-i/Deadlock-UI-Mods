# Active Stats

Mirrors the active modifiers from the native `hudActivePlayerStats` panel beside
the crosshair. The October 2026 layout separates the weapon, spirit and vitality
columns under `StatList`; weapon power and spirit power belong to `HudStatBlock`.
The script resolves the native stats panel and reads only these branches. The
overlay belongs to HudCore, matching the working SecondEye placement.

Modifier values use the rendered native `statNumber` and optional `statPostfix`
labels. Weapon/spirit power use `statNumberDelta` only while `has_delta` is set;
stale deltas and empty values never paint. Buff/debuff classification uses the
native `isPositive`/`isNegative` classes rather than individual caster affiliation.
The core panel is identified by its class, not by an invented ID.
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
