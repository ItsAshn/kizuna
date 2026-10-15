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
    /// 4 bytes per pixel; the 4th byte is ignored.
    Bgra,
    /// 4 bytes per pixel; the 4th byte is ignored.
    Rgba,
    /// 3 bytes per pixel (webcams).
    Rgb,
}

impl PixelFormat {
    /// GStreamer `video/x-raw` format name. The alpha channel carries no
    /// information for a screen capture, so the `x` variants let the encoder
    /// skip it entirely.
    pub fn gst_name(self) -> &'static str {
        match self {
            PixelFormat::Bgra => "BGRx",
            PixelFormat::Rgba => "RGBx",
            PixelFormat::Rgb => "RGB",
        }
    }

    pub fn bytes_per_pixel(self) -> usize {
        match self {
            PixelFormat::Bgra | PixelFormat::Rgba => 4,
            PixelFormat::Rgb => 3,
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
static VIDEO_SINKS: Mutex<[Option<SyncSender<RawFrame>>; 2]> = Mutex::new([None, None]);

/// Which outgoing video a frame belongs to. Each has its own native encoder
/// and its own RTP stream on the send transport.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum VideoSource {
    Screen,
    Camera,
}

impl VideoSource {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoSource::Screen => "screen",
            VideoSource::Camera => "camera",
        }
    }

    fn slot(self) -> usize {
        match self {
            VideoSource::Screen => 0,
            VideoSource::Camera => 1,
        }
    }
}

pub fn set_video_sink(source: VideoSource, sink: SyncSender<RawFrame>) {
    if let Ok(mut guard) = VIDEO_SINKS.lock() {
        guard[source.slot()] = Some(sink);
    }
}

pub fn clear_video_sink(source: VideoSource) {
    if let Ok(mut guard) = VIDEO_SINKS.lock() {
        guard[source.slot()] = None;
    }
}

pub fn video_sink_active_for(source: VideoSource) -> bool {
    VIDEO_SINKS
        .lock()
        .map(|g| g[source.slot()].is_some())
        .unwrap_or(false)
}

/// Hands a frame to the native encoder for `source`. Returns false when no
/// encoder is attached, which tells the caller to fall back to the webview
/// JPEG path.
pub fn publish_raw_frame_for(source: VideoSource, frame: RawFrame) -> bool {
    let Ok(guard) = VIDEO_SINKS.lock() else {
        return false;
    };
    let Some(sink) = guard[source.slot()].as_ref() else {
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

/// Whether screen frames go to the native encoder (screen capture backends).
pub fn video_sink_active() -> bool {
    video_sink_active_for(VideoSource::Screen)
}

/// Hands a screen frame to the native encoder (screen capture backends).
pub fn publish_raw_frame(frame: RawFrame) -> bool {
    publish_raw_frame_for(VideoSource::Screen, frame)
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
