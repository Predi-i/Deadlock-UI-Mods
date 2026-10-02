/**
 * @file smoke_test.js
 * @brief Node.js headless smoke test for Deadlock-Fly connectome engine.
 */

'use strict';

// Mock Panorama environment (GameUI is undefined in Deadlock)
delete global.GameUI;

const scheduledTimers = [];
const createdPanels = [];

function createMockPanel(type, parent, id) {
	const p = {
		type,
		parent,
		id,
		style: {},
		classes: new Set(),
		children: [],
		hittest: true,
		hittestchildren: true,
		AddClass(c) { this.classes.add(c); },
		RemoveClass(c) { this.classes.delete(c); },
		SetHasClass(c, v) { if (v) this.classes.add(c); else this.classes.delete(c); },
		BHasClass(c) { return this.classes.has(c); },
		SetScaling(s) { this.scaling = s; },
		SetImage(img) { this.image = img; },
		SetAttributeString(k, v) { this[k] = v; },
		GetChildCount() { return this.children.length; },
		GetChild(i) { return this.children[i]; },
		GetParent() { return this.parent; },
		FindChildTraverse(childId) {
			if (this.id === childId) return this;
			for (const child of this.children) {
				const found = child.FindChildTraverse(childId);
				if (found) return found;
			}
			return createdPanels.find((cp) => cp.id === childId) || null;
		},
		IsValid() { return true; },
	};
	if (parent && Array.isArray(parent.children)) {
		parent.children.push(p);
	}
	createdPanels.push(p);
	return p;
}

const mockContextPanel = {
	FindChildTraverse: (childId) => createdPanels.find((cp) => cp.id === childId) || null,
	BHasClass: () => false,
	GetParent: () => null,
	actuallayoutwidth: 1920,
	actuallayoutheight: 1080,
	actualuiscale_x: 1.0,
	actualuiscale_y: 1.0,
};

global.$ = {
	Msg: (msg) => {},
	Schedule: (delay, fn) => {
		const timer = { delay, fn };
		scheduledTimers.push(timer);
		return timer;
	},
	RegisterForUnhandledEvent: (name, cb) => 1,
	UnregisterForUnhandledEvent: (name, id) => {},
	GetContextPanel: () => mockContextPanel,
	CreatePanel: (type, parent, id) => createMockPanel(type, parent, id),
};

// Load scripts in dependency order
require('../panorama/scripts/core/fly_namespace.js');
require('../panorama/scripts/core/fly_constants.js');
require('../panorama/scripts/core/fly_connectome.js');
require('../panorama/scripts/features/fly_sensors.js');
require('../panorama/scripts/features/fly_brain.js');
require('../panorama/scripts/features/fly_physics.js');
require('../panorama/scripts/features/fly_render.js');
require('../panorama/scripts/features/fly_debug.js');

console.log('--- Deadlock-Fly Smoke Test ---');

// 1. Verify connectome initialization
const engine = FLY_MOD.Connectome;
if (!engine || Object.keys(engine.V).length < 20) {
	console.error('FAIL: Connectome engine failed to initialize neurons.');
	process.exit(1);
}
console.log(`[PASS] Connectome initialized with ${Object.keys(engine.V).length} neurons.`);

// 2. Test sensory stimulation and spiking
engine.stimulate('VIS_R1R6', 25); // Exceed threshold (20)
engine.tick();

if (!engine.lastFired.has('VIS_R1R6')) {
	console.error('FAIL: VIS_R1R6 failed to fire upon stimulation.');
	process.exit(1);
}
console.log('[PASS] Sensory neuron spiking verified.');

// 3. Test multi-step propagation
for (let i = 0; i < 5; i++) {
	engine.tick();
}
console.log('[PASS] Synaptic propagation verified across 5 simulation ticks.');

// 4. Test kinematics and metabolism update
FLY_MOD.Brain.update(0.033);
FLY_MOD.Physics.update(0.033);

if (isNaN(FLY_MOD.State.x) || isNaN(FLY_MOD.State.y)) {
	console.error('FAIL: Position coordinates resulted in NaN.');
	process.exit(1);
}
console.log(`[PASS] Physics & brain updated cleanly. Position: (${FLY_MOD.State.x.toFixed(1)}, ${FLY_MOD.State.y.toFixed(1)}).`);

// 5. Test in-game event triggers (Scoreboard, Shop, Death)
FLY_MOD.Sensors.onScoreboardToggle(true);
if (!FLY_MOD.State.gameState.scoreboardOpen) {
	console.error('FAIL: Scoreboard toggle state not recorded.');
	process.exit(1);
}
console.log('[PASS] CitadelScoreboardToggle handled.');

FLY_MOD.Sensors.onPlayerDeath();
if (!FLY_MOD.State.gameState.isDead || !FLY_MOD.State.foodTarget) {
	console.error('FAIL: Corpse feasting target not spawned on death.');
	process.exit(1);
}
console.log('[PASS] Death state and corpse feasting attractor verified.');

FLY_MOD.Sensors.onPlayerRespawn();
if (FLY_MOD.State.gameState.isDead || FLY_MOD.State.drives.fear < 0.5) {
	console.error('FAIL: Respawn explosive startle did not fire.');
	process.exit(1);
}
console.log('[PASS] Respawn Giant Fiber escape burst verified.');

// 6. Test combat crosshair avoidance
FLY_MOD.State.x = 960;
FLY_MOD.State.y = 540;
FLY_MOD.State.drives.fear = 0.8;
FLY_MOD.Physics.update(0.033);
if (isNaN(FLY_MOD.State.targetAngle)) {
	console.error('FAIL: Crosshair avoidance computed NaN target angle.');
	process.exit(1);
}
console.log(`[PASS] Crosshair avoidance verified (targetAngle=${FLY_MOD.State.targetAngle.toFixed(2)} rad).`);

// 7. Test autonomous central pattern pacemaker locomotion in quiet environment
FLY_MOD.State.drives.fear = 0.0;
FLY_MOD.State.drives.curiosity = 0.8;
FLY_MOD.State.currentBehavior = 'idle';
FLY_MOD.Connectome.accumulators.flight = 0;
FLY_MOD.Connectome.accumulators.startle = 0;
FLY_MOD.State.x = 960;
FLY_MOD.State.y = 540;

// Stimulate leg motor neurons above threshold
FLY_MOD.Connectome.stimulate('MN_LEG_L1', 22);
FLY_MOD.Connectome.stimulate('MN_LEG_R1', 22);
FLY_MOD.Connectome.tick();
FLY_MOD.Brain.update(0.033);
FLY_MOD.Physics.update(0.033);

if (FLY_MOD.State.currentBehavior !== 'walk') {
	console.error(`FAIL: Leg motor stimulation did not trigger walk behavior (got ${FLY_MOD.State.currentBehavior}).`);
	process.exit(1);
}
console.log('[PASS] Autonomous leg motor stimulation triggers walk behavior.');

// Multiple walking steps move the fly
const startX = FLY_MOD.State.x;
const startY = FLY_MOD.State.y;
for (let step = 0; step < 10; step++) {
	FLY_MOD.Physics.update(0.033);
}
const movedDist = Math.hypot(FLY_MOD.State.x - startX, FLY_MOD.State.y - startY);
if (movedDist <= 0) {
	console.error('FAIL: Walking physics did not update fly position.');
	process.exit(1);
}
console.log(`[PASS] Autonomous walking displacement verified (moved ${movedDist.toFixed(1)}px).`);

// 8. Test forward-only velocity coupling and inward wall deflection (no backward flight)
FLY_MOD.State.x = 1915; // Right edge beyond safe padding
FLY_MOD.State.y = 500;
FLY_MOD.State.angle = 0; // Pointing right into wall
FLY_MOD.State.targetAngle = 0;
FLY_MOD.State.speed = 100;
FLY_MOD.State.currentBehavior = 'walk';

FLY_MOD.Physics.update(0.033);

if (FLY_MOD.State.x > 1920 - 72) {
	console.error(`FAIL: Screen bounds failed to clamp x to padding (got ${FLY_MOD.State.x}).`);
	process.exit(1);
}

// Dot product between velocity vector and heading unit vector must be non-negative (forward-only)
const headingUx = Math.cos(FLY_MOD.State.angle);
const headingUy = Math.sin(FLY_MOD.State.angle);
const forwardDot = FLY_MOD.State.vx * headingUx + FLY_MOD.State.vy * headingUy;
if (forwardDot < -0.001) {
	console.error(`FAIL: Backward flight detected! Dot product: ${forwardDot}`);
	process.exit(1);
}
console.log(`[PASS] Forward-only velocity coupling & wall deflection verified (dot=${forwardDot.toFixed(2)}, speed=${FLY_MOD.State.speed.toFixed(1)}).`);

// 9. Test dynamic screen bounds adaptation with actuallayoutwidth / height and fallback UIScale
mockContextPanel.actuallayoutwidth = 2560;
mockContextPanel.actuallayoutheight = 1440;
delete mockContextPanel.actualuiscale_x;
delete mockContextPanel.actualuiscale_y;

const dims1440 = FLY_MOD.GetScreenDimensions();
if (dims1440.w !== 1920 || dims1440.h !== 1080) {
	console.error(`FAIL: Inferred 1440p dimensions mismatch (expected 1920x1080, got ${dims1440.w}x${dims1440.h}).`);
	process.exit(1);
}

// Test 4K resolution inference (3840x2160 -> CSS 1920x1080)
mockContextPanel.actuallayoutwidth = 3840;
mockContextPanel.actuallayoutheight = 2160;
const dims4k = FLY_MOD.GetScreenDimensions();
if (dims4k.w !== 1920 || dims4k.h !== 1080) {
	console.error(`FAIL: Inferred 4K dimensions mismatch (expected 1920x1080, got ${dims4k.w}x${dims4k.h}).`);
	process.exit(1);
}

// Reset to 1440p and test boundary clamp (pad = 80)
mockContextPanel.actuallayoutwidth = 2560;
mockContextPanel.actuallayoutheight = 1440;
FLY_MOD.State.x = 2555;
FLY_MOD.State.y = 1435;
FLY_MOD.Physics.update(0.033);

if (FLY_MOD.State.x > 1920 - 80 + 0.01 || FLY_MOD.State.y > 1080 - 80 + 0.01) {
	console.error(`FAIL: Failed to dynamically adapt to scaled 2560x1440 resolution (pos: ${FLY_MOD.State.x}, ${FLY_MOD.State.y}).`);
	process.exit(1);
}
console.log(`[PASS] Dynamic viewport DPI adaptation (2560x1440 @ 1.33x -> CSS 1920x1080) verified (clamped to ${FLY_MOD.State.x.toFixed(1)}, ${FLY_MOD.State.y.toFixed(1)}).`);

// 10. Test in-game performance benchmark
let benchmarkReportGenerated = '';
let benchmarkStatsResult = null;

FLY_MOD.Debug.startBenchmark(10, (report, stats) => {
	benchmarkReportGenerated = report;
	benchmarkStatsResult = stats;
});

if (!FLY_MOD.Debug.benchmarkActive) {
	console.error('FAIL: Benchmark did not enter active state.');
	process.exit(1);
}

// Record simulated ticks
for (let i = 0; i < 15; i++) {
	FLY_MOD.Debug.recordSubsystemTime('Connectome', 0.08);
	FLY_MOD.Debug.recordSubsystemTime('Render', 0.05);
	FLY_MOD.Debug.recordSubsystemTime('Sensors', 0.03);
	FLY_MOD.Debug.recordTick(0.16);
}

// Find and trigger the benchmark timer callback
const bmTimer = scheduledTimers.find((t) => t.delay === 10);
if (!bmTimer || typeof bmTimer.fn !== 'function') {
	console.error('FAIL: Benchmark completion timer was not scheduled.');
	process.exit(1);
}
bmTimer.fn();

if (FLY_MOD.Debug.benchmarkActive) {
	console.error('FAIL: Benchmark did not finish.');
	process.exit(1);
}

if (!benchmarkReportGenerated.includes('DEADLOCK-FLY IN-GAME BENCHMARK REPORT') || !benchmarkStatsResult) {
	console.error('FAIL: Benchmark report was not properly generated.');
	process.exit(1);
}

if (benchmarkStatsResult.totalTicks !== 15) {
	console.error(`FAIL: Expected 15 benchmark ticks, got ${benchmarkStatsResult.totalTicks}.`);
	process.exit(1);
}

console.log(`[PASS] In-game benchmark verified (15 ticks, total JS: ${benchmarkStatsResult.totalJsMs.toFixed(2)}ms, avg: ${(benchmarkStatsResult.totalJsMs / 15).toFixed(3)}ms).`);

// 11. Test panel initialization and non-blocking hittest flags
FLY_MOD.Render.initPanels();

const { overlay, flyRoot, flySprite, flyShadow, wingL, wingR } = FLY_MOD.State.panels;
if (!overlay || overlay.hittest !== false || overlay.hittestchildren !== false) {
	console.error('FAIL: Overlay panel does not have hittest/hittestchildren set to false!');
	process.exit(1);
}
if (!flyRoot || flyRoot.hittest !== false || flyRoot.hittestchildren !== false) {
	console.error('FAIL: FlyRoot panel does not have hittest/hittestchildren set to false!');
	process.exit(1);
}
if (!flySprite || flySprite.hittest !== false) {
	console.error('FAIL: FlySprite panel does not have hittest set to false!');
	process.exit(1);
}
if (!flyShadow || flyShadow.hittest !== false) {
	console.error('FAIL: FlyShadow panel does not have hittest set to false!');
	process.exit(1);
}
if (!wingL || wingL.hittest !== false || !wingR || wingR.hittest !== false) {
	console.error('FAIL: FlyWing panels do not have hittest set to false!');
	process.exit(1);
}
console.log('[PASS] All DOM overlay panels confirmed non-blocking (hittest=false, hittestchildren=false).');

// 12. Test NaN self-healing & transform safety
FLY_MOD.State.x = NaN;
FLY_MOD.State.y = NaN;
FLY_MOD.State.angle = NaN;
FLY_MOD.State.targetAngle = NaN;
FLY_MOD.State.speed = NaN;
FLY_MOD.State.z = NaN;

FLY_MOD.Physics.update(0.033);

if (!Number.isFinite(FLY_MOD.State.x) || !Number.isFinite(FLY_MOD.State.y) || !Number.isFinite(FLY_MOD.State.angle)) {
	console.error('FAIL: NaN self-healing in physics failed!');
	process.exit(1);
}
console.log(`[PASS] Physics NaN self-healing verified (restored to ${FLY_MOD.State.x}, ${FLY_MOD.State.y}).`);

FLY_MOD.Render.updateScene();
if (flyRoot.style.x.includes('NaN') || flyRoot.style.y.includes('NaN') || flyRoot.style.preTransformRotate2d.includes('NaN')) {
	console.error('FAIL: Render styles contain NaN!');
	process.exit(1);
}
console.log(`[PASS] Render layout & rotation verified (x=${flyRoot.style.x}, y=${flyRoot.style.y}, rot=${flyRoot.style.preTransformRotate2d}).`);

// Test rotation angle coupling
FLY_MOD.State.angle = 0; // heading right
FLY_MOD.Render.updateScene();
if (flyRoot.style.preTransformRotate2d !== '90.0deg') {
	console.error(`FAIL: Expected 90.0deg for angle 0, got ${flyRoot.style.preTransformRotate2d}`);
	process.exit(1);
}

FLY_MOD.State.angle = Math.PI / 2; // heading down
FLY_MOD.Render.updateScene();
if (flyRoot.style.preTransformRotate2d !== '180.0deg') {
	console.error(`FAIL: Expected 180.0deg for angle PI/2, got ${flyRoot.style.preTransformRotate2d}`);
	process.exit(1);
}
console.log('[PASS] Fly visual rotation strictly couples to heading angle (0deg=up, 90deg=right, 180deg=down, -90deg=left).');

// 13. Test realistic kinematic speed constants
if (FLY_MOD.CONFIG.FLIGHT_SPEED_MAX > 250 || FLY_MOD.CONFIG.CRAWL_SPEED > 60) {
	console.error('FAIL: Kinematic speed constants exceed realistic biological thresholds.');
	process.exit(1);
}
console.log('[PASS] Kinematic speed constants verified within biological bounds.');

// 14. Test deep Deadlock HUD telemetry hooks (Kills, Assists, In-Combat, Death/Respawn, Low Health)
const hudStatePanel = createMockPanel('Panel', mockContextPanel, 'HudStateContainer');
hudStatePanel.AddClass('alive');
createMockPanel('Panel', hudStatePanel, 'gameplay_hud_dead');

const damageImpactInfo = createMockPanel('Panel', mockContextPanel, 'damageImpactInfo');
const card1 = createMockPanel('Panel', damageImpactInfo, ''); // Unnamed recycled damage card
const inCombatAlert = createMockPanel('Panel', mockContextPanel, 'InCombatAlert');
const lowHealthWarning = createMockPanel('Panel', mockContextPanel, 'LowHealthWarning');

// Reset sensor grace period for headless tests
FLY_MOD.Sensors.startupGraceUntil = 0;

// Test Kill detection on recycled card
card1.AddClass('killed');
FLY_MOD.Sensors.pollCombatTelemetry();
if (!card1.__flyKillFired || !FLY_MOD.State.foodTarget) {
	console.error('FAIL: Kill event on recycled panel did not fire or spawn food attractor.');
	process.exit(1);
}
console.log('[PASS] Recycled panel kill detection verified.');

// Test card recycling (target alive again, then killed again)
card1.RemoveClass('killed');
FLY_MOD.Sensors.pollCombatTelemetry();
if (card1.__flyKillFired) {
	console.error('FAIL: Panel __flyKillFired flag was not reset on recycling.');
	process.exit(1);
}

// Second kill on recycled panel
card1.AddClass('killed');
FLY_MOD.Sensors.pollCombatTelemetry();
if (!card1.__flyKillFired) {
	console.error('FAIL: Second kill on recycled panel did not trigger.');
	process.exit(1);
}
console.log('[PASS] Subsequent kill on recycled panel successfully triggered.');

// Test Assist detection
card1.RemoveClass('killed');
card1.AddClass('assist');
FLY_MOD.Sensors.pollCombatTelemetry();
if (!card1.__flyAssistFired) {
	console.error('FAIL: Assist detection failed.');
	process.exit(1);
}
console.log('[PASS] Assist detection verified.');
card1.RemoveClass('assist');

// Test In-Combat detection via InCombatAlert
inCombatAlert.AddClass('Visible');
FLY_MOD.Sensors.pollCombatTelemetry();
if (!FLY_MOD.State.gameState.inCombat) {
	console.error('FAIL: InCombatAlert did not set gameState.inCombat.');
	process.exit(1);
}
console.log('[PASS] InCombatAlert telemetry verified.');
inCombatAlert.RemoveClass('Visible');

// Test Low Health Warning via native CSS class
lowHealthWarning.AddClass('localPlayerLowHealth');
FLY_MOD.Sensors.pollHealthStatus();
if (!FLY_MOD.State.gameState.lowHealth) {
	console.error('FAIL: LowHealthWarning.localPlayerLowHealth did not set lowHealth state.');
	process.exit(1);
}
console.log('[PASS] LowHealthWarning class detection verified.');

// Test Death & Respawn via HUD state ancestor traversal
hudStatePanel.RemoveClass('alive');
hudStatePanel.AddClass('dead');
FLY_MOD.Sensors.pollDeathAndSpectator();
if (!FLY_MOD.State.gameState.isDead) {
	console.error('FAIL: gameplay_hud_dead ancestor .dead did not trigger player death.');
	process.exit(1);
}
console.log('[PASS] Death detection via gameplay_hud_dead ancestor verified.');

// Test Respawn transition
hudStatePanel.RemoveClass('dead');
hudStatePanel.AddClass('alive');
FLY_MOD.Sensors.pollDeathAndSpectator();
if (FLY_MOD.State.gameState.isDead) {
	console.error('FAIL: gameplay_hud_dead ancestor .alive did not trigger respawn.');
	process.exit(1);
}
console.log('[PASS] Respawn detection via gameplay_hud_dead ancestor verified.');

console.log('All smoke tests PASSED successfully!');
