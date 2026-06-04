use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, EncodableLayout, ExtendedColorType, ImageEncoder};
use serde::Serialize;
use tauri::Emitter;
use xcap::Monitor;

const MAX_DIMENSION: u32 = 1920;
const JPEG_QUALITY: u8 = 75;
const CAPTURE_INTERVAL_MS: u32 = 33;

#[derive(Clone, Serialize)]
pub struct ScreenFramePayload {
    pub jpeg_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub struct CaptureSession {
    cancel: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let name = m.name().map_err(|e| format!("Failed to get monitor name: {e}"))?;
            let width = m.width().map_err(|e| format!("Failed to get monitor width: {e}"))?;
            let height = m
                .height()
                .map_err(|e| format!("Failed to get monitor height: {e}"))?;
            Ok(MonitorInfo {
                index: i,
                name,
                width,
                height,
            })
        })
        .collect()
}

pub fn start_capture(
    app: tauri::AppHandle,
    monitor_index: usize,
    fps: u32,
) -> Result<CaptureSession, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;

    if monitor_index >= monitors.len() {
        return Err(format!(
            "Monitor index {monitor_index} out of range (0..{})",
            monitors.len()
        ));
    }

    drop(monitors);

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();
    let interval_ms: u32 = if fps > 0 { 1000 / fps } else { CAPTURE_INTERVAL_MS };

    let handle = thread::spawn(move || {
        let period = Duration::from_millis(interval_ms as u64);

        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[ScreenCapture] failed to enumerate monitors: {e}");
                return;
            }
        };
        let monitor = match monitors.into_iter().nth(monitor_index) {
            Some(m) => m,
            None => {
                eprintln!("[ScreenCapture] monitor {monitor_index} no longer available");
                return;
            }
        };

        loop {
            if cancel_clone.load(Ordering::Relaxed) {
                break;
            }

            let start = std::time::Instant::now();

            match capture_and_encode(&monitor) {
                Ok(payload) => {
                    let _ = app.emit("screen:frame", payload);
                }
                Err(e) => {
                    eprintln!("[ScreenCapture] frame error: {e}");
                }
            }

            let elapsed = start.elapsed();
            if elapsed < period {
                thread::sleep(period - elapsed);
            }
        }
    });

    Ok(CaptureSession {
        cancel,
        handle: Some(handle),
    })
}

fn capture_and_encode(monitor: &Monitor) -> Result<ScreenFramePayload, String> {
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Capture failed: {e}"))?;

    let mut img = DynamicImage::ImageRgba8(image);

    let (w, h) = (img.width(), img.height());
    if w > MAX_DIMENSION || h > MAX_DIMENSION {
        let ratio = MAX_DIMENSION as f64 / w.max(h) as f64;
        let new_w = (w as f64 * ratio) as u32;
        let new_h = (h as f64 * ratio) as u32;
        img = img.resize(new_w, new_h, FilterType::Lanczos3);
    }

    let rgb = img.to_rgb8();
    let final_w = rgb.width();
    let final_h = rgb.height();

    let mut jpeg_bytes = Vec::new();
    {
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, JPEG_QUALITY);
        encoder
            .write_image(rgb.as_bytes(), final_w, final_h, ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encode failed: {e}"))?;
    }

    use base64::{engine::general_purpose, Engine as _};
    let jpeg_base64 = general_purpose::STANDARD.encode(&jpeg_bytes);

    Ok(ScreenFramePayload {
        jpeg_base64,
        width: final_w,
        height: final_h,
    })
}

impl CaptureSession {
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}
