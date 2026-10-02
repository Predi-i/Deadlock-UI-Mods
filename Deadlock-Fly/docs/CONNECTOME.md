# Drosophila Connectome — Spiking Neural Model

## 🔬 Scientific Foundations

The neural circuit in `Deadlock-Fly` is an implementation of a **Leaky Integrate-and-Fire (LIF)** spiking neural network modeling the functional circuits of *Drosophila melanogaster*.

Synaptic topology and weights are mapped from published connectomics data:
1. **FlyWire Consortium**: *Dorkenwald et al., "Neuronal wiring diagram of an adult brain", Nature 634, 124–138 (2024)*.
2. **Central Complex Navigation**: *Hulse et al., "A connectome of the Drosophila central complex extends knowledge of the function of an insect brain", eLife 10:e66039 (2021)*.
3. **Mushroom Body & Dopaminergic Plasticity**: *Aso et al., "The neuronal architecture of the mushroom body provides a logic for associative learning", eLife 3:e04577 (2014)*.

---

## ⚡ Mathematical Model (LIF Dynamics)

Each biological neuron $i$ maintains a membrane potential $V_i(t)$.

### 1. Synaptic Accumulation & Dendritic Integration
When a presynaptic neuron $j$ fires an action potential, it transmits charge to postsynaptic target $i$ proportional to synaptic weight $w_{ji}$:

$$V_i(t + \Delta t) = V_i(t) \cdot \lambda + \sum_{j \in \text{spiking}} w_{ji}$$

Where:
- $\lambda = 0.94$ is the exponential membrane potential leak decay factor.
- $w_{ji} > 0$ represents excitatory cholinergic or glutamatergic transmission.
- $w_{ji} < 0$ represents inhibitory GABAergic transmission.

### 2. Threshold & Action Potential (Spike)
When the membrane potential exceeds the firing threshold $V_{\text{thresh}} = 20$:
1. An action potential spike is emitted to downstream neurons.
2. Downstream motor accumulators receive charge packets.
3. The membrane potential is reset to resting potential ($V = 0$).

---

## 🧠 Identified Neural Circuits

```
               [ VISUAL PATHWAY ]
   VIS_R1R6 (Motion) ──► VIS_ME (Medulla) ──► VIS_LO (Lobula) ──► CX_EB (Compass)
           │                     │                                      │
           ▼                     ▼                                      ▼
      VIS_LPTC (Optic Flow) ◄────┘                                 CX_PB (Bridge)
           │                                                            │
           └──────────────────────────┐                                 │
                                      ▼                                 ▼
                                 MN_WING_L / R                   MN_LEG_L1..3 / R1..3
                                  (Flight)                           (Walking)

               [ EMERGENCY ESCAPE (GIANT FIBER) ]
   MECH_BRISTLE (Touch) ──┐
                          ├─────► DN_GF (Giant Fiber) ──► Explosive Escape Jump!
   VIS_R1R6 (Looming)   ──┘            │
                                       ▼
                                 DAN_PPL1 (Aversive Dopamine / Terror)

               [ REWARD & FEASTING ]
   GUS_GR (Sugar / Blood) ─────► SEZ_FEED ──► MN_PROBOSCIS (Extend Feeding Tube)
                                       ▲
   DAN_PAM (Appetitive Dopamine) ──────┘
```

### 1. Optic Flow & Compound Eyes (`VIS_R1R6`, `VIS_LPTC`)
- Outer photoreceptors `VIS_R1R6` detect light intensity gradients and relative motion.
- `VIS_LPTC` (Lobula Plate Tangential Cells) computes the horizontal and vertical optical flow field, delivering asymmetric drive to `MN_WING_L` and `MN_WING_R` to induce optomotor steering.

### 2. Giant Fiber Escape Reflex (`DN_GF`)
- The Giant Fiber neuron is the fruit fly's primary emergency circuit. It triggers an escape sequence in under 4 milliseconds in nature.
- Stimulated by rapid visual expansion (looming threat) or tactile bristle deflection (`MECH_BRISTLE`).
- Fires simultaneously into the middle legs (mesothoracic jump) and flight motor neurons.

### 3. Central Complex Compass (`CX_EB`, `CX_PB`)
- The Ellipsoid Body (`CX_EB`) and Protocerebral Bridge (`CX_PB`) form a ring attractor circuit that maintains the fly's internal heading representation relative to visual landmarks on screen.

### 4. Neuromodulation & Plasticity
- **`DAN_PAM` (Appetitive Dopamine)**: Released upon securing kills or collecting souls. Stimulates feeding centers and reduces fear.
- **`DAN_PPL1` (Aversive Dopamine)**: Released when sustaining player damage. Induces rapid flight panic, heightens escape sensitivity, and suppresses feeding.
