// Small sample-format helpers shared by the capture and playback paths.
//
// The voice pipeline is fixed at 48 kHz mono (Opus, AEC3 and the jitter buffer
// all assume it), but audio devices are not: a USB headset may only offer
// 44.1 kHz, and most outputs are stereo. Opening a device at its own format and
// converting here is what keeps pitch and speed right on those devices.
//
// Linear interpolation is used rather than a windowed-sinc resampler (rubato).
// Voice is band-limited well below either Nyquist, the converter has no
// latency, and it carries its fractional phase across blocks, so it can be fed
// whatever block sizes a device callback delivers. The small high-frequency
// roll-off it adds is inaudible next to Opus at voice bitrates.

/// Streaming linear-interpolation resampler for a single (mono) channel.
pub struct LinearResampler {
    /// Input samples advanced per output sample (`in_rate / out_rate`).
    step: f64,
    /// Read position of the next output sample, relative to `prev` at 0.0.
    pos: f64,
    /// Last input sample of the previous block.
    prev: f32,
    passthrough: bool,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        Self {
            step: in_rate as f64 / out_rate as f64,
            // Start one input sample in so the first output lands on the first
            // real sample rather than interpolating up from silence.
            pos: 1.0,
            prev: 0.0,
            passthrough: in_rate == out_rate,
        }
    }

    /// Resample `input`, appending the result to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }
        if input.is_empty() {
            return;
        }
        let n = input.len();
        // Virtual sequence: index 0 is `prev`, index k (1..=n) is input[k-1].
        let at = |k: usize, prev: f32| if k == 0 { prev } else { input[k - 1] };
        while self.pos < n as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = at(i, self.prev);
            let b = at(i + 1, self.prev);
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= n as f64;
        self.prev = input[n - 1];
    }
}

/// Average interleaved frames down to mono, appending to `out`.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let scale = 1.0 / channels as f32;
    for frame in interleaved.chunks_exact(channels) {
        out.push(frame.iter().sum::<f32>() * scale);
    }
}

/// Collects arbitrarily sized blocks and hands out fixed-size frames.
pub struct Rechunker {
    frame: usize,
    buf: Vec<f32>,
}

impl Rechunker {
    pub fn new(frame: usize) -> Self {
        Self {
            frame: frame.max(1),
            buf: Vec::with_capacity(frame * 2),
        }
    }

    /// Append `samples` and call `emit` once per complete frame. Stops early,
    /// returning `false`, when `emit` does (the consumer has gone away).
    pub fn push(&mut self, samples: &[f32], mut emit: impl FnMut(Vec<f32>) -> bool) -> bool {
        self.buf.extend_from_slice(samples);
        while self.buf.len() >= self.frame {
            let rest = self.buf.split_off(self.frame);
            let frame = std::mem::replace(&mut self.buf, rest);
            if !emit(frame) {
                return false;
            }
        }
        true
    }
}

/// Nudge a block's length by `delta` samples (+1 adds one, -1 removes one) at
/// the point where it is least audible, for clock-drift correction. Two
/// neighbouring samples are merged into their mean, or a mean is inserted
/// between them, so the waveform never steps.
pub fn nudge_length(block: &mut Vec<f32>, delta: i32) {
    if block.len() < 4 || delta == 0 {
        return;
    }
    // The quietest adjacent pair hides the edit best.
    let mut best = 1;
    let mut best_level = f32::MAX;
    for i in 1..block.len() - 1 {
        let level = block[i].abs() + block[i + 1].abs();
        if level < best_level {
            best_level = level;
            best = i;
        }
    }
    let mean = 0.5 * (block[best] + block[best + 1]);
    if delta > 0 {
        block.insert(best + 1, mean);
    } else {
        block[best] = mean;
        block.remove(best + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn passthrough_when_rates_match() {
        let mut r = LinearResampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn converts_44k1_to_48k_at_the_right_rate_across_odd_blocks() {
        let mut r = LinearResampler::new(44_100, 48_000);
        let input = sine(44_100, 440.0, 44_100);
        let mut out = Vec::new();
        // Device callbacks deliver ragged block sizes; phase must carry over.
        for chunk in input.chunks(441 + 7) {
            r.process(chunk, &mut out);
        }
        let expected = 48_000i64;
        assert!(
            (out.len() as i64 - expected).abs() <= 2,
            "one second in must be one second out, got {}",
            out.len()
        );
        // Same tone at the new rate: compare against a reference 440 Hz sine
        // (skipping the first sample, which interpolates from silence).
        let reference = sine(48_000, 440.0, out.len());
        let max_err = out[10..]
            .iter()
            .zip(&reference[10..])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_err < 0.02, "pitch must be preserved (err={max_err})");
    }

    #[test]
    fn converts_48k_down_to_44k1() {
        let mut r = LinearResampler::new(48_000, 44_100);
        let input = sine(48_000, 300.0, 48_000);
        let mut out = Vec::new();
        for chunk in input.chunks(960) {
            r.process(chunk, &mut out);
        }
        assert!((out.len() as i64 - 44_100).abs() <= 2);
    }

    #[test]
    fn downmixes_stereo_by_averaging() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn rechunks_into_fixed_frames() {
        let mut c = Rechunker::new(4);
        let mut frames = Vec::new();
        c.push(&[1.0, 2.0, 3.0], |f| {
            frames.push(f);
            true
        });
        assert!(frames.is_empty());
        c.push(&[4.0, 5.0, 6.0, 7.0, 8.0, 9.0], |f| {
            frames.push(f);
            true
        });
        assert_eq!(
            frames,
            vec![vec![1.0, 2.0, 3.0, 4.0], vec![5.0, 6.0, 7.0, 8.0]]
        );
    }

    #[test]
    fn nudges_length_without_stepping() {
        let mut block = sine(48_000, 200.0, 480);
        let orig = block.clone();
        nudge_length(&mut block, 1);
        assert_eq!(block.len(), 481);
        nudge_length(&mut block, -1);
        nudge_length(&mut block, -1);
        assert_eq!(block.len(), 479);
        let max_jump = block
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        let orig_jump = orig
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_jump <= orig_jump * 2.0 + 1e-6);
    }
}
