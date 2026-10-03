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

Missing HUD/source panels, column owners and stat rows are retried no more often
than every 0.8 seconds, on the next active/idle tick. Existing values retain the
active/idle polling cadence above; a newly created conditional row may wait for
the discovery interval plus that tick. Cached references
also validate their direct owner, so live old generations moved away from the
current path do not mask replacements. Destruction/reparenting bypasses the
missing-result deadline. Returning from a suppressed HUD refreshes discovery.
The native source and overlay rebind together when HudCore changes, and cached
value/delta labels are rediscovered when their owner changes.

The readout also follows native gameplay HUD visibility: joining/leaving the
team, Escape/takeover screens, post-game state and the shop's gameplay-HUD gate.
The native `InHideout` area flag hides combat UI in the first hideout room; it
also hides Active Stats rows immediately in CSS and suspends reads in the idle
tick. `connectedToHideout` alone does not hide stats because it remains set in
the hideout's combat room too.
While hidden, the existing idle tick checks only cached HUD state; it skips
modifier lookups, value reads and row updates. Returning to the HUD refreshes the
values and restores visibility. A hidden startup does not create the overlay.
This reduces script work; it is not a measured FPS improvement.

Run the offline capture regression from the repository root:

```text
node tools/audit_hud_lookups.cjs <full-capture.json> [baseline-git-ref]
node --test Active-Stats/tests/active_stats.test.cjs
```

This counts JavaScript tree operations and checks modifier values, scoreboard
recovery and reload. It does not measure native performance or rendering. After
compiling/repacking, check buffs/debuffs, postfix units, death/respawn and scoreboard
transitions in the client, including core weapon/spirit modifiers.
The portable regressions exercise missing/late rows and source panels, live
owner replacement, label replacement, first-room suppression and reload. The
capture audit advances a virtual clock using actual scheduled delays; replacing
label children invalidates their old handles rather than leaving impossible
live references in the model. A capture where every supported row already
exists cannot demonstrate a reduction in missing-row discovery work.
