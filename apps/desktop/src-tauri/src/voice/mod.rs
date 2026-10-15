#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod signaling;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod transport;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod encode;
// Screenshare is encoded natively only on Linux, where the WebKitGTK webview
// has no WebRTC stack to encode it for us.
#[cfg(target_os = "linux")]
pub mod video;
pub mod dsp;
pub mod rnnoise;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod jitter;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod resample;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod aec;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod device;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod output;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod mictest;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use signaling::{JoinTransportParams, VoiceController};

use serde::Serialize;

/// Screenshare starting bitrate. The loss-based controller in voice/video.rs
/// moves it between [`VIDEO_MIN_BITRATE_BPS`] and
/// [`SCREEN_SHARE_MAX_BITRATE_BPS`]; the maximum is what the video producer's
/// RTP parameters declare to the server.
pub const SCREEN_SHARE_BITRATE_BPS: u32 = 2_500_000;
pub const SCREEN_SHARE_MAX_BITRATE_BPS: u32 = 4_000_000;
/// Camera starting and maximum bitrate.
pub const CAMERA_BITRATE_BPS: u32 = 500_000;
pub const CAMERA_MAX_BITRATE_BPS: u32 = 600_000;
/// Floor for the loss-based controller, for both sources.
pub const VIDEO_MIN_BITRATE_BPS: u32 = 300_000;

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct IceServer {
    pub urls: String,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum VoiceEvent {
    State {
        state: String,
        error: Option<String>,
    },
    PeerJoined {
        peer_id: String,
        user_id: String,
        username: String,
    },
    PeerLeft {
        peer_id: String,
    },
    PeerSpeaking {
        peer_id: String,
        speaking: bool,
    },
    ScreenShareStarted {
        peer_id: String,
        user_id: String,
        username: String,
    },
    ScreenShareStopped {
        peer_id: String,
    },
}
