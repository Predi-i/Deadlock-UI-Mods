/**
 * @file fly_constants.js
 * @brief Drosophila melanogaster biological connectome circuits and synaptic weights (ES6+).
 *
 * Derived from the FlyWire Whole-Brain Connectome (Dorkenwald et al., Nature 2024;
 * Rojas Aliaga, Zenodo 2026; Hulse et al., eLife 2021; Aso et al., eLife 2014).
 *
 * Circuit Organization:
 *   Visual:   VIS_R1R6 (photoreceptors) -> VIS_ME (medulla) -> VIS_LO (lobula) -> VIS_LC4 (looming detector)
 *   Optic:    VIS_LPTC (horizontal & vertical motion flow)
 *   Escape:   DN_GF (Giant Fiber) -> mesothoracic leg extensor & wing buzz
 *   Nav:      CX_EB (ellipsoid body ring attractor) -> CX_PB (steering commands)
 *   Plastic:  MB_KC (Kenyon cells) modulated by DAN_PAM (reward) & DAN_PPL1 (aversive)
 *   Motor:    MN_WING_L/R (flight), MN_LEG_L1..3/R1..3 (tripod walk), MN_PROBOSCIS (feed)
 */

'use strict';

globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	// =========================================================================
	// NEURON GROUPS & INITIAL SYNAPTIC WEIGHT MATRIX
	// =========================================================================
	const INITIAL_WEIGHTS = {
		// --- VISUAL PATHWAY (Compound Eye -> Optic Lobe) ---
		VIS_R1R6: {
			VIS_ME: 8,           // Primary projection to medulla
			VIS_LPTC: 5,         // Direct motion pathway
			VIS_LC4: 4,          // Looming detection pathway
		},
		VIS_R7R8: {
			VIS_ME: 6,           // Medulla contrast processing
			MB_KC: 4,            // Color association memory in Kenyon cells
		},
		VIS_ME: {
			VIS_LO: 7,           // Forward to lobula for pattern discrimination
			VIS_LPTC: 6,         // Optic flow computation
			VIS_LC4: 6,          // Looming feature extraction
		},
		VIS_LO: {
			CX_EB: 5,            // Visual landmark input to Central Complex compass
			VIS_LC4: 7,          // Rapid optical expansion
		},
		VIS_LC4: {
			DN_GF: 14,           // Direct high-potency trigger to Giant Fiber!
			VIS_LPTC: 4,         // Steering evasion bias
		},
		VIS_LPTC: {
			MN_WING_L: 7,        // Left wing steering control
			MN_WING_R: 7,        // Right wing steering control
			CX_PB: 4,            // Heading correction in protocerebral bridge
		},

		// --- EMERGENCY ESCAPE SYSTEM (Giant Fiber) ---
		DN_GF: {
			MN_WING_L: 16,       // Explosive wing buzz
			MN_WING_R: 16,
			MN_LEG_L2: 14,       // Mesothoracic leg extension (the escape jump!)
			MN_LEG_R2: 14,
			DAN_PPL1: 8,         // Fear arousal spike
		},

		// --- MECHANOSENSORY & TACTILE ---
		MECH_BRISTLE: {
			DN_GF: 12,           // Direct emergency escape on physical contact
			SEZ_GROOM: 7,        // Triggers grooming reflex if mild
			DAN_PPL1: 6,         // Stress / nociception
		},
		MECH_JO: {
			MN_ABDOMEN: 6,       // Flight stabilization / rudder trim
			MN_WING_L: 4,        // Wind compensation
			MN_WING_R: 4,
		},

		// --- GUSTATORY (Taste / Blood / Souls) ---
		GUS_GR: {
			SEZ_FEED: 14,        // Triggers proboscis extension
			DAN_PAM: 10,         // Potent dopamine reward signal
		},

		// --- CENTRAL COMPLEX (Ring Attractor Heading & Steering) ---
		CX_EB: {
			CX_PB: 8,            // Ellipsoid body to protocerebral bridge
		},
		CX_PB: {
			MN_LEG_L1: 4,        // Asymmetric steering walking
			MN_LEG_R1: 4,
			MN_WING_L: 5,        // Heading maintenance in flight
			MN_WING_R: 5,
		},

		// --- MUSHROOM BODY & DOPAMINERGIC NEUROMODULATORS ---
		DAN_PPL1: {
			// Aversive dopamine (damage / threat)
			DN_GF: 7,            // Primes escape reflex
			MN_WING_L: 8,        // Panic flight
			MN_WING_R: 8,
			SEZ_FEED: -8,        // Suppresses feeding
		},
		DAN_PAM: {
			// Appetitive dopamine (kills / rewards)
			SEZ_FEED: 9,         // Promotes feeding
			DN_GF: -4,           // Suppresses panic / calms fly
		},
		MB_KC: {
			DAN_PAM: 3,          // Reinforces positive associations
			CX_EB: 4,            // Navigational target bias
		},

		// --- MOTOR PATTERN GENERATORS ---
		SEZ_FEED: {
			MN_PROBOSCIS: 15,    // Extends feeding tube
		},
		SEZ_GROOM: {
			MN_LEG_L1: 8,        // Front leg eye cleaning
			MN_LEG_R1: 8,
			MN_ABDOMEN: 6,       // Hind leg wing cleaning
		},
	};

	// Deep clone for initial mutable runtime weights (allowing Hebbian plasticity)
	FLY_MOD.WEIGHTS = JSON.parse(JSON.stringify(INITIAL_WEIGHTS));

	// =========================================================================
	// MOTOR GROUP MAPPINGS
	// =========================================================================
	FLY_MOD.MOTOR_GROUPS = Object.freeze({
		flight: ['MN_WING_L', 'MN_WING_R'],
		walkLeft: ['MN_LEG_L1', 'MN_LEG_L2', 'MN_LEG_L3'],
		walkRight: ['MN_LEG_R1', 'MN_LEG_R2', 'MN_LEG_R3'],
		feed: ['MN_PROBOSCIS'],
		groom: ['MN_LEG_L1', 'MN_LEG_R1', 'MN_ABDOMEN'],
		escape: ['DN_GF', 'MN_WING_L', 'MN_WING_R'],
	});

	// All unique neuron identifiers in the functional connectome
	FLY_MOD.ALL_NEURONS = Object.freeze([
		'VIS_R1R6', 'VIS_R7R8', 'VIS_ME', 'VIS_LO', 'VIS_LC4', 'VIS_LPTC',
		'DN_GF', 'DN_P1',
		'MECH_BRISTLE', 'MECH_JO',
		'GUS_GR',
		'CX_EB', 'CX_PB',
		'MB_KC', 'DAN_PPL1', 'DAN_PAM',
		'SEZ_FEED', 'SEZ_GROOM',
		'MN_WING_L', 'MN_WING_R',
		'MN_LEG_L1', 'MN_LEG_R1',
		'MN_LEG_L2', 'MN_LEG_R2',
		'MN_LEG_L3', 'MN_LEG_R3',
		'MN_PROBOSCIS', 'MN_ABDOMEN', 'MN_HEAD'
	]);

	// Accumulator threshold levels for biological action triggering
	FLY_MOD.THRESHOLDS = Object.freeze({
		startle: 26,     // Giant fiber burst
		flight: 14,      // Takeoff into air
		feed: 10,        // Proboscis extension
		groom: 8,        // Grooming routine
		walk: 6,         // Surface locomotion
	});

	FLY_MOD.Log(`Loaded ES6 Drosophila connectome constants (${FLY_MOD.ALL_NEURONS.length} functional neuron groups)`);
})();
