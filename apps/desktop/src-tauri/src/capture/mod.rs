#[cfg(target_os = "macos")]
pub mod macos;
pub mod media;
pub mod nowplaying;
pub mod focus;
pub mod detection;
#[cfg(target_os = "linux")]
pub mod wayland;
pub mod windows;
#[cfg(not(target_os = "windows"))]
pub mod x11;
pub mod camera;
pub mod app_info;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct ScreenFramePayload {
    pub jpeg_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PixelFormat {
    Bgra,
    Rgba,
}

impl PixelFormat {
    /// GStreamer `video/x-raw` format name. The alpha channel carries no
    /// information for a screen capture, so the `x` variants let the encoder
    /// skip it entirely.
    pub fn gst_name(self) -> &'static str {
        match self {
            PixelFormat::Bgra => "BGRx",
            PixelFormat::Rgba => "RGBx",
        }
    }
}

/// One captured frame, tightly packed (no row padding).
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub data: Vec<u8>,
}

/// When a native encoder is attached, capture backends hand it raw frames
/// instead of JPEG-encoding them for the webview. The channel is bounded so a
/// slow encoder drops frames rather than growing an unbounded backlog of
/// multi-megabyte buffers.
static VIDEO_SINK: Mutex<Option<SyncSender<RawFrame>>> = Mutex::new(None);

pub fn set_video_sink(sink: SyncSender<RawFrame>) {
    if let Ok(mut guard) = VIDEO_SINK.lock() {
        *guard = Some(sink);
    }
}

pub fn clear_video_sink() {
    if let Ok(mut guard) = VIDEO_SINK.lock() {
        *guard = None;
    }
}

pub fn video_sink_active() -> bool {
    VIDEO_SINK.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Hands a frame to the native encoder. Returns false when no encoder is
/// attached, which tells the caller to fall back to the webview JPEG path.
pub fn publish_raw_frame(frame: RawFrame) -> bool {
    let Ok(guard) = VIDEO_SINK.lock() else {
        return false;
    };
    let Some(sink) = guard.as_ref() else {
        return false;
    };
    match sink.try_send(frame) {
        Ok(()) => true,
        // The encoder is behind: dropping this frame is correct for live video,
        // but the sink is still attached so the JPEG path must stay off.
        Err(TrySendError::Full(_)) => true,
        Err(TrySendError::Disconnected(_)) => false,
    }
}

#[derive(Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub struct CaptureSession {
    pub cancel: Arc<AtomicBool>,
    pub handle: Option<thread::JoinHandle<()>>,
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SessionType {
    X11,
    Wayland,
    Windows,
    MacOS,
}

pub fn detect_session_type() -> SessionType {
    #[cfg(target_os = "windows")]
    {
        return SessionType::Windows;
    }
    #[cfg(target_os = "macos")]
    {
        return SessionType::MacOS;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        let wayland_display = std::env::var("WAYLAND_DISPLAY").is_ok();
        if session == "wayland" || wayland_display {
            SessionType::Wayland
        } else {
            SessionType::X11
        }
    }
}
