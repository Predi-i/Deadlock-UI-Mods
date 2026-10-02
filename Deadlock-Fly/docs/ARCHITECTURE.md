# Deadlock-Fly — System Architecture

`Deadlock-Fly` is an authentic in-game biological simulation of *Drosophila melanogaster* (the common fruit fly) running directly inside Valve's Deadlock HUD (Source 2 Panorama engine).

Unlike scripted UI animations that rely on randomized timers or hardcoded state machines, the fly's behavior is driven entirely by a **Leaky Integrate-and-Fire (LIF) Spiking Neural Network (SNN)** based on real connectome data from the **FlyWire Whole-Brain Connectome** (*Dorkenwald et al., Nature 2024*).

---

## 🏛️ High-Level Component Diagram

```
                 Deadlock Game Engine (Source 2 / Panorama)
                                     │
           ┌─────────────────────────┴────────────────────────┐
           ▼                                                  ▼
   [Mouse Cursor / Optic Flow]                       [HUD Combat Telemetry]
   (Looming, relative velocity)                      (Damage taken, kills, souls)
           │                                                  │
           └─────────────────────────┬────────────────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │      fly_sensors.js         │
                      │  (Electrochemical Injection)│
                      └──────────────┬──────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │     fly_connectome.js       │
                      │  (LIF Spiking Neural Net)   │
                      │   - Double-buffered V(t)    │
                      │   - Synaptic Propagation    │
                      │   - Leak, Spikes, Refractory│
                      └──────────────┬──────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │        fly_brain.js         │
                      │  (Homeostasis & Metabolism) │
                      │   - Hunger, Fear, Fatigue   │
                      │   - Behavior State Arbiter  │
                      └──────────────┬──────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │       fly_physics.js        │
                      │  (2D / 3D Insect Kinematics)│
                      │   - Forward-Coupled Thrust  │
                      │   - Inward Wall Deflection  │
                      │   - Dynamic Viewport Bounds │
                      └──────────────┬──────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │       fly_render.js         │
                      │  (Panorama DOM Scene Graph) │
                      │   - 3D CSS Transforms       │
                      │   - Subsystem Perf Probes   │
                      └──────────────┬──────────────┘
                                     ▼
                      [#DrosophilaOverlay on Screen]
                                     │
                                     ▼
                      ┌─────────────────────────────┐
                      │       fly_debug.js          │
                      │  (Neural Monitor & Bench)   │
                      │   - Auto 10s Benchmark @30s │
                      │   - Subsystem Time Analysis │
                      └─────────────────────────────┘
```

---

## 📁 Module Breakdown

| Module | Location | Responsibility |
| :--- | :--- | :--- |
| `fly_namespace.js` | `panorama/scripts/core/` | Global state, coordinate frames, configuration, generation token lifecycle management. |
| `fly_constants.js` | `panorama/scripts/core/` | Biological neuron groups and FlyWire synaptic weight matrix ($\sim 400$ connections). |
| `fly_connectome.js` | `panorama/scripts/core/` | Leaky Integrate-and-Fire propagation engine with double-buffered membrane potentials. |
| `fly_sensors.js` | `panorama/scripts/features/` | Ingestion of Deadlock gameplay telemetry (optic flow, combat damage, enemy kills). |
| `fly_brain.js` | `panorama/scripts/features/` | Metabolic drive simulation (hunger, fatigue, fear) and macroscopic behavior arbitration. |
| `fly_physics.js` | `panorama/scripts/features/` | Flight aerodynamics, lift, forward-only kinematics, inward wall deflection, and dynamic viewport bounds. |
| `fly_render.js` | `panorama/scripts/features/` | 30 Hz master loop, Panorama panel resolution, subsystem perf probes, and hardware-accelerated CSS transforms. |
| `fly_debug.js` | `panorama/scripts/features/` | Live neural activity monitor badge and 10-second automated in-game performance benchmark. |
| `fly.css` | `panorama/styles/` | Unified GameTracking-compliant HUD stylesheet (keyframes, transitions, layout). |

---

## ⏱️ Execution & Performance Benchmark

- **Main Thread Budget**: Panorama JS executes on the main UI thread. A full connectome tick plus sensor ingestion and kinematics executes in **$\approx 0.15$ ms** per tick.
- **Tick Rate**: Tuned to 30 Hz (`TICK_RATE = 0.033s`). The simulation loop runs with native Source 2 Panorama layout properties (`panel.style.x`, `panel.style.y`, `panel.style.preTransformRotate2d`, `panel.style.preTransformScale2d`), completely eliminating multi-transform CSS string parser issues and frame interpolation drifts.
- **In-Game 10s Benchmark**: Modeled on QOLLOCK's performance profiler:
  - Automatically triggers 30 seconds after game startup.
  - Profiles 10 seconds of gameplay (~300 ticks).
  - Measures total ticks, total JS time, average JS per tick, maximum single-tick spike, and per-subsystem breakdowns (`Connectome`, `Render`, `Sensors`, `Physics`, `Brain`, `DebugUI`).
  - Formats and prints a structured diagnostic table directly to console (`~`) via `$.Msg`.
  - Can be manually executed at any time in console: `FLY_MOD.Debug.startBenchmark(10)`.
- **Dynamic Viewport Bounds & Virtual 1080p Coordinate Space**:
  - Viewport queried directly from root context panel `$.GetContextPanel()`.
  - In Source 2 Panorama, CSS inline styles (`style.x`, `style.y`) strictly evaluate in virtual design canvas units where height is fixed at $1080$ and width scales with aspect ratio ($1080 \times \frac{\text{width}}{\text{height}}$).
  - Physical DPI double-scaling on 1440p and 4K displays is eliminated by normalizing canvas dimensions to virtual coordinates.
  - `enforceScreenBounds()` implements NaN self-healing: if any coordinate or heading ever becomes non-finite, the fly safely resets to viewport center `(w/2, h/2)` with zero velocity.
  - `updateScene()` double-clamps coordinates directly within `[0, w - 128]` and `[0, 1080 - 128]`, and rotates the sprite around its center via native `preTransformRotate2d`.
- **Zero Click Interception (Full Hittest Transparency)**: `#DrosophilaOverlay`, `.FlyRoot`, and all vector child panels strictly enforce `hittest: false;` and `hittestchildren: false;` in both CSS and JavaScript DOM instantiation. This guarantees that full-screen overlays at `z-index: 9999` never block gameplay clicks, crosshairs, or UI controls.
- **Forward-Only Kinematics**: Forward velocity is strictly coupled to the insect's heading angle ($\vec{v} = (\cos\theta, \sin\theta) \cdot v$, $v \ge 0$). Calibrated to authentic biological speeds (`CRAWL_SPEED = 42 px/s`, `FLIGHT_SPEED = 130-220 px/s`) with a `MAX_FLIGHT_DURATION` of 2.2s forcing natural ground landings. Inward wall deflection prevents backward drift.

---

## 🎨 Visual Styles & Animation Roadmap

### 1. Transparent WebM Animation Support
Deadlock's Source 2 Panorama engine natively supports transparent video panels:
```xml
<MoviePanel src="file://{resources}/videos/fly/fly_walk.webm" repeat="true" autoplay="onload" />
```
- **Codec**: VP9 / VP8 with alpha channel.
- **Compilation**: Unlike images (`.png`/`.svg`), `.webm` files do **not** require compilation through `resourcecompiler.exe` and can be bundled directly into the VPK.
- **Animation States**: Smooth looping transparent animations for idle (twitching antennae/proboscis), walking (tripod gait), flying (high-speed wing blur), and grooming.

### 2. Proposed Fly Visual Designs (Options for Maintainer Selection)
- **Option A — Realistic Drosophila (Current/Enhanced)**: Anatomically authentic fruit fly with translucent venated wings, segmented thorax, and deep red ommatidia compound eyes.
- **Option B — Stylized Arcade / Cartoon Fly**: Exaggerated eyes and expressive reactions (dizzy eyes on player death, wide eyes during panic/damage, greedy mouth when eating enemy souls).
- **Option C — Deadlock Steampunk Homunculus**: Mechanical brass/copper automaton fitting Deadlock's 1930s-1940s occult dieselpunk aesthetic, complete with glowing amber vacuum tube abdomen and clockwork gear-driven wings.
- **Option D — Minimalist HUD Wireframe**: Holographic neon/monochrome reticle fly projecting a subtle tactical cyber-bug on screen.
