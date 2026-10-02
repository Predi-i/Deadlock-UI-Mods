# Deadlock Telemetry & Sensory Hooks

`Deadlock-Fly` interfaces game events, engine unhandled events, and HUD telemetry directly into the biological *Drosophila melanogaster* connectome.

---

## 🎯 Complete Sensory Input Mapping

| Game Trigger | Detection Mechanism | Biological Sensor / Circuit | Neuromodulator / Action | Fly Behavioral Output |
| :--- | :--- | :--- | :--- | :--- |
| **Scoreboard Toggle** | `$.RegisterForUnhandledEvent('CitadelScoreboardToggle')` + `gScoreboardOpen` | `VIS_R1R6` + `VIS_LC4` + `CX_EB` | Shadow contrast shift | Sudden light drop; crawls horizontally along scoreboard stat columns. |
| **Shop Entry / Exit** | `CitadelOpenUpgradeShop` / `CitadelExitUpgradeShop` + `gShopOpen` | `SEZ_GROOM` + `DAN_PAM` | Restful shelter; fear $\to 0$ | Safe zone; perches on shop banner, grooming front legs & wings. |
| **Game Paused** | `$.RegisterForUnhandledEvent('CitadelPaused')` | `MECH_BRISTLE` + `SEZ_GROOM` | Motor freeze | Freezes motion, transitions to calm stationary grooming. |
| **Cursor Looming** | Rapid cursor approach ($> 250$ px/s, $< 160$ px) | `VIS_LC4` $\to$ `DN_GF` | Giant Fiber Spike | Instant mesothoracic leg extension (escape jump) & flight. |
| **Physical Touch** | Cursor distance $< 26$ px from fly center | `MECH_BRISTLE` (Mechanosensory) | Tactile reflex | Emergency startled takeoff. |
| **In-Combat / Damage** | `#InCombatAlert.Visible`, `#damageImpactInfo` cards (`.fadeIn && !.fadeOut`), `.InCombat` | `MECH_BRISTLE` + `DAN_PPL1` | Aversive dopamine ($+20$) | High tension, erratic zigzag flight away from screen center. |
| **Critical Health (<25% HP)** | `#LowHealthWarning.localPlayerLowHealth` & `#current_health` / `#max_health` | `DAN_PPL1` + `DN_GF` | Extreme threat arousal | Panic circling near bottom-left health bar; lowers escape threshold. |
| **Kill Secured** | `#damageImpactInfo` `.killed && !assist` (object flag `__flyKillFired`) + `EventFeed` | `GUS_GR` + `DAN_PAM` | Appetitive dopamine ($+38$) | Fear resets to 0; flies to target and extends proboscis (`feed`). |
| **Assist Secured** | `#damageImpactInfo` `.assist` (object flag `__flyAssistFired`) | `GUS_GR` + `DAN_PAM` | Moderate dopamine ($+20$) | Brief inquisitive approach towards action area. |
| **Killstreak Hype** | `#hype_container` (FirstBlood, Godlike, MegaKill) | `DAN_PAM` + `MN_WING_L/R` | Triumphant arousal ($+40$) | High-speed looping celebratory aerobatics across screen. |
| **Hero Fallen (Death)** | Ancestor of `#gameplay_hud_dead` has `.dead` or `#respawn_timer` active | `GUS_GR` + `SEZ_FEED` | Corpse feasting signal | Lands directly on dead hero screen, feasting until respawn. |
| **Hero Respawn** | Transition from `isDead` $\to$ alive (ancestor has `.alive`, respawn timer $= 0$) | `DN_GF` + `MECH_BRISTLE` | Explosive re-entry ($+35$) | Massive takeoff burst from corpse as combat restarts. |
| **Active Crosshair Aiming** | Distance to $(960, 540) < 170$ px in combat | Radial repulsion vector | Tactical avoidance | Veers away from crosshair to never obstruct the player's aim. |
| **Peace / Idle** | Absence of combat inputs | Endogenous pacemaker | `fatigue` / `curiosity` | Lands on screen glass, alternates walking and grooming. |

---

## 👁️ Visual Looming Formula

Fruit flies detect approaching predators via **optical looming** (the angular expansion rate of an approaching dark silhouette):

$$\theta(t) = 2 \arctan\left(\frac{r}{d(t)}\right), \quad \text{Looming Rate} = \frac{d\theta}{dt} = \frac{-2r \cdot v(t)}{d(t)^2 + r^2}$$

In `fly_sensors.js`:
- The distance $d$ from the fly to the cursor and the closing velocity $v = \frac{\Delta d}{\Delta t}$ are computed each frame.
- If $v > 250\text{ px/s}$ and $d < 160\text{ px}$, the looming threshold is exceeded.
- Electrical charge is dumped directly into the **Giant Fiber (`DN_GF`)** neuron, triggering the escape reflex.

---

## 🩸 Combat & Survival Circuits

### 1. Nociceptive Response (Damage)
When the local player takes damage in combat:
- `MECH_BRISTLE` receives $+18$ charge.
- `DAN_PPL1` receives $+20$ charge.
- The `fear` metabolic drive spikes to $1.0$.
- The fly abandons feeding or resting, immediately taking flight and executing evasive aerodynamic saccades.

### 2. Appetitive Response (Kills)
When the player eliminates an enemy hero:
- `#damageImpactInfo` recycled child cards are scanned for `.killed` without `.assist`.
- An object-level flag `panel.__flyKillFired` guarantees each kill fires exactly once per target instance, properly resetting when recycled by Source 2 C++.
- `DataFeed` (`EventFeed`) is monitored concurrently for confirmation of enemy hero deaths.
- `DAN_PAM` receives $+38$ charge.
- `GUS_GR` (taste) receives $+26$ charge.
- The fly's `fear` drops to $0.0$, and a virtual food coordinate is placed near the kill center.
- The fly flies to the location, lands on the glass, and extends its proboscis (`MN_PROBOSCIS`) for several seconds.

### 3. Corpse Feasting (Player Death)
When the local hero dies:
- Detected via `gameplay_hud_dead` ancestor traversal to the HUD state panel holding `.dead` or via `#respawn_timer` countdown text.
- The fly treats the fallen hero as an organic banquet:
  - `GUS_GR` receives $+32$ charge.
  - `DAN_PAM` receives $+28$ charge.
  - A food target is placed in the center of the death report.
  - The fly lands and performs the proboscis extension feeding cycle (`MN_PROBOSCIS`) throughout the respawn duration.
- When the player respawns (ancestor transitions to `.alive` and respawn timer hits 0), a sudden burst of $+35$ to `DN_GF` sends the fly rocketing into the air!

---

## 🎯 Crosshair Avoidance (Quality of Life)
To prevent the fly from obscuring the player's crosshair during intense firefights:
- When `drives.fear > 0.15` or `gameState.inCombat` or `gameState.lowHealth`:
- The kinematics engine calculates the distance to the screen center $(960, 540)$.
- If $d < 170\text{ px}$, a repulsive radial vector pushes `targetAngle` directly away from the center.
- The fly circles along the perimeter or lands on HUD bezels until combat calms down.
