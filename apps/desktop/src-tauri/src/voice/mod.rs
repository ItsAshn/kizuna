mod signaling;
pub mod transport;
pub mod encode;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::mpsc;

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

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct VoiceState {
    pub state: String,
    pub channel_id: Option<String>,
    pub muted: bool,
}

enum VoiceCommand {
    Join {
        channel_id: String,
    },
    Leave,
    SetMuted {
        muted: bool,
    },
    #[allow(dead_code)]
    SetVolume {
        volume: f32,
    },
}

pub struct VoiceSession {
    command_tx: mpsc::Sender<VoiceCommand>,
    muted: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

impl VoiceSession {
    pub fn new(
        app: AppHandle,
        server_url: String,
        auth_token: String,
        user_id: String,
        username: String,
    ) -> Self {
        // Ensure OpenSSL can find CA certificates on Linux.
        // This is critical for TLS connections to work in AppImage builds.
        let _ = openssl_probe::probe();

        let (command_tx, command_rx) = mpsc::channel(32);
        let muted = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));

        let muted_clone = muted.clone();
        let cancel_clone = cancel.clone();

        tauri::async_runtime::spawn(async move {
            signaling::run_signaling_loop(
                app,
                server_url,
                auth_token,
                user_id,
                username,
                command_rx,
                muted_clone,
                cancel_clone,
            )
            .await;
        });

        Self {
            command_tx,
            muted,
            cancel,
        }
    }

    pub async fn join(&self, channel_id: String) {
        let _ = self
            .command_tx
            .send(VoiceCommand::Join { channel_id })
            .await;
    }

    pub async fn leave(&self) {
        let _ = self.command_tx.send(VoiceCommand::Leave).await;
    }

    pub async fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
        let _ = self
            .command_tx
            .send(VoiceCommand::SetMuted { muted })
            .await;
    }

    #[allow(dead_code)]
    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }
}

impl Drop for VoiceSession {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}
