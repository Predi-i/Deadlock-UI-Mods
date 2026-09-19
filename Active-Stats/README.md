# Active Stats

Mirrors real-time hero combat buffs and debuffs (Fire Rate, Slows, Resistances, Bullet/Spirit
Lifesteal, Spirit Power, Weapon Damage, Ability Range, etc.) from the bottom-left player stats
container directly into a tactical readout beside the crosshair.

## How it works

**Source panel detection** — Deadlock exposes no combat stat change event to the V8 Panorama context.
The mod hooks `citadel_hud_active_player_stats.xml` (the stock layout for `#hudPlayerStats`) and
polls the 15 mini-modifier containers (`bulletEvasionContainer`, `regenPerSecondContainer`,
`fireRateContainer`, etc.) for visibility and value mutations.

**Data extraction & consensus** — For each visible container:
1. **Value resolution**: Performs a bounded breadth-first search (`VALUE_BFS_LIMIT: 200`) skipping
   `#casterList` to extract the primary numeric modifier string while stripping formatting tags.
2. **Sign & consensus classification**:
   - First checks engine classes `.isNegative` / `.isPositive`.
   - Analyzes child nodes in `#casterList` for `.casterAndModifiers.enemy` vs `.friend` tags.
     Hostile debuffs (e.g., enemy slow or heal reduction) are strictly classified as debuffs.
   - Falls back to character-level arithmetic sign analysis (`+` vs `-` / `\u2212`).
3. **Normalization**: Prepends explicit `+` or `−` signs and formats labels.

**Overlay lifecycle & performance** —
- **Mount target**: Injected as `#ActiveStatsCrosshairOverlay` under `#gameplay_hud`, centered with
  a horizontal offset (+130px) beside the reticle.
- **Adaptive polling**: Runs at `POLL_RATE: 0.15s` (~6.6 Hz) when modifiers are present, and throttles
  to `IDLE_POLL_RATE: 0.25s` (4 Hz) when clear.
- **Zero-waste diffing**: State updates are guarded by string signature hashing (`_lastContentSig`,
  `_lastLayoutSig`). Identical ticks perform zero DOM mutations or CSS reflows. When all modifiers
  expire, the overlay collapses to `visibility: collapse` (0ms render overhead).
- **Event-driven scoreboard suppression**: Subscribes to `CitadelScoreboardToggle` to instantly
  collapse the crosshair overlay with 0ms latency when Tab is pressed, and restores it on close.
- **Single-instance protection**: Uses a generation token in `GameUI.CustomUIConfig()['ActiveStats']`
  to cleanly tear down older instances and cancel pending `$.Schedule` timers on HUD reload.

## Files

| File | Role |
| --- | --- |
| `panorama/layout/citadel_hud_active_player_stats.xml` | Stock layout with script & stylesheet includes. |
| `panorama/scripts/active_stats.js` | Modifier scanner, caster consensus parser, and overlay coordinator. |
| `panorama/styles/active_stats.css` | Tactical layout, buff/debuff color schemes, and typography. |

## Configuration

All tunables live in the `CONFIG` object at the top of `panorama/scripts/active_stats.js`:

```javascript
const CONFIG = {
    POLL_RATE: 0.15,       // Combat check frequency in seconds (~6.6Hz)
    IDLE_POLL_RATE: 0.25,  // Idle check frequency when no modifiers are active (4Hz)
    BASE_X: 130,           // Pixels to the right of crosshair
    BASE_Y: 0,             // Vertical pixel offset from screen center
    SCALE: 100,            // Scale percentage (50% to 200%)
    OPACITY: 1.0,          // Opacity (0.0 to 1.0)
    SHOW_BUFFS: true,      // Display positive buffs
    SHOW_DEBUFFS: true,    // Display negative debuffs
    DEBUG: false,          // Panorama console logging via $.Msg
};
```
