//! Standalone microphone level monitor for the voice settings panel.
//!
//! The settings "test microphone" button needs a level meter without a call in
//! progress. It runs the same capture path a call uses — including the
//! parec/PipeWire handling in `encode::start_native_audio_capture` — so what the
//! meter shows is what peers would hear, not what a different code path happens
//! to pick up.
//!
//! Levels are emitted as a single pre-computed RMS value rather than raw
//! samples: at 48kHz the frames arrive ~50x/sec, and shipping them over IPC as a
//! JSON number array costs far more than the one float the meter draws.

use tauri::{AppHandle, Emitter};

use super::encode;

pub struct MicTestSession {
    /// Owns the microphone for the session's lifetime. Dropping it closes the
    /// CPAL stream, or kills and reaps the parec subprocess.
    _capture: encode::CaptureHandle,
}

impl MicTestSession {
    pub fn start(app: AppHandle, device_id: Option<String>, sample_rate: u32) -> Result<Self, String> {
        let (pcm_tx, mut pcm_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();

        let capture = encode::start_native_audio_capture(device_id, sample_rate, pcm_tx)?;

        // Ends by itself once the capture is dropped: that drops the sender,
        // and `recv` then returns `None`.
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = pcm_rx.recv().await {
                if frame.is_empty() {
                    continue;
                }
                let sum_sq: f32 = frame.iter().map(|s| s * s).sum();
                let rms = (sum_sq / frame.len() as f32).sqrt();
                if app.emit("mic:level", rms).is_err() {
                    break;
                }
            }
        });

        eprintln!("[MicTest] started");
        Ok(Self { _capture: capture })
    }
}

impl Drop for MicTestSession {
    fn drop(&mut self) {
        eprintln!("[MicTest] stopped");
    }
}
