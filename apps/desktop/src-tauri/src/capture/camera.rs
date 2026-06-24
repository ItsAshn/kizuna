use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct CameraDevice {
    pub index: usize,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct CameraFramePayload {
    pub jpeg_base64: String,
    pub width: u32,
    pub height: u32,
}

pub struct CameraSession {
    pub cancel: Arc<AtomicBool>,
    pub handle: Option<thread::JoinHandle<()>>,
}

impl CameraSession {
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn list_cameras() -> Result<Vec<CameraDevice>, String> {
    let found = nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .map_err(|e| format!("Failed to query cameras: {e}"))?;

    Ok(found
        .into_iter()
        .enumerate()
        .map(|(i, info)| CameraDevice {
            index: i,
            name: format!("{} ({})", info.human_name(), info.description()),
        })
        .collect())
}

pub fn start_camera(
    app: AppHandle,
    camera_index: usize,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<CameraSession, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();
    let camera_index_u32 = camera_index as u32;

    let handle = thread::Builder::new()
        .name("camera-capture".into())
        .spawn(move || {
            camera_loop(app, camera_index_u32, width, height, fps, cancel_clone);
        })
        .map_err(|e| format!("Failed to spawn camera thread: {e}"))?;

    Ok(CameraSession {
        cancel,
        handle: Some(handle),
    })
}

fn camera_loop(
    app: AppHandle,
    camera_index: u32,
    width: u32,
    height: u32,
    fps: u32,
    cancel: Arc<AtomicBool>,
) {
    let requested =
        nokhwa::utils::RequestedFormat::new::<nokhwa::pixel_format::RgbFormat>(
            nokhwa::utils::RequestedFormatType::AbsoluteHighestFrameRate,
        );

    let mut camera = match nokhwa::Camera::new(
        nokhwa::utils::CameraIndex::Index(camera_index),
        requested,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Camera] failed to open camera {camera_index}: {e}");
            return;
        }
    };

    if let Err(e) = camera.open_stream() {
        eprintln!("[Camera] failed to start stream: {e}");
        return;
    }

    let stream_resolution = camera.resolution();
    eprintln!(
        "[Camera] opened camera {camera_index} at {}x{}",
        stream_resolution.width(),
        stream_resolution.height()
    );

    let target_frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
    let mut consecutive_errors: u32 = 0;
    let max_errors: u32 = 30;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let frame_start = Instant::now();

        let rgb_frame = match camera.frame() {
            Ok(f) => f,
            Err(e) => {
                consecutive_errors += 1;
                eprintln!(
                    "[Camera] frame error ({consecutive_errors}/{max_errors}): {e}"
                );
                if consecutive_errors >= max_errors {
                    eprintln!("[Camera] too many errors, stopping");
                    break;
                }
                continue;
            }
        };

        let decoded = match rgb_frame.decode_image::<nokhwa::pixel_format::RgbFormat>() {
            Ok(img) => img,
            Err(e) => {
                consecutive_errors += 1;
                eprintln!("[Camera] decode error: {e}");
                if consecutive_errors >= max_errors {
                    break;
                }
                continue;
            }
        };

        consecutive_errors = 0;

        let dynamic = image::DynamicImage::ImageRgb8(decoded);
        let resize = dynamic.resize_exact(
            width,
            height,
            image::imageops::FilterType::Nearest,
        );

        let mut jpeg_buf = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buf, 75);
        if let Err(e) = encoder.encode_image(&resize) {
            eprintln!("[Camera] JPEG encode error: {e}");
            continue;
        }

        let jpeg_base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);

        let payload = CameraFramePayload {
            jpeg_base64,
            width,
            height,
        };

        if let Err(e) = app.emit("camera:frame", payload) {
            eprintln!("[Camera] emit error: {e}");
        }

        let elapsed = frame_start.elapsed();
        if elapsed < target_frame_interval {
            thread::sleep(target_frame_interval - elapsed);
        }
    }

    let _ = camera.stop_stream();
    eprintln!("[Camera] capture loop ended");
}
