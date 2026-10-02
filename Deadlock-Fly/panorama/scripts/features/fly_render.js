/**
 * @file fly_render.js
 * @brief Master simulation loop and Panorama DOM visual renderer for Deadlock-Fly (ES6+).
 *
 * Drives the 30 Hz tick loop via $.Schedule, coordinates sensory polling, neural
 * computation, and kinematics, and applies hardware-accelerated 3D CSS transforms
 * to the insect sprite and vector appendages.
 *
 * All overlay panels are created dynamically at runtime to maintain 100% compliance
 * with Deadlock's base_hud.xml architecture and prevent fatal C++ layout parse errors.
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

	const nowPrecise = (typeof globalThis.performance !== 'undefined' && globalThis.performance && typeof globalThis.performance.now === 'function')
		? () => globalThis.performance.now()
		: () => Date.now();

	class RenderController {
		constructor() {
			this.lastTickTime = 0;
			this.currentSpriteState = '';
		}

		/**
		 * Dynamically creates and caches required Panorama panels under the root HUD.
		 */
		initPanels() {
			const { panels } = FLY_MOD.State;
			const root = (typeof $ !== 'undefined' && typeof $.GetContextPanel === 'function')
				? $.GetContextPanel()
				: null;

			if (!root) {
				FLY_MOD.Warn('initPanels: $.GetContextPanel() returned null');
				return;
			}

			let overlay = null;
			try {
				overlay = root.FindChildTraverse('DrosophilaOverlay');
			} catch (e) {
				overlay = null;
			}

			if (!overlay && typeof $.CreatePanel === 'function') {
				try {
					overlay = $.CreatePanel('Panel', root, 'DrosophilaOverlay');
					overlay.hittest = false;
					overlay.hittestchildren = false;

					const flyRoot = $.CreatePanel('Panel', overlay, 'FlyRoot');
					flyRoot.AddClass('FlyRoot');
					flyRoot.AddClass('state-idle');
					flyRoot.hittest = false;
					flyRoot.hittestchildren = false;

					// Set initial centered screen position immediately upon creation
					const originOffset = 64;
					const initX = FLY_MOD.State.x - originOffset;
					const initY = FLY_MOD.State.y - originOffset;
					flyRoot.style.x = `${initX.toFixed(1)}px`;
					flyRoot.style.y = `${initY.toFixed(1)}px`;
					flyRoot.style.preTransformRotate2d = '0deg';
					flyRoot.style.preTransformScale2d = `${FLY_MOD.CONFIG.BASE_SCALE.toFixed(2)}, ${FLY_MOD.CONFIG.BASE_SCALE.toFixed(2)}`;
					flyRoot.style.transform = 'none';

					const shadow = $.CreatePanel('Panel', flyRoot, 'FlyShadow');
					shadow.AddClass('FlyShadow');
					shadow.hittest = false;
					shadow.hittestchildren = false;
					shadow.style.y = '8px';
					shadow.style.preTransformScale2d = '1.0, 1.0';
					shadow.style.opacity = '0.55';
					shadow.style.transform = 'none';

					const sprite = $.CreatePanel('Image', flyRoot, 'FlySprite');
					sprite.AddClass('FlySprite');
					sprite.hittest = false;
					sprite.hittestchildren = false;
					if (sprite.SetScaling) sprite.SetScaling('stretch-to-cover-preserve-aspect');
					if (sprite.SetImage) sprite.SetImage('s2r://panorama/images/fly/fly_idle.vtex');

					const wingL = $.CreatePanel('Image', flyRoot, 'FlyWingL');
					wingL.AddClass('FlyWing');
					wingL.AddClass('WingLeft');
					wingL.hittest = false;
					wingL.hittestchildren = false;
					if (wingL.SetScaling) wingL.SetScaling('stretch-to-cover-preserve-aspect');
					if (wingL.SetImage) wingL.SetImage('s2r://panorama/images/fly/fly_wing_l.vsvg');

					const wingR = $.CreatePanel('Image', flyRoot, 'FlyWingR');
					wingR.AddClass('FlyWing');
					wingR.AddClass('WingRight');
					wingR.hittest = false;
					wingR.hittestchildren = false;
					if (wingR.SetScaling) wingR.SetScaling('stretch-to-cover-preserve-aspect');
					if (wingR.SetImage) wingR.SetImage('s2r://panorama/images/fly/fly_wing_r.vsvg');

					// Dynamic Neural Monitor Badge
					const monitor = $.CreatePanel('Panel', overlay, 'FlyNeuralMonitor');
					monitor.AddClass('FlyMonitor');
					monitor.AddClass('collapsed');
					monitor.hittest = false;
					monitor.hittestchildren = false;

					const header = $.CreatePanel('Panel', monitor, '');
					header.AddClass('MonitorHeader');
					header.hittest = false;
					header.hittestchildren = false;

					const title = $.CreatePanel('Label', header, '');
					title.AddClass('MonitorTitle');
					title.hittest = false;
					title.text = 'DROSOPHILA CONNECTOME (LIF SNN)';

					const stateLabel = $.CreatePanel('Label', header, 'FlyStateLabel');
					stateLabel.AddClass('MonitorState');
					stateLabel.hittest = false;
					stateLabel.text = 'IDLE';

					const channels = $.CreatePanel('Panel', monitor, '');
					channels.AddClass('MonitorChannels');
					channels.hittest = false;
					channels.hittestchildren = false;

					const chanDefs = [
						{ id: 'Bar_DN_GF', label: 'GF (Escape):' },
						{ id: 'Bar_VIS_LPTC', label: 'LPTC (Optic):' },
						{ id: 'Bar_DAN_PAM', label: 'PAM (Reward):' },
						{ id: 'Bar_DAN_PPL1', label: 'PPL1 (Fear):' },
						{ id: 'Bar_WINGS', label: 'Wings L/R:' },
					];

					for (const def of chanDefs) {
						const row = $.CreatePanel('Panel', channels, '');
						row.AddClass('MonitorRow');
						row.hittest = false;
						row.hittestchildren = false;

						const lbl = $.CreatePanel('Label', row, '');
						lbl.AddClass('ChanLabel');
						lbl.hittest = false;
						lbl.text = def.label;

						const barCont = $.CreatePanel('Panel', row, '');
						barCont.AddClass('ChanBarContainer');
						barCont.hittest = false;
						barCont.hittestchildren = false;

						const bar = $.CreatePanel('Panel', barCont, def.id);
						bar.AddClass('ChanBar');
						bar.hittest = false;
					}
				} catch (e) {
					FLY_MOD.Warn(`initPanels error creating panels: ${e}`);
				}
			}

			if (overlay && overlay.FindChildTraverse) {
				overlay.hittest = false;
				overlay.hittestchildren = false;
				panels.overlay = overlay;
				panels.flyRoot = overlay.FindChildTraverse('FlyRoot');
				panels.flySprite = overlay.FindChildTraverse('FlySprite');
				panels.flyShadow = overlay.FindChildTraverse('FlyShadow');
				panels.wingL = overlay.FindChildTraverse('FlyWingL');
				panels.wingR = overlay.FindChildTraverse('FlyWingR');
				panels.monitor = overlay.FindChildTraverse('FlyNeuralMonitor');
				panels.stateLabel = overlay.FindChildTraverse('FlyStateLabel');

				const barIds = ['Bar_DN_GF', 'Bar_VIS_LPTC', 'Bar_DAN_PAM', 'Bar_DAN_PPL1', 'Bar_WINGS'];
				for (const bid of barIds) {
					panels.bars[bid] = overlay.FindChildTraverse(bid);
				}
			}

			const dims = (typeof FLY_MOD.GetScreenDimensions === 'function')
				? FLY_MOD.GetScreenDimensions()
				: { w: 1920, h: 1080 };

			FLY_MOD.Log(`Render panels initialized dynamically. Screen: ${dims.w}x${dims.h}`);
		}

		/**
		 * Main simulation and rendering tick.
		 */
		tick() {
			try {
				// Generation token guard
				if (typeof FLY_MOD.IsCurrentGeneration === 'function' && !FLY_MOD.IsCurrentGeneration()) {
					FLY_MOD.Log(`Retiring older generation loop (${FLY_MOD.State.generation})`);
					return;
				}

				const now = Date.now();
				let dt = this.lastTickTime > 0 ? (now - this.lastTickTime) / 1000.0 : FLY_MOD.CONFIG.TICK_RATE;
				if (dt > 0.1) dt = 0.1;
				this.lastTickTime = now;

				const benchActive = !!(FLY_MOD.Debug && FLY_MOD.Debug.benchmarkActive);
				const tickT0 = benchActive ? nowPrecise() : 0;

				// 1. Sensory Ingestion
				let t0 = benchActive ? nowPrecise() : 0;
				if (FLY_MOD.Sensors) FLY_MOD.Sensors.poll(dt);
				if (benchActive) FLY_MOD.Debug.recordSubsystemTime('Sensors', nowPrecise() - t0);

				// 2. Biological Connectome Spiking Network Tick
				t0 = benchActive ? nowPrecise() : 0;
				if (FLY_MOD.Connectome) FLY_MOD.Connectome.tick();
				if (benchActive) FLY_MOD.Debug.recordSubsystemTime('Connectome', nowPrecise() - t0);

				// 3. Metabolic Brain Arbitration
				t0 = benchActive ? nowPrecise() : 0;
				if (FLY_MOD.Brain) FLY_MOD.Brain.update(dt);
				if (benchActive) FLY_MOD.Debug.recordSubsystemTime('Brain', nowPrecise() - t0);

				// 4. Physical Locomotion & Aerodynamics
				t0 = benchActive ? nowPrecise() : 0;
				if (FLY_MOD.Physics) FLY_MOD.Physics.update(dt);
				if (benchActive) FLY_MOD.Debug.recordSubsystemTime('Physics', nowPrecise() - t0);

				// 5. Panorama DOM Scene Graph Update
				t0 = benchActive ? nowPrecise() : 0;
				this.updateScene();
				if (benchActive) FLY_MOD.Debug.recordSubsystemTime('Render', nowPrecise() - t0);

				// 6. Neural Monitor Update (if active)
				t0 = benchActive ? nowPrecise() : 0;
				if (FLY_MOD.Debug) {
					FLY_MOD.Debug.update();
				}
				if (benchActive) {
					FLY_MOD.Debug.recordSubsystemTime('DebugUI', nowPrecise() - t0);
					FLY_MOD.Debug.recordTick(nowPrecise() - tickT0);
				}
			} catch (e) {
				FLY_MOD.Warn(`Exception in simulation tick: ${e} ${(e && e.stack) ? e.stack : ''}`);
			}

			// Re-schedule next frame (ALWAYS scheduled so simulation never freezes)
			$.Schedule(FLY_MOD.CONFIG.TICK_RATE, () => this.tick());
		}

		/**
		 * Updates CSS classes, transforms, and sprite states on the DOM elements.
		 */
		updateScene() {
			const { panels } = FLY_MOD.State;
			if (!isAlive(panels.flyRoot)) {
				this.initPanels();
				if (!isAlive(panels.flyRoot)) return;
			}

			if (typeof FLY_MOD.GetScreenDimensions === 'function') {
				FLY_MOD.GetScreenDimensions();
			}

			const state = FLY_MOD.State;
			const beh = state.currentBehavior;

			// 1. Update sprite image texture if behavior state changed
			if (this.currentSpriteState !== beh) {
				this.currentSpriteState = beh;
				const spriteMap = {
					idle: 's2r://panorama/images/fly/fly_idle.vtex',
					walk: 's2r://panorama/images/fly/fly_walking.vtex',
					fly: 's2r://panorama/images/fly/fly_flying.vtex',
					panic: 's2r://panorama/images/fly/fly_flying.vtex',
					groom: 's2r://panorama/images/fly/fly_grooming.vtex',
					feed: 's2r://panorama/images/fly/fly_feeding.vtex',
				};

				const imgPath = spriteMap[beh] || spriteMap.idle;
				if (isAlive(panels.flySprite)) {
					if (panels.flySprite.SetImage) {
						try {
							panels.flySprite.SetImage(imgPath);
							FLY_MOD.Log(`[Render] Sprite texture updated -> ${imgPath} (behavior: ${beh})`);
						} catch (eImg) {
							FLY_MOD.Warn(`[Render] Failed to set image ${imgPath}: ${eImg}`);
						}
					}
				}

				// Apply state classes
				const states = ['idle', 'walk', 'fly', 'panic', 'groom', 'feed'];
				for (const st of states) {
					if (panels.flyRoot.SetHasClass) {
						panels.flyRoot.SetHasClass(`state-${st}`, beh === st);
					}
				}
			}

			// 2. Compute 3D transform (position, rotation, 3D altitude scale)
			const dims = (typeof FLY_MOD.GetScreenDimensions === 'function')
				? FLY_MOD.GetScreenDimensions()
				: { w: 1920, h: 1080 };
			const w = (Number.isFinite(dims.w) && dims.w >= 640) ? dims.w : 1920;
			const h = (Number.isFinite(dims.h) && dims.h >= 360) ? dims.h : 1080;

			const safeX = Number.isFinite(state.x) ? state.x : w / 2;
			const safeY = Number.isFinite(state.y) ? state.y : h / 2;
			const safeAngle = Number.isFinite(state.angle) ? state.angle : 0.0;
			const safeZ = Number.isFinite(state.z) ? Math.max(0.0, Math.min(1.0, state.z)) : 0.0;

			let rotDeg = (safeAngle + Math.PI / 2) * (180.0 / Math.PI);
			while (rotDeg > 180) rotDeg -= 360;
			while (rotDeg < -180) rotDeg += 360;

			const altitudeScale = FLY_MOD.CONFIG.BASE_SCALE + safeZ * FLY_MOD.CONFIG.ALTITUDE_SCALE_MAX;
			const originOffset = 64;

			// Double-clamp render coordinates strictly within screen viewport to prevent CSS corruption
			const renderX = Math.max(0, Math.min(w - 128, safeX - originOffset));
			const renderY = Math.max(0, Math.min(h - 128, safeY - originOffset));

			if (isAlive(panels.flyRoot) && panels.flyRoot.style) {
				panels.flyRoot.style.x = `${renderX.toFixed(1)}px`;
				panels.flyRoot.style.y = `${renderY.toFixed(1)}px`;
				panels.flyRoot.style.preTransformRotate2d = `${rotDeg.toFixed(1)}deg`;
				panels.flyRoot.style.preTransformScale2d = `${altitudeScale.toFixed(2)}, ${altitudeScale.toFixed(2)}`;
				panels.flyRoot.style.transform = 'none';
			}

			// 3. Dynamic Flight Shadow
			if (isAlive(panels.flyShadow) && panels.flyShadow.style) {
				const shadowY = (8 + safeZ * 28).toFixed(1);
				const shadowScale = (1.0 - safeZ * 0.25).toFixed(2);
				const shadowOpacity = (0.55 - safeZ * 0.3).toFixed(2);

				panels.flyShadow.style.y = `${shadowY}px`;
				panels.flyShadow.style.preTransformScale2d = `${shadowScale}, ${shadowScale}`;
				panels.flyShadow.style.opacity = shadowOpacity;
				panels.flyShadow.style.transform = 'none';
			}

			// 4. In-flight high-speed wing vibration
			if (beh === 'fly' || beh === 'panic') {
				const buzz = Math.sin(state.wingBuzzPhase) * 14.0;
				if (isAlive(panels.wingL) && panels.wingL.style) {
					panels.wingL.style.transform = `rotateZ(${(55 + buzz).toFixed(1)}deg)`;
				}
				if (isAlive(panels.wingR) && panels.wingR.style) {
					panels.wingR.style.transform = `rotateZ(${(-55 - buzz).toFixed(1)}deg)`;
				}
			}
		}
	}

	FLY_MOD.Render = new RenderController();

	// Start the simulation loop
	$.Schedule(0.1, () => {
		FLY_MOD.Render.initPanels();
		FLY_MOD.Log('Starting master simulation tick loop (ES6 class)');
		FLY_MOD.Render.tick();
	});
})();
