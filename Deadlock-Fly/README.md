# Deadlock-Fly 🪰

An authentic, living digital fruit fly (*Drosophila melanogaster*) inhabiting your screen in Valve's **Deadlock** (Source 2).

The fly is **not scripted**. It contains no fake `if/else` behavior trees or arbitrary random timers. Its actions, instincts, and reflexes emerge entirely from a **Leaky Integrate-and-Fire (LIF) Spiking Neural Network (SNN)** based on real connectomics data from the **FlyWire Whole-Brain Connectome** (*Dorkenwald et al., Nature 2024*).

---

## 🔬 How It Works

### 1. The Fly's Digital Brain
* **LIF Neural Architecture**: 27 identified functional Drosophila neuron groups with double-buffered membrane potentials, exponential voltage leak ($\lambda = 0.94$), and synaptic propagation across $\sim 400$ biological connections.
* **Emergency Escape Circuit (Giant Fiber `DN_GF`)**: When a threat rapidly looms toward the fly, the Giant Fiber fires a massive spike packet, executing an explosive emergency jump and high-frequency evasive flight.
* **Central Complex Compass (`CX_EB`, `CX_PB`)**: A ring attractor circuit maintaining spatial heading and navigational steering.
* **Dopaminergic Plasticity**:
  * `DAN_PAM` (Appetitive Dopamine): Surges on enemy kills and soul collection, triggering feasting.
  * `DAN_PPL1` (Aversive Dopamine): Surges when you take damage, triggering terror and erratic zigzag evasions.
* **Homeostatic Drives**: Hunger, fatigue, fear, and curiosity constantly regulate the fly's metabolic state.

### 2. Living on Your Screen
* **Crawling**: Realistic alternating tripod gait ($L_1, R_2, L_3$ vs $R_1, L_2, R_3$) with natural intermittent search stops.
* **Flight**: True 3D elevation scaling, dynamic ground shadow, wing differential steering torque, and high-frequency wing buzz.
* **Grooming**: Front legs cleaning compound eyes; hind legs cleaning wings and abdomen.
* **Feeding**: Extends its retractable proboscis onto the monitor glass when near fresh enemy kills.

---

## 🎮 Game Interactions

| Action in Deadlock | Neural Pathway | Fly Reaction |
| :--- | :--- | :--- |
| **Cursor approaching gently** | `VIS_R1R6` photoreceptors | Curiosity drive rises; tracks or wanders toward cursor |
| **Swatting cursor at fly** | Optic flow looming -> `DN_GF` (Giant Fiber) | Instant emergency jump and evasive flight |
| **Taking enemy damage** | `MECH_BRISTLE` + `DAN_PPL1` (Fear) | Panic. Flight motor neurons fire on max, erratic saccades |
| **Securing an enemy kill** | `GUS_GR` (Taste) + `DAN_PAM` (Reward) | Flies to the kill location, lands, and feasts with proboscis |
| **Lull in combat / Quiet** | Metabolic `DRIVE_FATIGUE` accumulation | Lands on screen edge or health bar, grooms eyes and wings |

---

## 📂 Repository Structure

Structured cleanly according to the `peer` modular standard:

```
Deadlock-Fly/
├── README.md
├── docs/
│   ├── ARCHITECTURE.md          # System architecture & Panorama dataflow
│   ├── CONNECTOME.md            # LIF mathematical model & FlyWire neuron groups
│   ├── SENSORS.md               # Telemetry hooks (damage, kills, cursor looming)
│   └── BIOMECHANICS.md          # Tripod gait, flight aerodynamics & kinematics
└── panorama/
    ├── images/
    │   └── fly/                 # SVGs and PNG sprites (idle, walk, fly, groom, feed)
    ├── layout/
    │   └── base_hud.xml         # Panorama base_hud injection with scripts & styles
    ├── scripts/
    │   ├── core/
    │   │   ├── fly_namespace.js # Global state, coordinates, generation token guard
    │   │   ├── fly_constants.js # Biological neuron groups & synaptic weight matrix
    │   │   └── fly_connectome.js# Leaky Integrate-and-Fire spiking neural engine
    │   └── features/
    │       ├── fly_sensors.js   # Telemetry hooks (mouse looming, damage, kills)
    │       ├── fly_brain.js     # Homeostasis (hunger, fatigue, fear, curiosity)
    │       ├── fly_physics.js   # 2D/3D insect aerodynamics & tripod locomotion
    │       ├── fly_render.js    # 30 Hz master loop & hardware CSS transforms
    │       └── fly_debug.js     # Live neural telemetry monitor badge
    └── styles/
        └── fly.css              # Unified GameTracking-compliant HUD stylesheet
```

---

## ⚙️ Building the Mod

Built using the repository's standard compile pipeline:

1. Run `tools\build_mod.bat`.
2. Select **Deadlock-Fly** from the menu.
3. The compiled VPK (`pak*_dir.vpk`) will be placed into `tools\builds`.
4. Install via Deadlock Mod Manager or Grimoire.

---

## Credits

Neural connectome based on the [FlyWire](https://flywire.ai) *Drosophila* dataset ([Nature 2024](https://doi.org/10.1038/s41586-024-07558-9), CC BY-NC 4.0) and [desktop-fly](https://github.com/DenisSergeevitch/desktop-fly).

