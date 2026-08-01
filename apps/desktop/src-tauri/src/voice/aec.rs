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
//
// Windows is the exception. webrtc-audio-processing-sys 2.1.0 cannot be built
// with MSVC: its build script passes GCC-only compiler flags, looks for `.a`
// archives, and prefixes symbols with rust-objcopy. The dependency is therefore
// excluded on Windows (see Cargo.toml) and the stub at the bottom of this file
// takes over. Every call site already treats a `None` from `global()` as "no
// echo cancellation available", which is what Windows had before AEC3 landed.

#[cfg(not(windows))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(windows))]
use std::sync::OnceLock;

#[cfg(not(windows))]
use webrtc_audio_processing::{
    config::{Config, EchoCanceller as EchoCancellerConfig, HighPassFilter},
    Processor,
};

/// AEC3 works on 10ms frames; the voice pipeline works on 20ms frames.
#[cfg(not(windows))]
const AEC_FRAME_SAMPLES: usize = 480;

#[cfg(not(windows))]
pub struct EchoCanceller {
    processor: Processor,
    enabled: AtomicBool,
}

#[cfg(not(windows))]
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

#[cfg(not(windows))]
static AEC: OnceLock<Option<EchoCanceller>> = OnceLock::new();

/// The process-wide echo canceller, or `None` if AEC3 could not be initialised.
///
/// One instance is kept for the life of the process rather than per call: AEC3
/// takes a moment to converge on the room's impulse response, and rebuilding it
/// on every join would throw that away.
#[cfg(not(windows))]
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

#[cfg(not(windows))]
pub fn set_enabled(enabled: bool) {
    if let Some(aec) = global() {
        aec.set_enabled(enabled);
        eprintln!("[AEC] enabled={enabled}");
    }
}

// ── Windows stub ──────────────────────────────────────────────────────────
//
// Mirrors the API above so the call sites need no cfg of their own. `global()`
// returning `None` is already the "AEC3 unavailable" path they handle, so voice
// on Windows behaves exactly as it did before AEC3 was introduced. The methods
// are unreachable while `global()` is `None`, but they have to exist for the
// call sites to type-check.

#[cfg(windows)]
pub struct EchoCanceller {
    _private: (),
}

#[cfg(windows)]
#[allow(dead_code)]
impl EchoCanceller {
    pub fn set_enabled(&self, _enabled: bool) {}

    pub fn is_enabled(&self) -> bool {
        false
    }

    pub fn process_render(&self, _frame: &[f32]) {}

    pub fn process_capture(&self, _frame: &mut [f32]) {}
}

#[cfg(windows)]
pub fn global() -> Option<&'static EchoCanceller> {
    None
}

#[cfg(windows)]
pub fn set_enabled(_enabled: bool) {}
