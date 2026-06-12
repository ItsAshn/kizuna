// Noise gate and spectral noise suppression — pure Rust, no external crates.

const PI: f32 = std::f32::consts::PI;

// ─── Noise Gate ───────────────────────────────────────────────────────────

pub struct NoiseGate {
    threshold: f32,
    attack_coeff: f32,
    release_coeff: f32,
    hold_samples: usize,
    ratio: f32,
    envelope: f32,
    hold_counter: usize,
    sample_rate: u32,
}

impl NoiseGate {
    pub fn new(
        sample_rate: u32,
        threshold_db: f32,
        attack_ms: f32,
        release_ms: f32,
        hold_ms: f32,
        ratio: f32,
    ) -> Self {
        let threshold = 10.0_f32.powf(threshold_db / 20.0);
        let attack_coeff = (-1.0 / (attack_ms / 1000.0 * sample_rate as f32)).exp();
        let release_coeff = (-1.0 / (release_ms / 1000.0 * sample_rate as f32)).exp();
        let hold_samples = (hold_ms / 1000.0 * sample_rate as f32).round() as usize;
        Self {
            threshold,
            attack_coeff,
            release_coeff,
            hold_samples,
            ratio,
            envelope: 0.0,
            hold_counter: 0,
            sample_rate,
        }
    }

    pub fn set_threshold_db(&mut self, threshold_db: f32) {
        self.threshold = 10.0_f32.powf(threshold_db / 20.0);
    }

    pub fn set_attack_ms(&mut self, attack_ms: f32) {
        self.attack_coeff =
            (-1.0 / (attack_ms / 1000.0 * self.sample_rate as f32)).exp();
    }

    pub fn set_release_ms(&mut self, release_ms: f32) {
        self.release_coeff =
            (-1.0 / (release_ms / 1000.0 * self.sample_rate as f32)).exp();
    }

    pub fn set_hold_ms(&mut self, hold_ms: f32) {
        self.hold_samples = (hold_ms / 1000.0 * self.sample_rate as f32).round() as usize;
    }

    pub fn set_ratio(&mut self, ratio: f32) {
        self.ratio = ratio;
    }

    pub fn reset(&mut self) {
        self.envelope = 0.0;
        self.hold_counter = 0;
    }

    /// Process a single sample through the soft noise gate.
    /// Returns the gated sample.
    pub fn process_sample(&mut self, sample: f32) -> f32 {
        let abs_sample = sample.abs();

        if abs_sample > self.threshold {
            // Attack: push envelope toward 1.0
            self.envelope = self.envelope * self.attack_coeff + (1.0 - self.attack_coeff) * 1.0;
            self.hold_counter = self.hold_samples;
        } else if self.hold_counter > 0 {
            self.hold_counter -= 1;
            // Hold: keep envelope where it is
        } else {
            // Release: pull envelope toward 0.0
            self.envelope = self.envelope * self.release_coeff;
        }

        // Soft gate: envelope drives gain. Below full open, apply expansion.
        // gain = envelope + (1 - envelope) / ratio
        // When envelope = 1.0: gain = 1.0 (pass through)
        // When envelope = 0.0: gain = 1/ratio (floor, e.g., 0.2 for 5:1)
        let gain = self.envelope + (1.0 - self.envelope) / self.ratio;
        sample * gain
    }

    /// Process a frame of samples in-place.
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        for sample in frame.iter_mut() {
            *sample = self.process_sample(*sample);
        }
    }
}

// ─── Biquad Filter ────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Design a 2nd-order low-pass Butterworth filter.
    fn low_pass(sample_rate: f32, cutoff: f32) -> Self {
        let w0 = 2.0 * PI * cutoff / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0_f32.sqrt());

        let b0 = (1.0 - cos_w0) / 2.0;
        let b1 = 1.0 - cos_w0;
        let b2 = (1.0 - cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;

        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Design a 2nd-order high-pass Butterworth filter.
    fn high_pass(sample_rate: f32, cutoff: f32) -> Self {
        let w0 = 2.0 * PI * cutoff / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0_f32.sqrt());

        let b0 = (1.0 + cos_w0) / 2.0;
        let b1 = -(1.0 + cos_w0);
        let b2 = (1.0 + cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;

        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let out = self.b0 * sample + self.b1 * self.z1 + self.b2 * self.z2
            - self.a1 * self.z1 - self.a2 * self.z2;
        self.z2 = self.z1;
        self.z1 = sample;
        out
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

// ─── Spectral Noise Suppression (4-band expander) ─────────────────────────

const NUM_BANDS: usize = 4;
// Crossover frequencies in Hz
const CROSSOVER: [f32; NUM_BANDS + 1] = [0.0, 500.0, 2000.0, 8000.0, 20000.0];

pub struct SpectralGate {
    enabled: bool,
    sample_rate: u32,
    // Per-band processor chain: LP + HP cascade = band-pass
    lp_filters: [Biquad; NUM_BANDS],
    hp_filters: [Biquad; NUM_BANDS],
    // Per-band state
    band_envelope: [f32; NUM_BANDS],
    band_noise_floor: [f32; NUM_BANDS],
    attack_coeff: f32,
    release_coeff: f32,
    noise_learning_coeff: f32,
    strength: f32, // 0.0 = off, 1.0 = max
}

impl SpectralGate {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate as f32;

        // Build crossover chain for 4 bands
        let mut lp_filters = [Biquad::new(); NUM_BANDS];
        let mut hp_filters = [Biquad::new(); NUM_BANDS];

        for i in 0..NUM_BANDS {
            let low = CROSSOVER[i];
            let high = CROSSOVER[i + 1];

            if low > 0.0 {
                hp_filters[i] = Biquad::high_pass(sr, low);
            }
            if high < sr / 2.0 {
                lp_filters[i] = Biquad::low_pass(sr, high);
            }
        }

        // Band 0 (lowest) doesn't need high-pass
        // Band 3 (highest) doesn't need low-pass if high >= Nyquist

        let attack_coeff = (-1.0 / (0.005 * sr)).exp(); // 5ms attack
        let release_coeff = (-1.0 / (0.100 * sr)).exp(); // 100ms release
        let noise_learning_coeff = (-1.0 / (1.5 * sr)).exp(); // 1.5s noise floor learning

        Self {
            enabled: false,
            sample_rate,
            lp_filters,
            hp_filters,
            band_envelope: [0.0; NUM_BANDS],
            band_noise_floor: [0.001; NUM_BANDS], // Small initial floor
            attack_coeff,
            release_coeff,
            noise_learning_coeff,
            strength: 0.7,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            self.reset();
        }
        self.enabled = enabled;
    }

    pub fn set_strength(&mut self, strength: f32) {
        self.strength = strength.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        for i in 0..NUM_BANDS {
            self.lp_filters[i].reset();
            self.hp_filters[i].reset();
            self.band_envelope[i] = 0.0;
        }
    }

    /// Process a frame of samples in-place through the spectral gate.
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        if !self.enabled || self.strength <= 0.0 {
            return;
        }

        // For each sample, split into bands and process
        for sample in frame.iter_mut() {
            let input = *sample;

            // Split into bands
            let mut band_signals = [0.0f32; NUM_BANDS];
            for b in 0..NUM_BANDS {
                let mut sig = input;

                // Apply high-pass if this band has one
                // For band 0, CROSSOVER[0] = 0, so no high-pass needed
                let low = CROSSOVER[b];
                let high = CROSSOVER[b + 1];

                if low > 0.0 {
                    sig = self.hp_filters[b].process(sig);
                }
                if high < self.sample_rate as f32 / 2.0 {
                    sig = self.lp_filters[b].process(sig);
                }

                band_signals[b] = sig;
            }

            // Per-band noise suppression
            let mut output = 0.0f32;
            for b in 0..NUM_BANDS {
                let band_sig = band_signals[b];
                let abs_sig = band_sig.abs();

                // Smooth envelope follower
                let coeff = if abs_sig > self.band_envelope[b] {
                    self.attack_coeff
                } else {
                    self.release_coeff
                };
                self.band_envelope[b] =
                    self.band_envelope[b] * coeff + abs_sig * (1.0 - coeff);

                // Update noise floor estimate (slowly track minima)
                if self.band_envelope[b] < self.band_noise_floor[b] {
                    self.band_noise_floor[b] = self.band_envelope[b];
                } else {
                    self.band_noise_floor[b] = self.band_noise_floor[b]
                        * self.noise_learning_coeff
                        + self.band_envelope[b] * (1.0 - self.noise_learning_coeff)
                        * 0.1; // Slow upward drift
                }

                // Compute gain: suppress when signal is near noise floor
                let noise = self.band_noise_floor[b];
                let threshold = noise * 2.0; // 6dB above noise floor
                let gain = if self.band_envelope[b] > threshold {
                    1.0
                } else {
                    let ratio = self.band_envelope[b] / threshold.max(1e-10);
                    ratio.max(0.1) // At least -20dB floor
                };

                // Blend based on strength
                let effective_gain = 1.0 + (gain - 1.0) * self.strength;
                output += band_sig * effective_gain;
            }

            *sample = output;
        }
    }
}

// ─── Auto Gain Control (leveler) ──────────────────────────────────────────

pub struct AutoGain {
    enabled: bool,
    target_rms: f32,       // Target RMS level (linear, e.g., 0.25 = -12dB)
    max_gain: f32,         // Maximum boost (e.g., 2.0 = +6dB)
    max_attenuation: f32,  // Maximum cut (e.g., 0.25 = -12dB)
    attack_coeff: f32,
    release_coeff: f32,
    current_gain: f32,
    sample_rate: u32,
}

impl AutoGain {
    pub fn new(sample_rate: u32) -> Self {
        let target_db = -12.0;
        let target_rms = 10.0_f32.powf(target_db / 20.0);
        let attack_coeff = (-1.0 / (0.100 * sample_rate as f32)).exp(); // 100ms
        let release_coeff = (-1.0 / (0.500 * sample_rate as f32)).exp(); // 500ms
        Self {
            enabled: false,
            target_rms,
            max_gain: 10.0_f32.powf(6.0 / 20.0), // +6dB
            max_attenuation: 10.0_f32.powf(-12.0 / 20.0), // -12dB
            attack_coeff,
            release_coeff,
            current_gain: 1.0,
            sample_rate,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            self.current_gain = 1.0;
        }
        self.enabled = enabled;
    }

    pub fn reset(&mut self) {
        self.current_gain = 1.0;
    }

    /// Process a frame through the auto gain control.
    /// Measures RMS of the frame, computes target gain, smooths with attack/release.
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        if !self.enabled || frame.is_empty() {
            return;
        }

        // Compute RMS of this frame
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();

        // Compute desired gain: target_rms / actual_rms, clamped
        let desired_gain = if rms < 1e-10 {
            self.max_gain // No signal, apply max boost (will just amplify noise floor)
        } else {
            (self.target_rms / rms).clamp(self.max_attenuation, self.max_gain)
        };

        // Smooth gain changes
        let coeff = if desired_gain > self.current_gain {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.current_gain = self.current_gain * coeff + desired_gain * (1.0 - coeff);

        // Apply gain to all samples
        for sample in frame.iter_mut() {
            *sample *= self.current_gain;
        }
    }
}

// ─── Combined DSP Pipeline ────────────────────────────────────────────────

pub struct AudioProcessor {
    pub noise_gate: NoiseGate,
    pub spectral_gate: SpectralGate,
    pub auto_gain: AutoGain,
    gate_enabled: bool,
    suppression_enabled: bool,
    agc_enabled: bool,
    sample_rate: u32,
    dc_state: f32,
}

impl AudioProcessor {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            noise_gate: NoiseGate::new(sample_rate, -40.0, 5.0, 120.0, 200.0, 8.0),
            spectral_gate: SpectralGate::new(sample_rate),
            auto_gain: AutoGain::new(sample_rate),
            gate_enabled: true,
            suppression_enabled: false,
            agc_enabled: true,
            sample_rate,
            dc_state: 0.0,
        }
    }

    pub fn set_gate_enabled(&mut self, enabled: bool) {
        self.gate_enabled = enabled;
        if !enabled {
            self.noise_gate.reset();
        }
    }

    pub fn set_suppression_enabled(&mut self, enabled: bool) {
        self.suppression_enabled = enabled;
        self.spectral_gate.set_enabled(enabled);
    }

    pub fn set_agc_enabled(&mut self, enabled: bool) {
        self.agc_enabled = enabled;
        self.auto_gain.set_enabled(enabled);
    }

    pub fn set_gate_threshold_db(&mut self, threshold_db: f32) {
        self.noise_gate.set_threshold_db(threshold_db);
    }

    pub fn set_suppression_strength(&mut self, strength: f32) {
        self.spectral_gate.set_strength(strength);
    }

    pub fn reset(&mut self) {
        self.noise_gate.reset();
        self.spectral_gate.reset();
        self.auto_gain.reset();
        self.dc_state = 0.0;
    }

    /// Process a frame through the full DSP chain.
    /// Order: DC-removal HPF → noise_gate → spectral suppression → auto gain control.
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        // DC-removal high-pass filter at ~80Hz (single-pole)
        let alpha = (-2.0 * PI * 80.0 / self.sample_rate as f32).exp();
        for sample in frame.iter_mut() {
            let out = *sample - self.dc_state;
            self.dc_state = self.dc_state + alpha * out;
            *sample = out;
        }

        if self.gate_enabled {
            self.noise_gate.process_frame(frame);
        }
        if self.suppression_enabled {
            self.spectral_gate.process_frame(frame);
        }
        if self.agc_enabled {
            self.auto_gain.process_frame(frame);
        }
    }
}
