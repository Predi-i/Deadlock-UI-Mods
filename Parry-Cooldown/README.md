# Parry Cooldown

Reads the native `ParryCooldownBorder.style.clip` radial sweep under
`gun_data/parry_unavailable`. Remaining seconds follow the native angle rather
than a timer started when the icon first becomes visible. The calculation is
`remaining sweep / 360 * cooldown duration`, with no wall-clock calibration or
division by small angle changes. Native `scripts/abilities.vdata` defines 4.5s
for `citadel_ability_melee_parry.AbilityCooldown`; Rebuttal subtracts 1.75s, giving
2.75s. Inventory is checked once per observed cooldown, including ring resets.
Invalid clips and urn carrying hide the label. Other future duration modifiers
require updating this mapping; this implementation does not infer their duration.

The label is a sibling of `parry_unavailable` under `gun_data`, outside the icon's
40px clipping bounds, wash-color and brightness animation. Its original color
is `#e75b5b`. The native icon is 40px high, centered vertically at y=55px, x=60%;
the 24px label uses the same x and width, with centered y=89px for a 2px gap below
the icon. Native icon dimensions are unchanged. `gun_data` is resolved
from this mod's own layout first. Missing
native panels and an unreadable active radial clip produce a diagnostic once per
failure state rather than silently hiding the timer.
Startup is deferred by one second, as in the original implementation, so the
included script does not exit while its layout is still being constructed. It
always logs `Loaded angle timer v5` when the include executes, then reports native
cooldown activation, zero sweep, urn suppression and runtime errors. An empty
clip getter falls back to the native inline style attribute. These diagnostics
require a compiled/repacked version of this source; offline tests cannot verify
the native getter or rendered position.
The existing 0.03s active and 0.1s inactive polling intervals are unchanged.
Native panel references are cached; active ticks read the ring and the scoped urn
modifier subtree, without searching the full HUD or repeatedly reading inventory.
Text and visibility are assigned only when their displayed values change.
Reload cancels the old scheduled tick and deletes its label. A deleted layout
stops scheduling. This is source-only until compiled/repacked by the maintainer.

```text
node tools/tests/runtime_regressions.cjs
```

In the client, check a normal cooldown, Rebuttal, observing a cooldown already in
progress, rapid resets, urn carrying and the timer's position at your resolution.
