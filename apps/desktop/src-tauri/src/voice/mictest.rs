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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::encode;

pub struct MicTestSession {
    cancel: Arc<AtomicBool>,
    /// Held so the capture stream stays alive for the session's lifetime;
    /// dropping it stops the device. `None` when capture runs via a subprocess.
    _stream: Option<cpal::Stream>,
}

impl MicTestSession {
    pub fn start(app: AppHandle, device_id: Option<String>, sample_rate: u32) -> Result<Self, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        let (pcm_tx, mut pcm_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();

        let stream = encode::start_native_audio_capture(
            device_id,
            sample_rate,
            1,
            pcm_tx,
            Arc::clone(&cancel),
        )?;

        let cancel_reader = Arc::clone(&cancel);
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = pcm_rx.recv().await {
                if cancel_reader.load(Ordering::Relaxed) {
                    break;
                }
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
        Ok(Self {
            cancel,
            _stream: stream,
        })
    }
}

impl Drop for MicTestSession {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        eprintln!("[MicTest] stopped");
    }
}
