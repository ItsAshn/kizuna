#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod signaling;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod transport;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod encode;
pub mod dsp;
pub mod rnnoise;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod device;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod output;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use signaling::VoiceController;

use serde::Serialize;

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
