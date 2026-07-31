// Acoustic echo cancellation (WebRTC AEC3).
//
// The native voice path never touches the webview's WebRTC stack, so it also
// never got the audio processing module that comes with it. Without echo
// cancellation, anyone not wearing headphones sends the other participants'
// voices back to them.
//
// AEC needs two streams: the *render* signal (what we are about to play) and the
// *capture* signal (what the microphone hears, which contains an echo of the
// render signal). We own both in-process — the render signal is exactly the mix
// that voice/output.rs hands to the sink — so no OS-level loopback is required.
//
// The two streams are fed from different threads (output thread and the audio
// send task). That is the access pattern WebRTC's AudioProcessing is built for:
// it locks the render and capture paths separately.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use webrtc_audio_processing::{
    config::{Config, EchoCanceller as EchoCancellerConfig, HighPassFilter},
    Processor,
};

/// AEC3 works on 10ms frames; the voice pipeline works on 20ms frames.
const AEC_FRAME_SAMPLES: usize = 480;

pub struct EchoCanceller {
    processor: Processor,
    enabled: AtomicBool,
}

impl EchoCanceller {
    fn new() -> Result<Self, String> {
        let processor =
            Processor::new(48000).map_err(|e| format!("AEC3 init failed: {e:?}"))?;

        // Only the echo canceller is enabled here. Noise suppression, gain
        // control and gating are already handled by voice/dsp.rs, which is what
        // the user-facing voice settings drive — turning on WebRTC's versions
        // too would double up on processing the user did not ask for.
        //
        // The high-pass filter is the one exception: AEC3 is documented as
        // strongly preferring it, and it overlaps harmlessly with the DC blocker
        // in dsp.rs (both are removing sub-voice-band energy).
        processor.set_config(Config {
            echo_canceller: Some(EchoCancellerConfig::Full {
                // Let AEC3 estimate the render-to-capture delay itself. It is
                // genuinely variable here — it depends on the sink's buffering
                // plus the capture path — and a wrong fixed hint is worse than
                // none, because it disables the internal estimator.
                stream_delay_ms: None,
            }),
            high_pass_filter: Some(HighPassFilter::default()),
            ..Default::default()
        });

        Ok(Self {
            processor,
            enabled: AtomicBool::new(true),
        })
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Feed the signal about to be played out. Analyze-only: this must not alter
    /// what the user actually hears.
    ///
    /// Call this once per output tick even when the mix is silent. AEC3 aligns
    /// the render and capture streams by their arrival cadence, so skipping
    /// render frames during silence would smear its delay estimate.
    pub fn process_render(&self, frame: &[f32]) {
        if !self.is_enabled() {
            return;
        }
        for chunk in frame.chunks_exact(AEC_FRAME_SAMPLES) {
            if let Err(e) = self.processor.analyze_render_frame([chunk]) {
                eprintln!("[AEC] render frame rejected: {e:?}");
                return;
            }
        }
    }

    /// Remove the echo of the render signal from a captured frame, in place.
    pub fn process_capture(&self, frame: &mut [f32]) {
        if !self.is_enabled() {
            return;
        }
        for chunk in frame.chunks_exact_mut(AEC_FRAME_SAMPLES) {
            if let Err(e) = self.processor.process_capture_frame([chunk]) {
                eprintln!("[AEC] capture frame rejected: {e:?}");
                return;
            }
        }
    }
}

static AEC: OnceLock<Option<EchoCanceller>> = OnceLock::new();

/// The process-wide echo canceller, or `None` if AEC3 could not be initialised.
///
/// One instance is kept for the life of the process rather than per call: AEC3
/// takes a moment to converge on the room's impulse response, and rebuilding it
/// on every join would throw that away.
pub fn global() -> Option<&'static EchoCanceller> {
    AEC.get_or_init(|| match EchoCanceller::new() {
        Ok(a) => {
            eprintln!("[AEC] AEC3 initialised");
            Some(a)
        }
        Err(e) => {
            eprintln!("[AEC] disabled: {e}");
            None
        }
    })
    .as_ref()
}

pub fn set_enabled(enabled: bool) {
    if let Some(aec) = global() {
        aec.set_enabled(enabled);
        eprintln!("[AEC] enabled={enabled}");
    }
}
