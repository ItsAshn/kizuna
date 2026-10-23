use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{PixelFormat, RawFrame, VideoSource};

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

/// Emitted as `camera:error` when the camera cannot be opened or stops
/// delivering frames, so the page can turn the camera off and say why
/// instead of showing a frozen or black tile.
#[derive(Clone, Serialize)]
pub struct CameraErrorPayload {
    pub message: String,
}

/// While frames go to the native encoder, the JPEG preview for the local
/// self-view only needs to be smooth enough to see yourself: every Nth frame.
const PREVIEW_EVERY_N_FRAMES_WHEN_ENCODING: u32 = 3;

/// How long `start_camera` waits for the device to open before giving up.
const OPEN_TIMEOUT: Duration = Duration::from_secs(8);

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

impl Drop for CameraSession {
    fn drop(&mut self) {
        self.stop();
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

/// Opens the camera on its own thread and starts delivering frames. Returns
/// once the device is streaming, or with the reason it could not be opened
/// (which is also emitted as `camera:error`).
///
/// Frames go to the native encoder when one is attached for
/// [`VideoSource::Camera`] (Linux), with a reduced-rate JPEG preview for the
/// self-view; otherwise every frame goes to the webview as JPEG.
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
    let (opened_tx, opened_rx) = mpsc::channel::<Result<(), String>>();

    let handle = thread::Builder::new()
        .name("camera-capture".into())
        .spawn(move || {
            camera_loop(
                app,
                camera_index_u32,
                width.max(2),
                height.max(2),
                fps.max(1),
                cancel_clone,
                opened_tx,
            );
        })
        .map_err(|e| format!("Failed to spawn camera thread: {e}"))?;

    let mut session = CameraSession {
        cancel,
        handle: Some(handle),
    };
    match opened_rx.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(())) => Ok(session),
        Ok(Err(e)) => {
            session.stop();
            Err(e)
        }
        Err(_) => {
            session.stop();
            Err("The camera did not start in time".into())
        }
    }
}

/// nokhwa reads the device's current format before applying the requested one
/// and gives up ("Could not get device property FrameFormat: unsupported") when
/// that format is a pixel format it does not know, such as the UYVY an Elgato
/// Facecam starts in after boot. Switching such a device to MJPEG (or YUYV)
/// first lets nokhwa open it and then negotiate as usual.
#[cfg(target_os = "linux")]
fn ensure_known_v4l_format(camera_index: u32) {
    use v4l::video::Capture;
    use v4l::FourCC;

    const KNOWN: [&[u8; 4]; 5] = [b"YUYV", b"MJPG", b"GRAY", b"RGB3", b"NV12"];

    let Ok(device) = v4l::Device::new(camera_index as usize) else {
        return;
    };
    let Ok(mut format) = device.format() else {
        return;
    };
    if KNOWN.iter().any(|k| FourCC::new(k) == format.fourcc) {
        return;
    }
    let offered: Vec<FourCC> = device
        .enum_formats()
        .map(|formats| formats.into_iter().map(|f| f.fourcc).collect())
        .unwrap_or_default();
    let Some(target) = [b"MJPG", b"YUYV"]
        .into_iter()
        .map(FourCC::new)
        .find(|f| offered.contains(f))
    else {
        return;
    };
    let previous = format.fourcc;
    format.fourcc = target;
    match device.set_format(&format) {
        Ok(_) => eprintln!("[Camera] switched camera {camera_index} from {previous} to {target}"),
        Err(e) => eprintln!("[Camera] could not switch camera {camera_index} to {target}: {e}"),
    }
}

fn emit_error(app: &AppHandle, message: String) {
    eprintln!("[Camera] {message}");
    let _ = app.emit("camera:error", CameraErrorPayload { message });
}

fn camera_loop(
    app: AppHandle,
    camera_index: u32,
    width: u32,
    height: u32,
    fps: u32,
    cancel: Arc<AtomicBool>,
    opened: mpsc::Sender<Result<(), String>>,
) {
    let fail_open = |message: String| {
        emit_error(&app, message.clone());
        let _ = opened.send(Err(message));
    };

    #[cfg(target_os = "linux")]
    ensure_known_v4l_format(camera_index);

    let requested = nokhwa::utils::RequestedFormat::new::<nokhwa::pixel_format::RgbFormat>(
        nokhwa::utils::RequestedFormatType::AbsoluteHighestFrameRate,
    );

    let mut camera =
        match nokhwa::Camera::new(nokhwa::utils::CameraIndex::Index(camera_index), requested) {
            Ok(c) => c,
            Err(e) => {
                fail_open(format!("Could not open camera {camera_index}: {e}"));
                return;
            }
        };

    if let Err(e) = camera.open_stream() {
        fail_open(format!("Could not start the camera stream: {e}"));
        return;
    }

    let stream_resolution = camera.resolution();
    eprintln!(
        "[Camera] opened camera {camera_index} at {}x{}",
        stream_resolution.width(),
        stream_resolution.height()
    );
    let _ = opened.send(Ok(()));

    let target_frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
    let mut consecutive_errors: u32 = 0;
    let max_errors: u32 = 30;
    let mut frame_no: u32 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let frame_start = Instant::now();

        let rgb_frame = match camera.frame() {
            Ok(f) => f,
            Err(e) => {
                consecutive_errors += 1;
                eprintln!("[Camera] frame error ({consecutive_errors}/{max_errors}): {e}");
                if consecutive_errors >= max_errors {
                    emit_error(&app, format!("The camera stopped delivering frames: {e}"));
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
                    emit_error(&app, format!("The camera's frames could not be decoded: {e}"));
                    break;
                }
                continue;
            }
        };

        consecutive_errors = 0;
        frame_no = frame_no.wrapping_add(1);

        let boxed = letterbox(&decoded, width, height);

        let encoding = super::video_sink_active_for(VideoSource::Camera);
        if encoding {
            super::publish_raw_frame_for(
                VideoSource::Camera,
                RawFrame {
                    width,
                    height,
                    format: PixelFormat::Rgb,
                    data: boxed.as_raw().clone(),
                },
            );
        }

        if !encoding || frame_no.is_multiple_of(PREVIEW_EVERY_N_FRAMES_WHEN_ENCODING) {
            let mut jpeg_buf = Vec::new();
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buf, 75);
            match encoder.encode_image(&boxed) {
                Ok(()) => {
                    let payload = CameraFramePayload {
                        jpeg_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg_buf),
                        width,
                        height,
                    };
                    if let Err(e) = app.emit("camera:frame", payload) {
                        eprintln!("[Camera] emit error: {e}");
                    }
                }
                Err(e) => eprintln!("[Camera] JPEG encode error: {e}"),
            }
        }

        let elapsed = frame_start.elapsed();
        if elapsed < target_frame_interval {
            thread::sleep(target_frame_interval - elapsed);
        }
    }

    let _ = camera.stop_stream();
    eprintln!("[Camera] capture loop ended");
}

/// Scales `src` to fit inside `width`x`height` without distorting it, centred
/// on black. (`resize_exact` used to squash a 16:9 webcam into 4:3.)
pub fn letterbox(src: &image::RgbImage, width: u32, height: u32) -> image::RgbImage {
    let (sw, sh) = src.dimensions();
    if sw == width && sh == height {
        return src.clone();
    }
    let mut out = image::RgbImage::new(width, height);
    if sw == 0 || sh == 0 {
        return out;
    }
    let scale = (width as f64 / sw as f64).min(height as f64 / sh as f64);
    let fw = ((sw as f64 * scale).round() as u32).clamp(1, width);
    let fh = ((sh as f64 * scale).round() as u32).clamp(1, height);
    let fitted = image::imageops::resize(src, fw, fh, image::imageops::FilterType::Triangle);
    let x = ((width - fw) / 2) as i64;
    let y = ((height - fh) / 2) as i64;
    image::imageops::overlay(&mut out, &fitted, x, y);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_keeps_aspect_and_centres() {
        // 16:9 white into 4:3: bars top and bottom, full width.
        let src = image::RgbImage::from_pixel(160, 90, image::Rgb([255, 255, 255]));
        let out = letterbox(&src, 640, 480);
        assert_eq!(out.dimensions(), (640, 480));
        // 160x90 scaled by 4 is 640x360, leaving 60px bars.
        assert_eq!(out.get_pixel(320, 10), &image::Rgb([0, 0, 0]));
        assert_eq!(out.get_pixel(320, 470), &image::Rgb([0, 0, 0]));
        assert_eq!(out.get_pixel(320, 240), &image::Rgb([255, 255, 255]));
        assert_eq!(out.get_pixel(1, 240), &image::Rgb([255, 255, 255]));
        assert_eq!(out.get_pixel(320, 61), &image::Rgb([255, 255, 255]));

        // Same aspect: a plain resize.
        let src = image::RgbImage::from_pixel(320, 240, image::Rgb([9, 9, 9]));
        let out = letterbox(&src, 640, 480);
        assert_eq!(out.get_pixel(0, 0), &image::Rgb([9, 9, 9]));
    }
}
