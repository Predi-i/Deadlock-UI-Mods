# Drosophila Biomechanics & Locomotion

`Deadlock-Fly` models the physical kinematics of an adult fruit fly (*Drosophila melanogaster*).

---

## 🪰 Locomotion Regimes

### 1. Hexapod Alternating Tripod Walking
When crawling on the monitor glass, the fly moves via the biological **alternating tripod gait**:
- **Tripod A**: Left Front ($L_1$), Right Middle ($R_2$), Left Hind ($L_3$)
- **Tripod B**: Right Front ($R_1$), Left Middle ($L_2$), Right Hind ($R_3$)

Tripod A swings forward while Tripod B supports the body, alternating at $\approx 14\text{ Hz}$.

#### Intermittent Locomotion
Real fruit flies do not walk continuously; they exhibit **intermittent search paths**:
- **Move phase**: Active walking for $0.5$ to $1.2$ seconds at $\approx 42\text{ px/s}$.
- **Stop phase**: Abrupt pause for $0.2$ to $0.4$ seconds to sample the environment and reorient the head before continuing.

---

## ✈️ Flight Aerodynamics

### 1. 3D Elevation & Perspective
- When airborne, altitude $z$ ascends smoothly from $0.0$ to $0.65$ (or $0.85$ in panic).
- In the Panorama DOM:
  - **Fly Size**: Scales from base scale ($0.48$) up to $\approx 0.78$ with altitude, creating visual depth of flying off the glass.
  - **Ground Shadow**: Drops lower and expands (`translate3d(0, 8-36px, 0)`), becoming softer and more translucent.

### 2. Wing Differential Steering Torque & Flight Duration
- Flight speeds range between calm cruising ($130\text{ px/s}$) and evasive panic ($220\text{ px/s}$).
- **Flight Duration Guard**: To prevent infinite flight loops, flights are capped at $2.2\text{ seconds}$ (`MAX_FLIGHT_DURATION`), smoothly lowering altitude $z \to 0$ and transitioning the fly back to ground states (`idle`, `walk`).

### 3. Forward-Only Velocity Coupling
In biological flight, wing aerodynamics generate positive forward thrust relative to the insect body axis. Unlike rigid bouncing particles in physics engines, the fly's velocity vector $\vec{v}$ is strictly coupled to its heading angle $\theta$:

$$\vec{v} = \begin{pmatrix} \cos\theta \\ \sin\theta \end{pmatrix} \cdot v, \quad v \ge 0$$

- Speed $v$ is non-negative at all times.
- Backward flight is physically prohibited: heading turns first during saccades and wall avoidance, eliminating backward sliding drift.

### 4. Flight Saccades
When frightened (`panic` state) or cruising, the fly executes rapid body turns termed **saccades**:
- High-rate turns completed in under $80\text{ ms}$.
- Sharp heading adjustments up to $90^\circ$ to evade incoming projectiles or the cursor.

---

## 🔲 Screen Boundaries & Dynamic Viewport Clamping

- Viewport dimensions are dynamically sampled from the root context panel (`$.GetContextPanel()`) and converted into virtual 1080p canvas coordinates ($1080 \times \frac{\text{width}}{\text{height}}$), eliminating High-DPI double scaling.
- **Soft Edge Steering**: As the insect nears screen margins ($\approx 180\text{ px}$ from boundaries), an inward steering bias smoothly curves the fly's heading toward the center of the screen.
- **Hard Edge Clamping**: If contacting the boundary padding limit ($80\text{ px}$), the coordinate is strictly clamped, speed is dampened, and heading is deflected inward.
- **Visual Heading Coupling**: The sprite's visual orientation is strictly bound to its physical heading via Source 2's native `preTransformRotate2d` property (`rotDeg = (angle + PI/2) * (180/PI)`), ensuring the fly always faces forward in its direction of movement.
- **NaN Self-Healing**: Non-finite coordinates or angles are instantly healed to screen center `(w/2, h/2)` with zero velocity, and render coordinates are double-clamped in virtual layout space.

---

## 🧼 Grooming & Feeding Kinematics

### 1. Grooming Behavior
When calm and resting, grooming motor circuits in the Subesophageal Zone (`SEZ_GROOM`) activate:
- **Head & Eye Cleaning**: The front legs ($L_1, R_1$) reach forward and brush across the compound eyes and antennae.
- **Wing Cleaning**: The hind legs ($L_3, R_3$) stroke backward across the dorsal surface of the wings to clean chitin debris.

### 2. Proboscis Feeding
When near food (e.g. an enemy kill or soul container):
- The head lowers slightly.
- The retractable proboscis extends downward against the screen glass.
- High-frequency subtle body pulsing animates fluid ingestion.
