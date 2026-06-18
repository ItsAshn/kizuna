//! macOS screen capture.
//!
//! Uses the cross-platform `xcap` backend (ScreenCaptureKit / Core Graphics under
//! the hood on macOS), sharing the implementation with the X11 path. Requires the
//! user to grant Screen Recording permission (System Settings > Privacy & Security).
pub use super::x11::{list_monitors, start_capture};
