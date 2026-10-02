/**
 * @file fly_brain.js
 * @brief Metabolic drive simulation and behavioral state arbitration (ES6+).
 *
 * Updates internal Drosophila homeostatic states (hunger, fear, fatigue, curiosity)
 * and maps biological motor accumulators from the connectome into macroscopic
 * organism behaviors (idle, walk, fly, groom, feed, panic).
 */

'use strict';

globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	class BrainHomeostasis {
		/**
		 * Updates biological drives and determines active behavior state.
		 */
		update(dt) {
			this.updateMetabolism(dt);
			this.evaluateBehavior(dt);
			this.injectSpontaneousDrives(dt);
		}

		/**
		 * Metabolic clock: adjusts homeostatic drives based on physical activity.
		 */
		updateMetabolism(dt) {
			const { drives, currentBehavior, gameState } = FLY_MOD.State;

			// Combat state cooldown decay
			if (gameState && gameState.combatCooldown > 0) {
				gameState.combatCooldown = Math.max(0.0, gameState.combatCooldown - dt);
				gameState.inCombat = (gameState.combatCooldown > 0);
			}

			// Fear decays exponentially
			drives.fear = Math.max(0.0, drives.fear - 0.25 * dt);

			if (currentBehavior === 'fly' || currentBehavior === 'panic') {
				// Flight burns high metabolic energy
				drives.fatigue = Math.min(1.0, drives.fatigue + 0.05 * dt);
				drives.hunger = Math.min(1.0, drives.hunger + 0.02 * dt);
			} else if (currentBehavior === 'walk') {
				drives.fatigue = Math.min(1.0, drives.fatigue + 0.015 * dt);
				drives.hunger = Math.min(1.0, drives.hunger + 0.01 * dt);
			} else if (currentBehavior === 'feed') {
				// Feeding satisfies hunger
				drives.hunger = Math.max(0.0, drives.hunger - 0.18 * dt);
				drives.fatigue = Math.max(0.0, drives.fatigue - 0.02 * dt);
			} else {
				// Resting recovers stamina
				drives.fatigue = Math.max(0.0, drives.fatigue - 0.07 * dt);
				drives.curiosity = Math.min(1.0, drives.curiosity + 0.03 * dt);
			}

			// Food target expiration
			if (FLY_MOD.State.foodTarget && Date.now() > FLY_MOD.State.foodTarget.expires) {
				FLY_MOD.State.foodTarget = null;
			}
		}

		/**
		 * Evaluates connectome motor accumulators and switches behavior state.
		 */
		evaluateBehavior(dt) {
			const state = FLY_MOD.State;
			const acc = FLY_MOD.Connectome.accumulators;
			const th = FLY_MOD.THRESHOLDS;
			let nextBehavior = state.currentBehavior;
			let reason = '';

			state.behaviorTimer += dt;

			// Flight max duration guard: fly lands naturally after short hop
			if ((state.currentBehavior === 'fly' || state.currentBehavior === 'panic') && state.behaviorTimer > (FLY_MOD.CONFIG.MAX_FLIGHT_DURATION || 2.2)) {
				state.z = Math.max(0.0, state.z - 3.5 * dt);
				if (state.z <= 0.05) {
					nextBehavior = 'idle';
					reason = `Flight duration expired (${state.behaviorTimer.toFixed(1)}s), landing`;
					acc.flight = 0;
					acc.startle = 0;
				}
			}
			// Priority 1: Emergency Escape / Panic
			else if (acc.startle >= th.startle || state.drives.fear > 0.85) {
				nextBehavior = 'panic';
				reason = `Emergency escape (startleAcc=${acc.startle}>=${th.startle}, fear=${state.drives.fear.toFixed(2)})`;
			}
			// Priority 2: Flight (unless exhausted)
			else if ((acc.flight >= th.flight || state.drives.fear > 0.45) && state.drives.fatigue < 0.9) {
				nextBehavior = 'fly';
				reason = `Flight (flightAcc=${acc.flight}>=${th.flight}, fear=${state.drives.fear.toFixed(2)})`;
			}
			// Priority 3: Feeding & Attractor seeking (kill / dead hero feast)
			else if (state.foodTarget && state.drives.hunger > 0.25) {
				const distToFood = Math.hypot(state.x - state.foodTarget.x, state.y - state.foodTarget.y);
				if (distToFood < 45.0) {
					nextBehavior = 'feed';
					state.z = 0.0;
					reason = `Arrived at food target (dist=${distToFood.toFixed(0)}px <= 45px)`;
				} else {
					nextBehavior = 'fly';
					reason = `Seeking food target (dist=${distToFood.toFixed(0)}px > 45px)`;
				}
			}
			// Priority 4: Grooming (when calm and resting)
			else if (acc.groom >= th.groom && state.z <= 0.05 && state.drives.fear < 0.1) {
				nextBehavior = 'groom';
				reason = `Grooming reflex (groomAcc=${acc.groom}>=${th.groom})`;
			}
			// Priority 5: Walking (leg motor neurons firing)
			else if ((acc.walkLeft + acc.walkRight) >= th.walk && state.z <= 0.05) {
				nextBehavior = 'walk';
				reason = `Locomotion (legsAcc=${acc.walkLeft + acc.walkRight}>=${th.walk})`;
			}
			// Priority 6: Idle / Rest
			else if (state.z <= 0.05 && state.behaviorTimer > 1.2) {
				nextBehavior = 'idle';
				reason = 'Resting / idle';
			}

			// Handle state transition
			if (nextBehavior !== state.currentBehavior) {
				state.previousBehavior = state.currentBehavior;
				state.currentBehavior = nextBehavior;
				state.behaviorTimer = 0.0;

				if (nextBehavior === 'groom') {
					state.groomTarget = Math.random() > 0.5 ? 'head' : 'wings';
				}

				FLY_MOD.Log(`[Brain] TRANSITION: ${state.previousBehavior.toUpperCase()} -> ${nextBehavior.toUpperCase()} (${reason})`);
			}
		}

		/**
		 * Generates spontaneous biological noise (endogenous dopamine / brain activity).
		 */
		injectSpontaneousDrives(dt) {
			const { drives, currentBehavior } = FLY_MOD.State;

			// 1. Spontaneous exploration / walking search on screen glass
			if (currentBehavior === 'idle' && drives.curiosity > 0.3 && drives.fear < 0.2) {
				// Autonomous central pattern pacemaker (~once every 2 - 3s)
				if (Math.random() < 0.05) {
					FLY_MOD.Connectome.stimulate('CX_EB', 22);
					FLY_MOD.Connectome.stimulate('MN_LEG_L1', 22);
					FLY_MOD.Connectome.stimulate('MN_LEG_R1', 22);
					FLY_MOD.Connectome.stimulate('MN_LEG_L2', 22);
					FLY_MOD.Connectome.stimulate('MN_LEG_R2', 22);
				}
			}

			// 2. Spontaneous grooming when resting
			if (currentBehavior === 'idle' && drives.fear < 0.1) {
				if (Math.random() < 0.04) {
					FLY_MOD.Connectome.stimulate('SEZ_GROOM', 22);
				}
			}

			// 3. Spontaneous flight hop (rare occasional relocation, ~once every 45-60s)
			if (currentBehavior === 'idle' && drives.fatigue < 0.35 && drives.fear < 0.2) {
				if (Math.random() < 0.001) {
					FLY_MOD.Connectome.stimulate('MN_WING_L', 16);
					FLY_MOD.Connectome.stimulate('MN_WING_R', 16);
				}
			}
		}
	}

	FLY_MOD.Brain = new BrainHomeostasis();
	FLY_MOD.Log('Brain arbitration subsystem initialized (ES6 class)');
})();
