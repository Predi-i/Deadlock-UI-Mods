/**
 * @file fly_sensors.js
 * @brief Interfaces the fly's sensory neurons with Deadlock gameplay telemetry (ES6+).
 *
 * Captures both real-time Panorama engine events (CitadelScoreboardToggle, shop, pause)
 * and deep HUD telemetry (combat damage, kills, kill streaks, health ratio, death/respawn,
 * and mouse optic flow looming), injecting biologically calibrated electrochemical impulses
 * into the LIF Drosophila connectome.
 */

'use strict';

globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	const isAlive = (p) => {
		if (!p) return false;
		try {
			return typeof p.IsValid === 'function' ? p.IsValid() : true;
		} catch (_) {
			return false;
		}
	};

	class SensoryInterface {
		constructor() {
			this.lastMouseX = -1;
			this.lastMouseY = -1;
			this.lastDistToCursor = 9999;

			// Panel caches
			this.rootPanel = null;
			this.cachedDamageImpactInfo = null;
			this.cachedHudState = null;
			this.cachedRespawnTimer = null;
			this.cachedCurrentHealth = null;
			this.cachedMaxHealth = null;
			this.cachedLowHealthWarning = null;
			this.cachedLowHealthEffect = null;
			this.cachedInCombatAlert = null;
			this.cachedDataFeed = null;
			this.cachedEventFeed = null;
			this.cachedSpectateTarget = null;
			this.cachedHypeContainer = null;

			// Previous states for edge detection
			this.prevIsDead = false;
			this.prevLowHealth = false;
			this.prevInCombat = false;
			this.prevScoreboardOpen = false;
			this.prevShopOpen = false;
			this.startupGraceUntil = Date.now() + 3000;

			this.registerEngineEvents();
		}

		/**
		 * Registers direct Panorama unhandled events from Deadlock engine C++.
		 */
		registerEngineEvents() {
			if (typeof $.RegisterForUnhandledEvent !== 'function') return;

			// 1. Direct Scoreboard toggle event (as in Active-Stats)
			$.RegisterForUnhandledEvent('CitadelScoreboardToggle', (data) => {
				const isVisible = !!(data && data.visible);
				this.onScoreboardToggle(isVisible);
			});

			// 2. Direct Upgrade Shop events
			$.RegisterForUnhandledEvent('CitadelOpenUpgradeShop', () => {
				this.onShopStateChange(true);
			});
			$.RegisterForUnhandledEvent('CitadelExitUpgradeShop', () => {
				this.onShopStateChange(false);
			});
			$.RegisterForUnhandledEvent('CitadelToggleUpgradeShop', () => {
				this.onShopStateChange(!FLY_MOD.State.gameState.shopOpen);
			});

			// 3. Pause event
			$.RegisterForUnhandledEvent('CitadelPaused', () => {
				FLY_MOD.Log('CitadelPaused event received.');
				FLY_MOD.Connectome.stimulate('MECH_BRISTLE', 10);
				FLY_MOD.Connectome.stimulate('SEZ_GROOM', 12);
			});

			FLY_MOD.Log('Registered Panorama unhandled event listeners');
		}

		/**
		 * Resolves the top-level root HUD panel.
		 */
		getRoot() {
			if (isAlive(this.rootPanel)) return this.rootPanel;
			let cursor = $.GetContextPanel();
			let guard = 0;
			while (cursor && cursor.GetParent && cursor.GetParent() && guard < 50) {
				cursor = cursor.GetParent();
				guard++;
			}
			this.rootPanel = cursor || $.GetContextPanel();
			return this.rootPanel;
		}

		/**
		 * Safe FindChildTraverse helper.
		 */
		findChild(id) {
			const root = this.getRoot();
			if (!root || typeof root.FindChildTraverse !== 'function') return null;
			try {
				const found = root.FindChildTraverse(id);
				return isAlive(found) ? found : null;
			} catch (e) {
				return null;
			}
		}

		/**
		 * Safe BHasClass check.
		 */
		hasClass(panel, className) {
			if (!panel || typeof panel.BHasClass !== 'function') return false;
			try {
				return panel.BHasClass(className);
			} catch (e) {
				return false;
			}
		}

		/**
		 * Master sensory polling loop executed on each simulation tick.
		 */
		poll(dt) {
			try { this.pollOpticFlow(dt); } catch (e) { FLY_MOD.Warn(`pollOpticFlow error: ${e}`); }
			try { this.pollCombatTelemetry(); } catch (e) { FLY_MOD.Warn(`pollCombatTelemetry error: ${e}`); }
			try { this.pollHealthStatus(); } catch (e) { FLY_MOD.Warn(`pollHealthStatus error: ${e}`); }
			try { this.pollDeathAndSpectator(); } catch (e) { FLY_MOD.Warn(`pollDeathAndSpectator error: ${e}`); }
			try { this.pollGlobalHudClasses(); } catch (e) { FLY_MOD.Warn(`pollGlobalHudClasses error: ${e}`); }
			try { this.pollPhysicalContact(); } catch (e) { FLY_MOD.Warn(`pollPhysicalContact error: ${e}`); }

			// Periodic diagnostic heartbeat (every 10 seconds)
			this.heartbeatTimer = (this.heartbeatTimer || 0) + dt;
			if (this.heartbeatTimer > 10.0) {
				this.heartbeatTimer = 0.0;
				const gs = FLY_MOD.State.gameState;
				const dr = FLY_MOD.State.drives;
				FLY_MOD.Log(`[Sensors] Heartbeat | Behavior: ${FLY_MOD.State.currentBehavior.toUpperCase()} | HP: ${gs.currentHp}/${gs.maxHp} | Dead: ${gs.isDead} | InCombat: ${gs.inCombat} | Fear: ${dr.fear.toFixed(2)} | Hunger: ${dr.hunger.toFixed(2)} | FoodTarget: ${FLY_MOD.State.foodTarget ? 'Active' : 'None'}`);
			}
		}

		/**
		 * Handles direct Scoreboard toggle transitions.
		 */
		onScoreboardToggle(visible) {
			FLY_MOD.State.gameState.scoreboardOpen = visible;
			if (visible) {
				FLY_MOD.Log('[Sensors] SCOREBOARD OPENED -> Triggered shadow contrast jump & curiosity surge.');
				// Sudden dark layer triggers compound eye shadow detector & exploratory drive
				FLY_MOD.Connectome.stimulate('VIS_R1R6', 16);
				FLY_MOD.Connectome.stimulate('VIS_LC4', 12);
				FLY_MOD.Connectome.stimulate('CX_EB', 14);
				FLY_MOD.State.drives.curiosity = Math.min(1.0, FLY_MOD.State.drives.curiosity + 0.35);
			} else {
				FLY_MOD.Log('[Sensors] SCOREBOARD CLOSED -> Triggered optic flash.');
				FLY_MOD.Connectome.stimulate('VIS_R1R6', 22);
				FLY_MOD.Connectome.stimulate('VIS_LPTC', 12);
			}
		}

		/**
		 * Handles Upgrade Shop open/close transitions.
		 */
		onShopStateChange(isOpen) {
			FLY_MOD.State.gameState.shopOpen = isOpen;
			if (isOpen) {
				FLY_MOD.Log('[Sensors] SHOP OPENED -> Safe rest zone (grooming + reward triggered).');
				FLY_MOD.State.drives.fear = 0.0;
				FLY_MOD.Connectome.stimulate('SEZ_GROOM', 20);
				FLY_MOD.Connectome.stimulate('DAN_PAM', 14);
			} else {
				FLY_MOD.Log('[Sensors] SHOP CLOSED -> Back to active combat alertness.');
				FLY_MOD.Connectome.stimulate('CX_EB', 8);
			}
		}

		/**
		 * Compound eye motion & looming detection (Cursor / Crosshair optic flow).
		 */
		pollOpticFlow(dt) {
			if (typeof GameUI === 'undefined' || typeof GameUI.GetCursorPosition !== 'function') return;

			const cursorPos = GameUI.GetCursorPosition();
			if (!cursorPos || cursorPos.length < 2) return;

			const [mx, my] = cursorPos;

			if (this.lastMouseX < 0) {
				this.lastMouseX = mx;
				this.lastMouseY = my;
				return;
			}

			const { x: fx, y: fy, angle } = FLY_MOD.State;
			const dx = fx - mx;
			const dy = fy - my;
			const dist = Math.hypot(dx, dy);

			// Looming stimulus: cursor rapidly approaching the fly
			const loomingRate = (this.lastDistToCursor - dist) / Math.max(0.001, dt);

			if (dist < FLY_MOD.CONFIG.LOOMING_RADIUS) {
				// Visual motion excitation
				FLY_MOD.Connectome.stimulate('VIS_R1R6', 6);

				// Optic flow direction (left vs right eye activation)
				const angleToCursor = Math.atan2(my - fy, mx - fx);
				let relAngle = angleToCursor - angle;
				while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
				while (relAngle < -Math.PI) relAngle += 2 * Math.PI;

				if (relAngle > 0) {
					FLY_MOD.Connectome.stimulate('VIS_LPTC', 8); // Bias steering away
				}

				// Looming threat detected (rapid swat / aggressive approach -> LC4 & Giant Fiber)
				if (loomingRate > 250.0 && dist < 160.0) {
					FLY_MOD.Log(`[Sensors] LOOMING SWAT TRIGGERED! (rate=${loomingRate.toFixed(0)}px/s, dist=${dist.toFixed(0)}px) -> Giant Fiber escape jump!`);
					FLY_MOD.Connectome.stimulate('VIS_LC4', 26);
					FLY_MOD.Connectome.stimulate('DN_GF', 30);
					FLY_MOD.Connectome.stimulate('DAN_PPL1', 16);
					FLY_MOD.State.drives.fear = 1.0;
				}
			}

			this.lastMouseX = mx;
			this.lastMouseY = my;
			this.lastDistToCursor = dist;
		}

		/**
		 * Detects incoming damage taken, kills, and kill streaks via Deadlock HUD elements.
		 */
		pollCombatTelemetry() {
			if (!isAlive(this.cachedDamageImpactInfo)) {
				this.cachedDamageImpactInfo = this.findChild('damageImpactInfo');
				if (!isAlive(this.cachedDamageImpactInfo)) {
					const di = this.findChild('damage_impact');
					if (isAlive(di) && typeof di.FindChildTraverse === 'function') {
						this.cachedDamageImpactInfo = di.FindChildTraverse('damageImpactInfo');
					}
				}
				if (isAlive(this.cachedDamageImpactInfo)) {
					FLY_MOD.Log('Resolved damageImpactInfo HUD panel successfully.');
				}
			}

			let hasActiveDamageCard = false;

			if (isAlive(this.cachedDamageImpactInfo)) {
				let count = 0;
				try { count = this.cachedDamageImpactInfo.GetChildCount() || 0; } catch (_) { count = 0; }
				for (let i = 0; i < count; i++) {
					let child = null;
					try { child = this.cachedDamageImpactInfo.GetChild(i); } catch (_) {}
					if (!isAlive(child)) continue;

					const isKilled = this.hasClass(child, 'killed');
					const isAssist = this.hasClass(child, 'assist');

					// 1. Direct Kill detection (single-fire per recycled card instance via object property)
					if (isKilled && !isAssist) {
						if (!child.__flyKillFired) {
							child.__flyKillFired = true;
							this.onKillRegistered(false);
						}
					} else {
						child.__flyKillFired = false;
					}

					// 2. Direct Assist detection
					if (isAssist) {
						if (!child.__flyAssistFired) {
							child.__flyAssistFired = true;
							this.onKillRegistered(true);
						}
					} else {
						child.__flyAssistFired = false;
					}

					// 3. Active damage card (hero actively in combat: .fadeIn without .fadeOut)
					if (this.hasClass(child, 'fadeIn') && !this.hasClass(child, 'fadeOut')) {
						hasActiveDamageCard = true;
					}
				}
			}

			// 4. DataFeed killfeed backup (CitadelHudInfoFeed in EventFeed)
			if (!isAlive(this.cachedDataFeed)) {
				this.cachedDataFeed = this.findChild('DataFeed');
				if (isAlive(this.cachedDataFeed)) {
					this.cachedEventFeed = this.findChild('EventFeed') ||
						(this.cachedDataFeed.FindChildTraverse ? this.cachedDataFeed.FindChildTraverse('EventFeed') : null);
				}
			}
			if (isAlive(this.cachedEventFeed)) {
				let feedCount = 0;
				try { feedCount = this.cachedEventFeed.GetChildCount() || 0; } catch (_) { feedCount = 0; }
				for (let f = 0; f < feedCount; f++) {
					let item = null;
					try { item = this.cachedEventFeed.GetChild(f); } catch (_) {}
					if (!isAlive(item) || item.__flyFeedSeen) continue;
					item.__flyFeedSeen = true;

					// Hero killed in feed
					const enemyDied = this.hasClass(item, 'enemyDied');
					const isKillerFriend = this.hasClass(item, 'killerFriend');
					if (isKillerFriend && enemyDied) {
						this.onKillRegistered(false);
					}
				}
			}

			// 5. In-Combat state detection (InCombatAlert from QOLLOCK, HUD classes, or active damage cards)
			if (!isAlive(this.cachedInCombatAlert)) {
				this.cachedInCombatAlert = this.findChild('InCombatAlert');
			}

			const root = this.getRoot();
			const alertVisible = isAlive(this.cachedInCombatAlert) && this.hasClass(this.cachedInCombatAlert, 'Visible');
			const rootInCombat = root ? (this.hasClass(root, 'InCombat') || this.hasClass(root, 'in_combat') || this.hasClass(root, 'inCombat')) : false;
			const hudStateInCombat = isAlive(this.cachedHudState) ? (this.hasClass(this.cachedHudState, 'inCombat') || this.hasClass(this.cachedHudState, 'InCombat')) : false;

			const inCombat = alertVisible || rootInCombat || hudStateInCombat || hasActiveDamageCard;
			FLY_MOD.State.gameState.inCombat = inCombat;

			if (inCombat) {
				FLY_MOD.State.gameState.combatCooldown = 3.0;
				if (!this.prevInCombat && Date.now() > this.startupGraceUntil) {
					const reason = alertVisible ? 'InCombatAlert panel'
						: (rootInCombat ? 'Root HUD InCombat class'
						: (hudStateInCombat ? 'HudState InCombat class'
						: 'Active damageImpactInfo card'));
					this.onDamageTakenRegistered(reason);
				}
			} else if (this.prevInCombat && !inCombat) {
				FLY_MOD.Log('[Sensors] COMBAT ENDED -> Threat cleared, calming down.');
			}
			this.prevInCombat = inCombat;

			// 6. Kill Hype announcements (FirstBlood, MegaKill, Godlike, etc.)
			if (!isAlive(this.cachedHypeContainer)) {
				this.cachedHypeContainer = this.findChild('hype_container');
			}
			if (isAlive(this.cachedHypeContainer)) {
				let hypeCount = 0;
				try { hypeCount = this.cachedHypeContainer.GetChildCount() || 0; } catch (_) { hypeCount = 0; }
				for (let k = 0; k < hypeCount; k++) {
					let entry = null;
					try { entry = this.cachedHypeContainer.GetChild(k); } catch (_) {}
					if (!isAlive(entry) || entry.__flyHypeFired) continue;
					entry.__flyHypeFired = true;

					FLY_MOD.Log('Kill hype announcement triggered! Triumphant flight excitation.');
					FLY_MOD.Connectome.stimulate('DAN_PAM', 40);
					FLY_MOD.Connectome.stimulate('MN_WING_L', 20);
					FLY_MOD.Connectome.stimulate('MN_WING_R', 20);
				}
			}
		}

		/**
		 * Reads hero HP numbers directly from Deadlock HUD health bar.
		 */
		pollHealthStatus() {
			if (!isAlive(this.cachedCurrentHealth)) {
				this.cachedCurrentHealth = this.findChild('current_health');
			}
			if (!isAlive(this.cachedMaxHealth)) {
				this.cachedMaxHealth = this.findChild('max_health');
			}
			if (!isAlive(this.cachedLowHealthWarning)) {
				this.cachedLowHealthWarning = this.findChild('LowHealthWarning');
			}
			if (!isAlive(this.cachedLowHealthEffect)) {
				this.cachedLowHealthEffect = this.findChild('low_health_screen_effect') || this.findChild('low_health_effect');
			}

			let currentHp = 100;
			let maxHp = 100;

			if (isAlive(this.cachedCurrentHealth)) {
				const raw = this.cachedCurrentHealth.text || '';
				const val = parseInt(raw.replace(/[^0-9]/g, ''), 10);
				if (!isNaN(val) && val > 0) currentHp = val;
			}

			if (isAlive(this.cachedMaxHealth)) {
				const raw = this.cachedMaxHealth.text || '';
				const val = parseInt(raw.replace(/[^0-9]/g, ''), 10);
				if (!isNaN(val) && val > 0) maxHp = val;
			}

			FLY_MOD.State.gameState.currentHp = currentHp;
			FLY_MOD.State.gameState.maxHp = maxHp;

			const hpRatio = maxHp > 0 ? (currentHp / maxHp) : 1.0;
			const isCriticalClass = isAlive(this.cachedLowHealthWarning) && this.hasClass(this.cachedLowHealthWarning, 'localPlayerLowHealth');
			const isLowEffectActive = isAlive(this.cachedLowHealthEffect) && (
				this.hasClass(this.cachedLowHealthEffect, 'active') ||
				(this.cachedLowHealthEffect.style && parseFloat(this.cachedLowHealthEffect.style.opacity || '0') > 0.05)
			);

			const isLowHealth = (hpRatio < 0.25) || !!isCriticalClass || !!isLowEffectActive;
			FLY_MOD.State.gameState.lowHealth = isLowHealth;

			if (isLowHealth && !this.prevLowHealth && Date.now() > this.startupGraceUntil) {
				FLY_MOD.Log(`[Sensors] LOW HEALTH TRIGGERED! HP: ${currentHp}/${maxHp} (${(hpRatio * 100).toFixed(0)}%) -> Terror spike (DAN_PPL1 & DN_GF).`);
				FLY_MOD.Connectome.stimulate('DAN_PPL1', 25);
				FLY_MOD.Connectome.stimulate('DN_GF', 15);
				FLY_MOD.State.drives.fear = Math.min(1.0, FLY_MOD.State.drives.fear + 0.6);
			} else if (!isLowHealth && this.prevLowHealth) {
				FLY_MOD.Log(`[Sensors] HEALTH RECOVERED -> HP back to ${currentHp}/${maxHp} (${(hpRatio * 100).toFixed(0)}%).`);
			}

			this.prevLowHealth = isLowHealth;
		}

		/**
		 * Detects player death, spectating mode, and hero corpse feasting.
		 */
		pollDeathAndSpectator() {
			const root = this.getRoot();
			if (!root) return;

			// 1. Resolve HUD State panel by ascending from gameplay_hud_dead (moglock_hud.js pattern)
			if (!isAlive(this.cachedHudState)) {
				let cur = this.findChild('gameplay_hud_dead');
				let guard = 0;
				while (cur && guard++ < 30) {
					if (this.hasClass(cur, 'dead') || this.hasClass(cur, 'alive')) {
						this.cachedHudState = cur;
						break;
					}
					try {
						cur = (typeof cur.GetParent === 'function') ? cur.GetParent() : null;
					} catch (_) {
						break;
					}
				}
			}

			// 2. Check for respawn timer countdown (QOLLOCK ql_on_death_arcade pattern)
			let respawnTimerActive = false;
			if (!isAlive(this.cachedRespawnTimer)) {
				this.cachedRespawnTimer = this.findChild('respawn_timer');
			}
			if (isAlive(this.cachedRespawnTimer)) {
				let numLabel = null;
				try {
					numLabel = this.cachedRespawnTimer.FindChildTraverse ? this.cachedRespawnTimer.FindChildTraverse('respawn_number') : null;
				} catch (_) {}
				if (isAlive(numLabel) && numLabel.text) {
					const secs = parseFloat(String(numLabel.text).replace(/[^0-9.]/g, ''));
					if (isFinite(secs) && secs > 0) {
						respawnTimerActive = true;
					}
				}
			}

			// 3. Determine Dead and Spectator status
			const isHudDead = isAlive(this.cachedHudState) ? this.hasClass(this.cachedHudState, 'dead') : false;
			const isRootDead = this.hasClass(root, 'dead') || this.hasClass(root, 'Dead');
			const isDead = isHudDead || isRootDead || respawnTimerActive;

			const isSpectator = this.hasClass(root, 'Spectator') ||
				(isAlive(this.cachedHudState) && (
					this.hasClass(this.cachedHudState, 'spectatingUnit') ||
					this.hasClass(this.cachedHudState, 'is_spectator') ||
					this.hasClass(this.cachedHudState, 'TeamSpectator')
				));

			FLY_MOD.State.gameState.isDead = isDead;
			FLY_MOD.State.gameState.isSpectator = isSpectator;

			if (Date.now() > this.startupGraceUntil) {
				// Edge transition: Alive -> Dead
				if (isDead && !this.prevIsDead) {
					this.onPlayerDeath();
				}
				// Edge transition: Dead -> Alive (Respawn)
				else if (!isDead && this.prevIsDead) {
					this.onPlayerRespawn();
				}
			}

			this.prevIsDead = isDead;
		}

		/**
		 * Triggered when local hero dies (corpse feasting).
		 */
		onPlayerDeath() {
			FLY_MOD.Log('[Sensors] PLAYER DEATH TRIGGERED! Local hero dead -> Corpse feasting target placed at center screen.');
			FLY_MOD.State.gameState.isDead = true;
			FLY_MOD.State.drives.fear = 0.0;
			FLY_MOD.State.drives.hunger = 0.95;

			// Flood connectome with taste and dopamine reward
			FLY_MOD.Connectome.stimulate('GUS_GR', 32);
			FLY_MOD.Connectome.stimulate('DAN_PAM', 28);
			FLY_MOD.Connectome.stimulate('SEZ_FEED', 22);

			// Feasting attractor on center screen
			FLY_MOD.State.foodTarget = {
				x: 960 + (Math.random() - 0.5) * 140,
				y: 540 + (Math.random() - 0.5) * 100,
				expires: Date.now() + 20000,
			};
		}

		/**
		 * Triggered when local hero respawns (explosive startle escape).
		 */
		onPlayerRespawn() {
			FLY_MOD.Log('[Sensors] PLAYER RESPAWN TRIGGERED! Hero revived -> Explosive Giant Fiber startle escape!');
			FLY_MOD.State.gameState.isDead = false;
			FLY_MOD.State.foodTarget = null;
			FLY_MOD.Connectome.stimulate('DN_GF', 35);
			FLY_MOD.Connectome.stimulate('MECH_BRISTLE', 26);
			FLY_MOD.Connectome.stimulate('VIS_LC4', 22);
			FLY_MOD.State.drives.fear = 0.85;
		}

		/**
		 * Fallback polling of Deadlock GlobalClassListener classes on HUD root and HUD state.
		 */
		pollGlobalHudClasses() {
			const root = this.getRoot();
			const hud = this.cachedHudState;
			const hasCls = (cls) => (root && this.hasClass(root, cls)) || (hud && this.hasClass(hud, cls));

			// 1. Fallback Scoreboard state check
			const sbOpen = hasCls('gScoreboardOpen') || hasCls('ScoreboardOpen') || hasCls('wants_scoreboard');
			if (sbOpen !== this.prevScoreboardOpen) {
				this.onScoreboardToggle(sbOpen);
				this.prevScoreboardOpen = sbOpen;
			}

			// 2. Fallback Shop state check
			const shopOpen = hasCls('gShopOpen');
			if (shopOpen !== this.prevShopOpen) {
				this.onShopStateChange(shopOpen);
				this.prevShopOpen = shopOpen;
			}
		}

		/**
		 * Triggered when the player secures a kill or assist (feasting signal).
		 */
		onKillRegistered(isAssist, source = 'HUD') {
			const reward = isAssist ? 20 : 38;
			const type = isAssist ? 'ASSIST' : 'KILL';
			FLY_MOD.Log(`[Sensors] ${type} TRIGGERED! (source=${source}) -> Dopamine reward (DAN_PAM +${reward}), foodTarget spawned, takeoff!`);

			// Dopamine rush & motor takeoff
			FLY_MOD.Connectome.stimulate('DAN_PAM', reward);
			FLY_MOD.Connectome.stimulate('GUS_GR', isAssist ? 14 : 26);
			FLY_MOD.Connectome.stimulate('SEZ_FEED', isAssist ? 18 : 26);
			FLY_MOD.Connectome.stimulate('MN_WING_L', 24);
			FLY_MOD.Connectome.stimulate('MN_WING_R', 24);

			// Fear recedes; hunger & feeding interest spike
			FLY_MOD.State.drives.fear = 0.0;
			FLY_MOD.State.drives.hunger = 0.95;
			FLY_MOD.State.z = Math.max(0.2, FLY_MOD.State.z); // Take off immediately to fly to feast
			FLY_MOD.State.currentBehavior = 'fly';

			// Place feeding attractor near screen center
			FLY_MOD.State.foodTarget = {
				x: 960 + (Math.random() - 0.5) * 220,
				y: 540 + (Math.random() - 0.5) * 160,
				expires: Date.now() + 8000,
			};
		}

		/**
		 * Triggered when player sustains combat damage (pain / shock).
		 */
		onDamageTakenRegistered(source = 'Combat') {
			FLY_MOD.Log(`[Sensors] COMBAT DAMAGE TRIGGERED! (source=${source}) -> Fear spike (+0.35), stimulating PPL1, GF & BRISTLE.`);
			FLY_MOD.Connectome.stimulate('MECH_BRISTLE', 18);
			FLY_MOD.Connectome.stimulate('DAN_PPL1', 20);
			FLY_MOD.Connectome.stimulate('DN_GF', 14);
			FLY_MOD.State.drives.fear = Math.min(1.0, FLY_MOD.State.drives.fear + 0.35);
			FLY_MOD.State.gameState.inCombat = true;
			FLY_MOD.State.gameState.combatCooldown = 4.0;
		}

		/**
		 * Direct physical touch (cursor directly atop fly).
		 */
		pollPhysicalContact() {
			if (this.lastDistToCursor < 26.0) {
				if (!this.contactActive) {
					this.contactActive = true;
					FLY_MOD.Log(`[Sensors] DIRECT TOUCH TRIGGERED! (cursor atop fly, dist=${this.lastDistToCursor.toFixed(0)}px) -> Bristle escape!`);
				}
				FLY_MOD.Connectome.stimulate('MECH_BRISTLE', 28);
				FLY_MOD.Connectome.stimulate('DN_GF', 26);
				FLY_MOD.State.drives.fear = 1.0;
			} else {
				this.contactActive = false;
			}
		}
	}

	FLY_MOD.Sensors = new SensoryInterface();
	FLY_MOD.Log('Sensory subsystem initialized with full Deadlock telemetry & unhandled events');
})();
