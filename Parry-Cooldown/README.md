# Parry Cooldown

Reads the native `ParryCooldownBorder.style.clip` radial sweep under
`gun_data/parry_unavailable`. Remaining seconds follow the native angle rather
than a timer started when the icon first becomes visible. The existing cooldown
values seed the first sample; subsequent decreasing samples calibrate duration
from native angular speed. Invalid clips and urn carrying hide the label.

The label is a child of `parry_unavailable`, centered below its native 40px icon,
so it inherits the icon position instead of guessing a percentage of `gun_data`.
Reload cancels the old scheduled tick and deletes its label. A deleted layout
stops scheduling. This is source-only until compiled/repacked by the maintainer.

```text
node tools/tests/runtime_regressions.cjs
```

In the client, check a normal cooldown, Rebuttal, observing a cooldown already in
progress, rapid resets, urn carrying and the timer's position at your resolution.
