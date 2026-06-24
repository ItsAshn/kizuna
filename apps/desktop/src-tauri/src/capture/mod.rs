#[cfg(target_os = "macos")]
pub mod macos;
pub mod media;
pub mod focus;
#[cfg(target_os = "linux")]
pub mod wayland;
pub mod windows;
#[cfg(not(target_os = "windows"))]
pub mod x11;
pub mod camera;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use serde::Serialize;

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
