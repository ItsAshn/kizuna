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

        for chunk in frame.chunks_exact_mut(480) {
            let input = chunk.to_vec();
            let mut output = [0.0f32; 480];
            self.state.process_frame(&mut output, &input);

            if self.strength >= 0.999 {
                chunk.copy_from_slice(&output);
            } else {
                for (o, (c, &s)) in output.iter().zip(chunk.iter_mut().zip(input.iter())) {
                    *c = o * self.strength + s * (1.0 - self.strength);
                }
            }
        }
    }
}
