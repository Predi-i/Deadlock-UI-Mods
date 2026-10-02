/**
 * @file fly_connectome.js
 * @brief Leaky Integrate-and-Fire (LIF) biological Spiking Neural Network engine (ES6+).
 *
 * Implements double-buffered dendritic accumulation, synaptic propagation,
 * exponential membrane potential decay (leak), spike thresholding, motor output
 * integration, and Hebbian synaptic plasticity (learning over time).
 */

'use strict';

globalThis.FLY_MOD = globalThis.FLY_MOD || {};

(() => {
	class ConnectomeEngine {
		constructor() {
			// Membrane potentials: Map or Object [neuron] -> [buffer0, buffer1]
			this.V = {};

			// Double-buffering buffer pointers
			this.thisState = 0;
			this.nextState = 1;

			// Biological parameters
			this.fireThreshold = 20;
			this.leakRate = 0.94; // Decay factor per tick

			// Motor action accumulators (accumulates spikes from motor neurons)
			this.accumulators = {
				walkLeft: 0,
				walkRight: 0,
				flight: 0,
				startle: 0,
				feed: 0,
				groom: 0,
			};

			// Spikes fired on the most recent tick
			this.lastFired = new Set();

			this.init();
		}

		/**
		 * Initializes all neuron potential buffers.
		 */
		init() {
			this.V = {};
			for (const n of FLY_MOD.ALL_NEURONS) {
				this.V[n] = [0, 0];
			}
			this.resetAccumulators();
			FLY_MOD.Log(`Connectome engine initialized with ${FLY_MOD.ALL_NEURONS.length} LIF neurons (ES6 class)`);
		}

		resetAccumulators() {
			this.accumulators.walkLeft = 0;
			this.accumulators.walkRight = 0;
			this.accumulators.flight = 0;
			this.accumulators.startle = 0;
			this.accumulators.feed = 0;
			this.accumulators.groom = 0;
		}

		/**
		 * Injects electrical charge into a specific neuron (sensory stimulation).
		 */
		stimulate(neuron, amount) {
			if (this.V[neuron]) {
				this.V[neuron][this.thisState] += amount;
			}
		}

		/**
		 * Propagates synaptic charge from a firing presynaptic neuron to its targets.
		 */
		dendriteAccumulate(preNeuron) {
			const targets = FLY_MOD.WEIGHTS[preNeuron];
			if (!targets) return;

			for (const [postNeuron, weight] of Object.entries(targets)) {
				if (this.V[postNeuron]) {
					this.V[postNeuron][this.nextState] += weight;
				}
			}
		}

		/**
		 * Executes one simulation tick of the Drosophila connectome.
		 */
		tick() {
			const firedThisTick = new Set();
			const cur = this.thisState;
			const nxt = this.nextState;

			// 1. Evaluate threshold and fire spikes
			for (const n of FLY_MOD.ALL_NEURONS) {
				const potential = this.V[n][cur];

				if (potential >= this.fireThreshold) {
					// SPIKE!
					firedThisTick.add(n);

					// Synaptic propagation downstream
					this.dendriteAccumulate(n);

					// Accumulate into motor behavior channels
					switch (n) {
						case 'DN_GF':
							this.accumulators.startle += 18;
							this.accumulators.flight += 10;
							break;
						case 'MN_WING_L':
						case 'MN_WING_R':
							this.accumulators.flight += 4;
							break;
						case 'MN_LEG_L1':
						case 'MN_LEG_L2':
						case 'MN_LEG_L3':
							this.accumulators.walkLeft += 3;
							break;
						case 'MN_LEG_R1':
						case 'MN_LEG_R2':
						case 'MN_LEG_R3':
							this.accumulators.walkRight += 3;
							break;
						case 'MN_PROBOSCIS':
							this.accumulators.feed += 6;
							break;
						case 'MN_ABDOMEN':
						case 'SEZ_GROOM':
							this.accumulators.groom += 4;
							break;
					}

					// Reset potential after firing (refractory period)
					this.V[n][nxt] = 0;
				} else {
					// Leaky integration: potential decays exponentially
					this.V[n][nxt] = Math.round(potential * this.leakRate);
				}
			}

			// 2. Hebbian Synaptic Plasticity (Rojas Aliaga 2026: dW = eta*(r_i*r_j) - alpha*W)
			if (FLY_MOD.CONFIG.ENABLE_PLASTICITY && firedThisTick.size > 1) {
				this.applyPlasticity(firedThisTick);
			}

			// 3. Smoothly decay motor accumulators
			this.accumulators.startle = Math.max(0, Math.round(this.accumulators.startle * 0.82));
			this.accumulators.flight = Math.max(0, Math.round(this.accumulators.flight * 0.88));
			this.accumulators.walkLeft = Math.max(0, Math.round(this.accumulators.walkLeft * 0.85));
			this.accumulators.walkRight = Math.max(0, Math.round(this.accumulators.walkRight * 0.85));
			this.accumulators.feed = Math.max(0, Math.round(this.accumulators.feed * 0.84));
			this.accumulators.groom = Math.max(0, Math.round(this.accumulators.groom * 0.84));

			// 4. Swap double buffers
			this.thisState = nxt;
			this.nextState = cur;
			this.lastFired = firedThisTick;
		}

		/**
		 * Hebbian adaptation: neurons that fire together, wire together.
		 */
		applyPlasticity(spikingNeurons) {
			const eta = FLY_MOD.CONFIG.PLASTICITY_LEARNING_RATE;
			const alpha = FLY_MOD.CONFIG.PLASTICITY_DECAY;

			for (const pre of spikingNeurons) {
				const targets = FLY_MOD.WEIGHTS[pre];
				if (!targets) continue;

				for (const post of spikingNeurons) {
					if (targets[post] !== undefined) {
						// Strengthen active synapse, with slow weight decay
						targets[post] += eta - alpha * targets[post];
					}
				}
			}
		}
	}

	FLY_MOD.Connectome = new ConnectomeEngine();
})();
