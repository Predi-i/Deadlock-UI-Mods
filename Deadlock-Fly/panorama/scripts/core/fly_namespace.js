/**
 * @file fly_namespace.js
 * @brief Global namespace, configuration, and shared state for Deadlock-Fly (ES6+).
 *
 * Implements generation token guards against Panorama HUD reloads and establishes
 * the coordinate frame, physical state, and biological parameters of the simulated
 * Drosophila melanogaster.
 */

'use strict';

// Ensure single global instance
globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	// =========================================================================
	// CONFIGURATION (ES6 Frozen Object)
	// =========================================================================
	FLY_MOD.CONFIG = Object.freeze({
		// Simulation tick rate (seconds). 0.033s = ~30 Hz.
		TICK_RATE: 0.033,

		// Base scale for the fly sprite (approx. 52-64px on 1080p)
		BASE_SCALE: 0.48,

		// 3D perspective altitude expansion in flight
		ALTITUDE_SCALE_MAX: 0.35,

		// Crawling speed (pixels per second) - natural gentle crawl
		CRAWL_SPEED: 42.0,

		// Flight speed range (pixels per second) - calm realistic buzzing, not hypersonic
		FLIGHT_SPEED_MIN: 130.0,
		FLIGHT_SPEED_MAX: 220.0,

		// Maximum flight burst duration before forced landing (seconds)
		MAX_FLIGHT_DURATION: 2.2,

		// Optical flow looming sensitivity radius (pixels from fly to cursor)
		LOOMING_RADIUS: 220.0,

		// Enable Hebbian synaptic plasticity (learning over time)
		ENABLE_PLASTICITY: true,
		PLASTICITY_LEARNING_RATE: 0.008,
		PLASTICITY_DECAY: 0.0005,

		// Show/hide neural activity monitor badge
		SHOW_DEBUG_MONITOR: false,

		// Debug logging to console (visible in game console ~)
		DEBUG_LOG: true,
	});

	// =========================================================================
	// RUNTIME STATE
	// =========================================================================
	FLY_MOD.State = {
		// Screen coordinates (top-left origin, pixels)
		x: 960.0,
		y: 540.0,
		z: 0.0,              // Altitude above screen glass (0 = crawling, 1 = max flight)

		// Heading angle in radians (0 = pointing right, PI/2 = down, -PI/2 = up)
		angle: -Math.PI / 2, // Default facing up
		targetAngle: -Math.PI / 2,
		angularVelocity: 0.0,

		// Forward speed (pixels/sec, always >= 0) and velocity vector
		speed: 0.0,
		vx: 0.0,
		vy: 0.0,

		// Current biological behavior state
		// 'idle' | 'walk' | 'fly' | 'groom' | 'feed' | 'panic'
		currentBehavior: 'idle',
		previousBehavior: 'idle',
		behaviorTimer: 0.0,

		// Grooming subtype: 'head' | 'wings'
		groomTarget: 'head',

		// Food / Feeding target on screen (e.g. kill location or soul counter)
		foodTarget: null, // { x, y, expires }

		// Tripod gait phase for walking animation (0..2*PI)
		tripodPhase: 0.0,

		// Wing buzz phase for flight animation
		wingBuzzPhase: 0.0,

		// Biological drives (metabolic state)
		drives: {
			hunger: 0.25,     // 0 = sated, 1 = starving (seeks kills/souls)
			fear: 0.0,        // 0 = calm, 1 = terror (triggers Giant Fiber)
			fatigue: 0.1,     // 0 = fresh, 1 = exhausted (forces landing)
			curiosity: 0.6,   // 0 = indifferent, 1 = wanders / investigates cursor
		},

		// Cached UI Panels
		panels: {
			overlay: null,
			flyRoot: null,
			flySprite: null,
			flyShadow: null,
			wingL: null,
			wingR: null,
			monitor: null,
			stateLabel: null,
			bars: {},
		},

		// Screen dimensions
		screenWidth: 1920,
		screenHeight: 1080,

		// Active generation token
		generation: 0,

		// Deadlock In-Game Telemetry & HUD State
		gameState: {
			scoreboardOpen: false,
			shopOpen: false,
			isDead: false,
			lowHealth: false,
			currentHp: 100,
			maxHp: 100,
			inCombat: false,
			combatCooldown: 0.0,
		},
	};

	// =========================================================================
	// LOGGING & UTILS
	// =========================================================================
	FLY_MOD.Log = (msg) => {
		if (FLY_MOD.CONFIG.DEBUG_LOG) {
			$.Msg(`[Deadlock-Fly] ${msg}`);
		}
	};

	FLY_MOD.Warn = (msg) => {
		$.Msg(`[Deadlock-Fly WARN] ${msg}`);
	};

	// =========================================================================
	// VIEWPORT & SCREEN RESOLUTION COUPLING
	// =========================================================================
	FLY_MOD.GetScreenDimensions = () => {
		const state = FLY_MOD.State;
		const p = (typeof $ !== 'undefined' && typeof $.GetContextPanel === 'function')
			? $.GetContextPanel()
			: null;

		let cssW = 1920;
		let cssH = 1080;

		if (p) {
			const actW = Number(p.actuallayoutwidth);
			const actH = Number(p.actuallayoutheight);

			// In Source 2 Panorama, the virtual design canvas height is ALWAYS 1080.
			// Virtual design coordinates for inline styles (style.x, style.y) must use
			// virtual dimensions: width = 1080 * (actuallayoutwidth / actuallayoutheight), height = 1080.
			if (Number.isFinite(actW) && actW > 100 && Number.isFinite(actH) && actH > 100) {
				const aspectRatio = actW / actH;
				cssW = Math.round(1080.0 * aspectRatio);
				cssH = 1080;
			}
		}

		if (Number.isFinite(cssW) && cssW >= 640 && Number.isFinite(cssH) && cssH >= 360) {
			state.screenWidth = cssW;
			state.screenHeight = cssH;
		}

		return {
			w: state.screenWidth || 1920,
			h: state.screenHeight || 1080,
		};
	};

	// =========================================================================
	// GENERATION TOKEN GUARD (Prevents duplicate loops on HUD reloads)
	// =========================================================================
	const getStore = () => {
		try {
			if (typeof GameUI !== 'undefined' && GameUI && typeof GameUI.CustomUIConfig === 'function') {
				const cfg = GameUI.CustomUIConfig();
				if (cfg) return cfg;
			}
		} catch (_) {}

		try {
			let cursor = (typeof $ !== 'undefined' && typeof $.GetContextPanel === 'function') ? $.GetContextPanel() : null;
			let guard = 0;
			while (cursor && cursor.GetParent && cursor.GetParent() && guard < 50) {
				cursor = cursor.GetParent();
				guard++;
			}
			if (cursor) {
				cursor.__FlyStore = cursor.__FlyStore || {};
				return cursor.__FlyStore;
			}
		} catch (_) {}

		globalThis.__FlyStore = globalThis.__FlyStore || {};
		return globalThis.__FlyStore;
	};

	const store = getStore();
	store.generation = (store.generation || 0) + 1;
	const currentGen = store.generation;
	FLY_MOD.State.generation = currentGen;

	FLY_MOD.IsCurrentGeneration = () => {
		try {
			return getStore().generation === currentGen;
		} catch (_) {
			return true;
		}
	};

	FLY_MOD.Log(`Initialized ES6 namespace (Generation ${FLY_MOD.State.generation})`);
})();

