/**
 * @file fly_debug.js
 * @brief Real-time biological neural telemetry monitor & in-game benchmark for Deadlock-Fly (ES6+).
 *
 * Displays live firing levels of Giant Fiber escape circuits, optic flow neurons,
 * dopamine reward/punishment pathways, and current metabolic state in an unobtrusive
 * HUD monitor badge.
 *
 * Includes an automated 10-second performance benchmark (modeled on QOLLOCK),
 * measuring tick counts, average/maximum execution time per subsystem, and spike frequency.
 * Automatically runs 30 seconds after game launch and logs full diagnostics to console (~).
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

	const padL = (val, len) => {
		let s = String(val !== undefined && val !== null ? val : '');
		while (s.length < len) s = ' ' + s;
		return s;
	};

	const padR = (val, len) => {
		let s = String(val !== undefined && val !== null ? val : '');
		while (s.length < len) s = s + ' ';
		return s;
	};

	/**
	 * Formats benchmark statistics into a readable console diagnostic table.
	 */
	const formatBenchmarkReport = (bm, durSec) => {
		if (!bm) return 'No benchmark data recorded.';
		const dur = (durSec || 10).toFixed(1);
		const totalTicks = bm.totalTicks || 0;
		const ticksPerSec = (totalTicks / (durSec || 1)).toFixed(1);
		const totalJs = (bm.totalJsMs || 0).toFixed(2);
		const avgPerTick = (totalTicks > 0 ? (bm.totalJsMs / totalTicks) : 0).toFixed(3);
		const budgetPct = (((bm.totalJsMs || 0) / ((durSec || 1) * 1000)) * 100).toFixed(2);
		const maxSpike = (bm.maxTickMs || 0).toFixed(2) + ' ms';
		const spikes = bm.spikeCount || 0;

		const sep = '--------------------------------------------------------------------------------';
		const eq = '================================================================================';

		const lines = [
			eq,
			`DEADLOCK-FLY IN-GAME BENCHMARK REPORT (${dur}s sample)`,
			eq,
			'Simulation Target: 30 Hz (TICK_RATE = 0.033s)',
			`Total Sim Ticks:   ${totalTicks} (${ticksPerSec} ticks/s)`,
			`Total V8 JS Time:  ${totalJs} ms (${budgetPct}% of 60fps frame budget)`,
			`Avg JS Per Tick:   ${avgPerTick} ms`,
			`Max Single Tick:   ${maxSpike}`,
			`Spikes (>= 4ms):   ${spikes}`,
			'',
			'SUBSYSTEM BREAKDOWN BY JS EXECUTION TIME:',
			'  #   Subsystem                  Total(ms)   Avg(ms)   Max(ms)   Ticks  Spikes',
			sep,
		];

		const subsystems = [];
		const bySub = bm.bySubsystem || {};
		for (const k in bySub) {
			if (Object.prototype.hasOwnProperty.call(bySub, k)) {
				subsystems.push({
					id: k,
					count: bySub[k].count,
					totalMs: bySub[k].totalMs,
					maxMs: bySub[k].maxMs,
					spikes: bySub[k].spikes,
				});
			}
		}
		subsystems.sort((a, b) => b.totalMs - a.totalMs);

		if (subsystems.length === 0) {
			lines.push('  No subsystem activity recorded during benchmark.');
		} else {
			for (let i = 0; i < subsystems.length; i++) {
				const s = subsystems[i];
				const rank = padL(`${i + 1}.`, 4);
				const nameCol = padR(s.id, 25);
				const totCol = padL(s.totalMs.toFixed(2), 10);
				const avgCol = padL((s.count > 0 ? (s.totalMs / s.count) : 0).toFixed(3), 10);
				const maxCol = padL(s.maxMs.toFixed(2), 10);
				const cntCol = padL(s.count, 8);
				const spkCol = padL(s.spikes || 0, 8);
				lines.push(`${rank} ${nameCol} ${totCol} ${avgCol} ${maxCol} ${cntCol} ${spkCol}`);
			}
		}

		lines.push(eq);
		return lines.join('\n');
	};

	class NeuralMonitor {
		constructor() {
			this.isVisible = FLY_MOD.CONFIG.SHOW_DEBUG_MONITOR;
			this.benchmarkActive = false;
			this.benchmarkStartTime = 0;
			this.benchmarkDurationSec = 10;
			this.benchmarkStats = null;
			this.lastBenchmarkSummary = null;
		}

		/**
		 * Toggles visibility of the neural activity monitor.
		 */
		toggle() {
			this.isVisible = !this.isVisible;
			const p = FLY_MOD.State.panels.monitor;
			if (isAlive(p)) {
				p.SetHasClass('collapsed', !this.isVisible);
			}
			FLY_MOD.Log(`Neural monitor toggled: ${this.isVisible ? 'VISIBLE' : 'COLLAPSED'}`);
		}

		/**
		 * Starts a dedicated in-game performance benchmark.
		 * Measures total ticks, avg ms, max ms, spikes, and per-subsystem execution times.
		 */
		startBenchmark(durationSec = 10, onComplete = null) {
			if (this.benchmarkActive) {
				FLY_MOD.Log('Benchmark already in progress.');
				return;
			}

			const durSec = typeof durationSec === 'number' && durationSec > 0 ? durationSec : 10;
			this.benchmarkActive = true;
			this.benchmarkStartTime = Date.now();
			this.benchmarkDurationSec = durSec;
			this.benchmarkStats = {
				totalTicks: 0,
				totalJsMs: 0,
				maxTickMs: 0,
				spikeCount: 0,
				bySubsystem: {
					Sensors: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
					Connectome: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
					Brain: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
					Physics: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
					Render: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
					DebugUI: { totalMs: 0, maxMs: 0, count: 0, spikes: 0 },
				},
			};

			FLY_MOD.Log(`Starting ${durSec}s performance benchmark...`);
			$.Msg(`[Deadlock-Fly] Starting ${durSec}s in-game performance benchmark...`);

			$.Schedule(durSec, () => {
				if (!this.benchmarkActive) return;
				this.benchmarkActive = false;
				const actualDurSec = Math.max(0.1, (Date.now() - this.benchmarkStartTime) / 1000);
				const report = formatBenchmarkReport(this.benchmarkStats, actualDurSec);

				const reportLines = report.split('\n');
				for (const line of reportLines) {
					$.Msg(line);
				}

				this.lastBenchmarkSummary = {
					ticks: this.benchmarkStats.totalTicks,
					avgMs: this.benchmarkStats.totalTicks > 0
						? (this.benchmarkStats.totalJsMs / this.benchmarkStats.totalTicks)
						: 0,
					maxMs: this.benchmarkStats.maxTickMs,
					totalJsMs: this.benchmarkStats.totalJsMs,
				};

				if (typeof onComplete === 'function') {
					try {
						onComplete(report, this.benchmarkStats);
					} catch (e) {
						FLY_MOD.Warn(`Benchmark onComplete error: ${e}`);
					}
				}
			});
		}

		/**
		 * Records execution duration for a specific simulation subsystem.
		 */
		recordSubsystemTime(name, elapsedMs) {
			if (!this.benchmarkActive || !this.benchmarkStats) return;
			const sub = this.benchmarkStats.bySubsystem[name];
			if (!sub) return;
			sub.count++;
			sub.totalMs += elapsedMs;
			if (elapsedMs > sub.maxMs) sub.maxMs = elapsedMs;
			if (elapsedMs >= 4.0) sub.spikes++;
		}

		/**
		 * Records overall tick execution duration.
		 */
		recordTick(elapsedMs) {
			if (!this.benchmarkActive || !this.benchmarkStats) return;
			const bm = this.benchmarkStats;
			bm.totalTicks++;
			bm.totalJsMs += elapsedMs;
			if (elapsedMs > bm.maxTickMs) bm.maxTickMs = elapsedMs;
			if (elapsedMs >= 4.0) bm.spikeCount++;
		}

		/**
		 * Updates channel meters and status label on each tick.
		 */
		update() {
			const { panels } = FLY_MOD.State;
			if (!isAlive(panels.monitor)) {
				return;
			}

			const { V, thisState: cur, accumulators: acc } = FLY_MOD.Connectome;
			const { currentBehavior } = FLY_MOD.State;

			// 1. Update State Label (reflecting active benchmark or behavior)
			if (isAlive(panels.stateLabel)) {
				if (this.benchmarkActive) {
					const elapsedSec = Math.max(0, Math.floor((Date.now() - this.benchmarkStartTime) / 1000));
					const remSec = Math.max(0, this.benchmarkDurationSec - elapsedSec);
					panels.stateLabel.text = `BENCHMARK (${remSec}s)...`;
				} else if (this.lastBenchmarkSummary) {
					const avg = this.lastBenchmarkSummary.avgMs.toFixed(2);
					const max = this.lastBenchmarkSummary.maxMs.toFixed(2);
					panels.stateLabel.text = `${currentBehavior.toUpperCase()} (AVG: ${avg}ms MAX: ${max}ms)`;
				} else {
					let stateStr = currentBehavior.toUpperCase();
					if (currentBehavior === 'panic') stateStr = 'PANIC / GF BURST!';
					else if (currentBehavior === 'feed') stateStr = 'FEEDING ON KILL';
					else if (currentBehavior === 'fly') stateStr = 'IN FLIGHT (LIFT)';
					panels.stateLabel.text = stateStr;
				}
			}

			if (!this.isVisible) return;

			// 2. Helper to set meter fill percentage (0..100%)
			const setBar = (panelId, value, maxVal) => {
				const bar = panels.bars[panelId];
				if (!isAlive(bar)) return;

				const pct = Math.min(100, Math.max(0, (value / maxVal) * 100));
				bar.style.width = `${pct.toFixed(1)}%`;
			};

			// 3. Update Individual Neural Channels
			const gfPotential = V['DN_GF'] ? V['DN_GF'][cur] : 0;
			const lptcPotential = V['VIS_LPTC'] ? V['VIS_LPTC'][cur] : 0;
			const pamPotential = V['DAN_PAM'] ? V['DAN_PAM'][cur] : 0;
			const ppl1Potential = V['DAN_PPL1'] ? V['DAN_PPL1'][cur] : 0;

			setBar('Bar_DN_GF', gfPotential, 24);
			setBar('Bar_VIS_LPTC', lptcPotential, 20);
			setBar('Bar_DAN_PAM', pamPotential, 25);
			setBar('Bar_DAN_PPL1', ppl1Potential, 25);
			setBar('Bar_WINGS', acc.flight, 30);
		}
	}

	FLY_MOD.Debug = new NeuralMonitor();
	FLY_MOD.Log('Debug telemetry subsystem initialized (ES6 class)');

	// Automatically run 10-second benchmark 30 seconds after game startup
	$.Schedule(30.0, () => {
		if (FLY_MOD.Debug && typeof FLY_MOD.Debug.startBenchmark === 'function') {
			FLY_MOD.Debug.startBenchmark(10);
		}
	});
})();
