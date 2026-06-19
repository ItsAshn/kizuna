use nnnoiseless::DenoiseState;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseSuppressionMode {
    Off,
    Spectral,
    Rnnoise,
}

pub struct RnnoiseSuppressor {
    state: Box<DenoiseState<'static>>,
    enabled: bool,
    strength: f32,
}

impl RnnoiseSuppressor {
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            enabled: false,
            strength: 1.0,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn set_strength(&mut self, strength: f32) {
        self.strength = strength.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        self.state = DenoiseState::new();
    }

    /// Process a frame of samples (must be at 48kHz).
    /// RNNoise internally works on 480-sample (10ms) frames.
    /// This method processes each 480-sample chunk independently.
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        if !self.enabled || frame.is_empty() {
            return;
        }

        // nnnoiseless follows the original RNNoise convention: samples are f32 but
        // scaled to the i16 range (±32768), NOT normalized [-1, 1]. Feeding raw
        // normalized audio makes its VAD treat everything as silence. Scale in/out.
        const SCALE: f32 = 32768.0;
        for chunk in frame.chunks_exact_mut(480) {
            let input: Vec<f32> = chunk.iter().map(|s| s * SCALE).collect();
            let mut output = [0.0f32; 480];
            self.state.process_frame(&mut output, &input);

            if self.strength >= 0.999 {
                for (c, &o) in chunk.iter_mut().zip(output.iter()) {
                    *c = o / SCALE;
                }
            } else {
                for (c, (&o, &s)) in chunk.iter_mut().zip(output.iter().zip(input.iter())) {
                    *c = (o * self.strength + s * (1.0 - self.strength)) / SCALE;
                }
            }
        }
    }
}
