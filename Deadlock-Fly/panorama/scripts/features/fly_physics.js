/**
 * @file fly_physics.js
 * @brief Kinematics, aerodynamics, and spatial navigation for Deadlock-Fly (ES6+).
 *
 * Simulates realistic Drosophila locomotion: alternating tripod crawling, intermittent
 * stops/re-orientations, aerodynamic lift, wing stroke steering torque, and flight saccades.
 * All motion is strictly forward-coupled along the heading vector (no backward flight),
 * and dynamically adapts to viewport bounds via actuallayoutwidth / actuallayoutheight.
 */

'use strict';

globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	class InsectPhysics {
		constructor() {
			this.saccadeTimer = 0.0;
			this.saccadeInterval = 0.4;
			this.crawlMoveTimer = 0.0;
			this.crawlIsMoving = true;
		}

		/**
		 * Dynamically resolves screen layout dimensions from Panorama HUD.
		 */
		getScreenDimensions() {
			if (typeof FLY_MOD.GetScreenDimensions === 'function') {
				return FLY_MOD.GetScreenDimensions();
			}
			return {
				w: FLY_MOD.State.screenWidth || 1920,
				h: FLY_MOD.State.screenHeight || 1080,
			};
		}

		/**
		 * Updates the physical position and orientation of the fly.
		 */
		update(dt) {
			this.applyEnvironmentalBiases(dt);
			this.applyEdgeSteering();

			const { currentBehavior: beh } = FLY_MOD.State;
			if (beh === 'panic' || beh === 'fly') {
				this.updateFlight(dt, beh === 'panic');
			} else if (beh === 'walk') {
				this.updateWalking(dt);
			} else {
				this.updateStationary(dt);
			}

			this.integrateHeading(dt);
			this.enforceScreenBounds();
		}

		/**
		 * Applies tactical avoidance (crosshair evasion during combat) and UI alignment.
		 */
		applyEnvironmentalBiases(dt) {
			const state = FLY_MOD.State;
			const { drives, gameState } = state;
			const dims = this.getScreenDimensions();
			const w = (Number.isFinite(dims.w) && dims.w >= 640) ? dims.w : 1920;
			const h = (Number.isFinite(dims.h) && dims.h >= 360) ? dims.h : 1080;
			const cx = w / 2;
			const cy = h / 2;

			// 1. Crosshair Avoidance during combat / high fear
			// Ensures the fly never obstructs aiming reticle when player is fighting
			if ((drives.fear > 0.4 || (gameState && gameState.inCombat)) && !(gameState && gameState.isDead)) {
				const distToCenter = Math.hypot(state.x - cx, state.y - cy);
				if (distToCenter < 140.0 && distToCenter > 2.0) {
					const angleAway = Math.atan2(state.y - cy, state.x - cx);
					state.targetAngle = angleAway;
				}
			}

			// 2. Scoreboard Row Crawling
			// When scoreboard is open, align walking along horizontal table rows
			if (gameState && gameState.scoreboardOpen && state.currentBehavior === 'walk') {
				if (Math.abs(Math.sin(state.targetAngle)) > 0.6) {
					state.targetAngle = (Math.cos(state.targetAngle) >= 0) ? 0.0 : Math.PI;
				}
			}
		}

		/**
		 * Smoothly steers the fly inward when nearing screen boundaries.
		 */
		applyEdgeSteering() {
			const state = FLY_MOD.State;
			const dims = this.getScreenDimensions();
			const w = (Number.isFinite(dims.w) && dims.w >= 640) ? dims.w : 1920;
			const h = (Number.isFinite(dims.h) && dims.h >= 360) ? dims.h : 1080;
			const margin = 180.0;
			const cx = w / 2;
			const cy = h / 2;

			// If nearing any screen edge, smoothly curve targetAngle toward screen center
			if (state.x < margin || state.x > w - margin || state.y < margin || state.y > h - margin) {
				const angleToCenter = Math.atan2(cy - state.y, cx - state.x);
				let diff = angleToCenter - state.targetAngle;
				while (diff > Math.PI) diff -= 2 * Math.PI;
				while (diff < -Math.PI) diff += 2 * Math.PI;
				state.targetAngle += diff * 0.2;
			}
		}

		/**
		 * Airborne aerodynamic flight dynamics.
		 * Thrust is strictly aligned forward with the insect heading vector.
		 */
		updateFlight(dt, isPanic) {
			const state = FLY_MOD.State;

			// 1. Lift / Altitude
			const targetZ = isPanic ? 0.85 : 0.65;
			state.z = (typeof state.z === 'number') ? state.z : 0.0;
			state.z += (targetZ - state.z) * 3.5 * dt;

			const baseSpeed = isPanic ? FLY_MOD.CONFIG.FLIGHT_SPEED_MAX : FLY_MOD.CONFIG.FLIGHT_SPEED_MIN;

			// Target orientation towards food or gentle natural wandering
			this.saccadeTimer += dt;
			if (this.saccadeTimer > this.saccadeInterval) {
				this.saccadeTimer = 0.0;
				this.saccadeInterval = 0.3 + Math.random() * 0.4;

				if (isPanic) {
					// Evasion saccade
					state.targetAngle += (Math.random() - 0.5) * Math.PI * 0.8;
				} else if (!state.foodTarget) {
					// Natural meandering flight
					state.targetAngle += (Math.random() - 0.5) * 0.9;
				}
			}

			// Continuous attractor steering toward food/corpse target
			if (state.foodTarget && !isPanic) {
				const dx = state.foodTarget.x - state.x;
				const dy = state.foodTarget.y - state.y;
				state.targetAngle = Math.atan2(dy, dx);
				const dist = Math.hypot(dx, dy);
				if (dist < 45.0) {
					state.z = Math.max(0.0, state.z - 5.0 * dt);
				}
			}

			// 3. Forward Airspeed & Thrust (positive scalar coupled directly to heading)
			const thrust = baseSpeed * (0.85 + 0.3 * Math.sin(Date.now() / 120));
			state.speed = (typeof state.speed === 'number') ? state.speed : 0.0;
			state.speed += (thrust - state.speed) * 5.0 * dt;
			if (state.speed < 0) state.speed = 0;

			state.vx = Math.cos(state.angle) * state.speed;
			state.vy = Math.sin(state.angle) * state.speed;

			state.x += state.vx * dt;
			state.y += state.vy * dt;

			state.wingBuzzPhase += dt * 65.0;
		}

		/**
		 * 2D Surface Crawling (Intermittent Locomotion).
		 */
		updateWalking(dt) {
			const state = FLY_MOD.State;
			const acc = FLY_MOD.Connectome.accumulators;

			state.z = Math.max(0.0, state.z - 5.0 * dt);

			this.crawlMoveTimer += dt;
			if (this.crawlIsMoving && this.crawlMoveTimer > 1.2) {
				this.crawlIsMoving = false;
				this.crawlMoveTimer = 0.0;
				state.targetAngle += (Math.random() - 0.5) * 0.8;
			} else if (!this.crawlIsMoving && this.crawlMoveTimer > 0.4) {
				this.crawlIsMoving = true;
				this.crawlMoveTimer = 0.0;
				state.targetAngle += (Math.random() - 0.5) * 0.6;
			}

			state.speed = (typeof state.speed === 'number') ? state.speed : 0.0;

			if (this.crawlIsMoving) {
				const crawlSpeed = FLY_MOD.CONFIG.CRAWL_SPEED;
				if (state.foodTarget) {
					const dx = state.foodTarget.x - state.x;
					const dy = state.foodTarget.y - state.y;
					state.targetAngle = Math.atan2(dy, dx);
				} else {
					const turnBias = (acc.walkLeft - acc.walkRight) * 1.5 * dt;
					state.targetAngle += turnBias;
				}

				state.speed += (crawlSpeed - state.speed) * 8.0 * dt;
				if (state.speed < 0) state.speed = 0;

				state.vx = Math.cos(state.angle) * state.speed;
				state.vy = Math.sin(state.angle) * state.speed;

				state.x += state.vx * dt;
				state.y += state.vy * dt;

				state.tripodPhase += dt * 14.0;
			} else {
				state.speed = Math.max(0.0, state.speed - state.speed * 8.0 * dt);
				state.vx = Math.cos(state.angle) * state.speed;
				state.vy = Math.sin(state.angle) * state.speed;
			}
		}

		/**
		 * Stationary behaviors (idle, grooming, feeding).
		 */
		updateStationary(dt) {
			const state = FLY_MOD.State;
			state.z = Math.max(0.0, state.z - 6.0 * dt);
			state.speed = Math.max(0.0, (state.speed || 0.0) - (state.speed || 0.0) * 10.0 * dt);
			state.vx = Math.cos(state.angle) * state.speed;
			state.vy = Math.sin(state.angle) * state.speed;

			if (state.currentBehavior === 'idle' && Math.random() < 0.04) {
				state.targetAngle += (Math.random() - 0.5) * 0.3;
			}
		}

		/**
		 * Wraps and interpolates heading smoothly toward targetAngle.
		 */
		integrateHeading(dt) {
			const state = FLY_MOD.State;
			if (!Number.isFinite(state.angle)) state.angle = 0.0;
			if (!Number.isFinite(state.targetAngle)) state.targetAngle = state.angle;

			let diff = state.targetAngle - state.angle;

			while (diff > Math.PI) diff -= 2 * Math.PI;
			while (diff < -Math.PI) diff += 2 * Math.PI;

			const turnRate = (state.currentBehavior === 'panic') ? 16.0 : 8.0;
			state.angle += diff * Math.min(1.0, turnRate * dt);

			while (state.angle > Math.PI) state.angle -= 2 * Math.PI;
			while (state.angle < -Math.PI) state.angle += 2 * Math.PI;
		}

		/**
		 * Keeps fly on-screen using dynamic layout bounds and inward deflection.
		 * Prevents clipping and guarantees forward-only motion (no backward flight).
		 */
		enforceScreenBounds() {
			const state = FLY_MOD.State;
			const dims = this.getScreenDimensions();
			const w = (Number.isFinite(dims.w) && dims.w >= 640) ? dims.w : 1920;
			const h = (Number.isFinite(dims.h) && dims.h >= 360) ? dims.h : 1080;
			const pad = 80.0;

			// NaN Self-healing: restore fly to screen center if corrupted
			if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
				state.x = w / 2;
				state.y = h / 2;
				state.vx = 0.0;
				state.vy = 0.0;
				state.speed = 0.0;
				state.angle = 0.0;
				state.targetAngle = 0.0;
			}
			if (!Number.isFinite(state.speed)) state.speed = 0.0;
			if (!Number.isFinite(state.z)) state.z = 0.0;

			let hit = false;
			if (state.x < pad) {
				state.x = pad;
				if (Math.cos(state.angle) < 0.2) {
					state.targetAngle = (Math.random() - 0.5) * (Math.PI * 0.4);
					state.angle = state.targetAngle;
					hit = true;
				}
			} else if (state.x > w - pad) {
				state.x = w - pad;
				if (Math.cos(state.angle) > -0.2) {
					state.targetAngle = Math.PI + (Math.random() - 0.5) * (Math.PI * 0.4);
					state.angle = state.targetAngle;
					hit = true;
				}
			}

			if (state.y < pad) {
				state.y = pad;
				if (Math.sin(state.angle) < 0.2) {
					state.targetAngle = (Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.4);
					state.angle = state.targetAngle;
					hit = true;
				}
			} else if (state.y > h - pad) {
				state.y = h - pad;
				if (Math.sin(state.angle) > -0.2) {
					state.targetAngle = (-Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.4);
					state.angle = state.targetAngle;
					hit = true;
				}
			}

			// Unconditional safety clamp
			state.x = Math.max(pad, Math.min(w - pad, state.x));
			state.y = Math.max(pad, Math.min(h - pad, state.y));

			if (hit) {
				state.speed = Math.max(0.0, state.speed * 0.5);
				state.vx = Math.cos(state.angle) * state.speed;
				state.vy = Math.sin(state.angle) * state.speed;
			}
		}
	}

	FLY_MOD.Physics = new InsectPhysics();
	FLY_MOD.Log('Kinematics physics subsystem initialized (ES6 class)');
})();
