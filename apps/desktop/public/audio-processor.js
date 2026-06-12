// AudioWorkletProcessor: Noise Gate + Spectral Suppression + Auto Gain for Kizuna
// Runs in the audio rendering thread for low-latency DSP.

class AudioProcessorWorklet extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gateEnabled', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'gateThresholdDb', defaultValue: -40, minValue: -80, maxValue: 0 },
      { name: 'suppressionEnabled', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'suppressionStrength', defaultValue: 0.7, minValue: 0, maxValue: 1 },
      { name: 'agcEnabled', defaultValue: 1, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.gateEnvelope = 0;
    this.gateHoldCounter = 0;
    this.gateHoldSamples = Math.round(0.2 * sampleRate); // 200ms hold
    this.gateAttackCoeff = Math.exp(-1 / (0.005 * sampleRate)); // 5ms
    this.gateReleaseCoeff = Math.exp(-1 / (0.120 * sampleRate)); // 120ms

    // Per-band state for spectral gate (4 bands)
    this.bandEnvelope = [0, 0, 0, 0];
    this.bandNoiseFloor = [0.001, 0.001, 0.001, 0.001];
    this.specAttackCoeff = Math.exp(-1 / (0.005 * sampleRate));
    this.specReleaseCoeff = Math.exp(-1 / (0.100 * sampleRate));
    this.noiseLearnCoeff = Math.exp(-1 / (1.5 * sampleRate));

    // Biquad filter states for band splitting
    this.bandFilters = this._createCrossoverFilters();

    // Auto gain control state
    this.agcGain = 1.0;
    this.agcTargetRms = Math.pow(10, -18 / 20); // -18dBFS
    this.agcMaxGain = Math.pow(10, 20 / 20); // +20dB
    this.agcMaxAtten = Math.pow(10, -20 / 20); // -20dB
    this.agcAttackCoeff = Math.exp(-1 / (0.050 * sampleRate)); // 50ms
    this.agcReleaseCoeff = Math.exp(-1 / (0.200 * sampleRate)); // 200ms
  }

  _createCrossoverFilters() {
    const sr = sampleRate;
    const crossovers = [500, 2000, 8000];
    const filters = [];

    for (let b = 0; b < 4; b++) {
      const low = b === 0 ? 0 : crossovers[b - 1];
      const high = b === 3 ? sr / 2 : crossovers[b];

      filters.push({
        hp: this._makeHighPass(sr, low),
        lp: this._makeLowPass(sr, high),
        hpZ1: 0, hpZ2: 0,
        lpZ1: 0, lpZ2: 0,
      });
    }
    return filters;
  }

  _makeLowPass(sr, cutoff) {
    if (cutoff >= sr / 2) return null; // no LP needed
    const w0 = 2 * Math.PI * cutoff / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / Math.SQRT2;
    const a0 = 1 + alpha;
    return {
      b0: ((1 - cosW0) / 2) / a0,
      b1: ((1 - cosW0)) / a0,
      b2: ((1 - cosW0) / 2) / a0,
      a1: (-2 * cosW0) / a0,
      a2: ((1 - alpha)) / a0,
    };
  }

  _makeHighPass(sr, cutoff) {
    if (cutoff <= 0) return null; // no HP needed
    const w0 = 2 * Math.PI * cutoff / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / Math.SQRT2;
    const a0 = 1 + alpha;
    return {
      b0: ((1 + cosW0) / 2) / a0,
      b1: (-(1 + cosW0)) / a0,
      b2: ((1 + cosW0) / 2) / a0,
      a1: (-2 * cosW0) / a0,
      a2: ((1 - alpha)) / a0,
    };
  }

  _processBiquad(filter, sample, z1, z2) {
    if (!filter) return [sample, z1, z2];
    const out = filter.b0 * sample + filter.b1 * z1 + filter.b2 * z2
      - filter.a1 * z1 - filter.a2 * z2;
    return [out, sample, z1];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0) return true;

    const gateEnabled = parameters.gateEnabled[0] > 0.5;
    const gateThreshold = Math.pow(10, parameters.gateThresholdDb[0] / 20);
    const suppressionEnabled = parameters.suppressionEnabled[0] > 0.5;
    const suppressionStrength = parameters.suppressionStrength[0];
    const agcEnabled = parameters.agcEnabled[0] > 0.5;

    const channelCount = Math.min(input.length, output.length);
    let agcRmsAccum = 0;
    let agcSampleCount = 0;

    for (let ch = 0; ch < channelCount; ch++) {
      const inData = input[ch];
      const outData = output[ch];
      if (!inData || !outData) continue;

      for (let i = 0; i < inData.length; i++) {
        let sample = inData[i];

        // ── Noise Gate ──
        if (gateEnabled) {
          const absSample = Math.abs(sample);
          const ratio = 8; // 8:1 expansion

          if (absSample > gateThreshold) {
            this.gateEnvelope = this.gateEnvelope * this.gateAttackCoeff + (1 - this.gateAttackCoeff);
            this.gateHoldCounter = this.gateHoldSamples;
          } else if (this.gateHoldCounter > 0) {
            this.gateHoldCounter--;
          } else {
            this.gateEnvelope *= this.gateReleaseCoeff;
          }

          const gain = this.gateEnvelope + (1 - this.gateEnvelope) / ratio;
          sample *= gain;
        }

        // ── Spectral Suppression ──
        if (suppressionEnabled && suppressionStrength > 0) {
          let outputSample = 0;

          for (let b = 0; b < 4; b++) {
            const f = this.bandFilters[b];
            let bandSample = sample;

            // Apply high-pass
            if (f.hp) {
              const [out, z1, z2] = this._processBiquad(f.hp, bandSample, f.hpZ1, f.hpZ2);
              bandSample = out;
              f.hpZ1 = z1;
              f.hpZ2 = z2;
            }

            // Apply low-pass
            if (f.lp) {
              const [out, z1, z2] = this._processBiquad(f.lp, bandSample, f.lpZ1, f.lpZ2);
              bandSample = out;
              f.lpZ1 = z1;
              f.lpZ2 = z2;
            }

            const absSig = Math.abs(bandSample);
            const coeff = absSig > this.bandEnvelope[b]
              ? this.specAttackCoeff : this.specReleaseCoeff;
            this.bandEnvelope[b] = this.bandEnvelope[b] * coeff + absSig * (1 - coeff);

            // Update noise floor
            if (this.bandEnvelope[b] < this.bandNoiseFloor[b]) {
              this.bandNoiseFloor[b] = this.bandEnvelope[b];
            } else {
              this.bandNoiseFloor[b] = this.bandNoiseFloor[b] * this.noiseLearnCoeff
                + this.bandEnvelope[b] * (1 - this.noiseLearnCoeff) * 0.1;
            }

            const noise = this.bandNoiseFloor[b];
            const threshold = noise * 2; // 6dB above noise floor
            let bandGain = 1;
            if (this.bandEnvelope[b] < threshold) {
              bandGain = Math.max(0.1, this.bandEnvelope[b] / (threshold + 1e-10));
            }

            const effectiveGain = 1 + (bandGain - 1) * suppressionStrength;
            outputSample += bandSample * effectiveGain;
          }

          sample = outputSample;
        }

        outData[i] = sample;

        // Accumulate for per-frame AGC
        if (agcEnabled) {
          agcRmsAccum += sample * sample;
          agcSampleCount++;
        }
      }
    }

    // ── Auto Gain Control (per-frame) ──
    if (agcEnabled && agcSampleCount > 0) {
      const rms = Math.sqrt(agcRmsAccum / agcSampleCount);
      const desiredGain = rms < 1e-10
        ? this.agcMaxGain
        : Math.max(this.agcMaxAtten, Math.min(this.agcMaxGain, this.agcTargetRms / rms));

      const coeff = desiredGain > this.agcGain
        ? this.agcAttackCoeff : this.agcReleaseCoeff;
      this.agcGain = this.agcGain * coeff + desiredGain * (1 - coeff);

      // Apply gain to all output samples
      for (let ch = 0; ch < channelCount; ch++) {
        const outData = output[ch];
        if (!outData) continue;
        for (let i = 0; i < outData.length; i++) {
          outData[i] *= this.agcGain;
        }
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessorWorklet);
