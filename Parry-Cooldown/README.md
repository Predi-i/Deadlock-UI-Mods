# Parry Cooldown

Reads the native `ParryCooldownBorder.style.clip` radial sweep under
`gun_data/parry_unavailable`. Remaining seconds follow the native angle rather
than a timer started when the icon first becomes visible. The existing cooldown
values seed the first sample; subsequent decreasing samples calibrate duration
from native angular speed. Invalid clips and urn carrying hide the label.

The label is a child of `parry_unavailable`, centered below its native 40px icon,
so it inherits the icon position instead of guessing a percentage of `gun_data`.
The native icon container uses `overflow: noclip` so text below its 40px bounds
is not cut off. `gun_data` is resolved from this mod's own layout first. Missing
native panels and an unreadable active radial clip produce a diagnostic once per
failure state rather than silently hiding the timer.
Startup is deferred by one second, as in the original implementation, so the
included script does not exit while its layout is still being constructed. It
always logs `Loaded angle timer v3` when the include executes, then reports native
cooldown activation, zero sweep, urn suppression and runtime errors. An empty
clip getter falls back to the native inline style attribute. These diagnostics
require a compiled/repacked version of this source; offline tests cannot verify
the native getter or rendered position.
Reload cancels the old scheduled tick and deletes its label. A deleted layout
stops scheduling. This is source-only until compiled/repacked by the maintainer.

```text
node tools/tests/runtime_regressions.cjs
```

In the client, check a normal cooldown, Rebuttal, observing a cooldown already in
progress, rapid resets, urn carrying and the timer's position at your resolution.
