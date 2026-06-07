use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::encode::{self, AudioSendSession};
use super::transport;
use super::VoiceEvent;

pub struct ActiveCall {
    pub channel_id: String,
    pub send_pc: webrtc::peer_connection::RTCPeerConnection,
    pub recv_pc: webrtc::peer_connection::RTCPeerConnection,
    pub pending_recv: Arc<tokio::sync::Mutex<Vec<String>>>,
    pub router_caps: Value,
    pub voice_bitrate_kbps: u64,
    pub audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_send: Option<AudioSendSession>,
}

impl Drop for ActiveCall {
    fn drop(&mut self) {
        if let Some(ref mut s) = self.audio_send {
            s.stop();
        }
        tokio::task::block_in_place(|| {
            tauri::async_runtime::block_on(async {
                let _ = self.send_pc.close().await;
                let _ = self.recv_pc.close().await;
            });
        });
    }
}

pub struct VoiceController {
    app: AppHandle,
    user_id: String,
    username: String,
    active_call: Option<ActiveCall>,
    signal_tx: tokio::sync::mpsc::UnboundedSender<(String, Value)>,
    signal_rx: tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
}

impl VoiceController {
    pub fn new(app: AppHandle, user_id: String, username: String) -> Self {
        let _ = openssl_probe::probe();
        let (signal_tx, signal_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            app,
            user_id,
            username,
            active_call: None,
            signal_tx,
            signal_rx,
        }
    }

    pub fn signal_sender(&self) -> tokio::sync::mpsc::UnboundedSender<(String, Value)> {
        self.signal_tx.clone()
    }

    pub async fn drain_signals(&mut self) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        while let Ok((event, data)) = self.signal_rx.try_recv() {
            out.push((event, data));
        }
        out
    }

    pub fn emit_state(&self, state: &str, error: Option<&str>) {
        eprintln!("[VoiceNative] emit_state: state={state} error={error:?}");
        let _ = self.app.emit(
            "voice:event",
            VoiceEvent::State {
                state: state.to_string(),
                error: error.map(|s| s.to_string()),
            },
        );
    }

    pub fn leave(&mut self) {
        if let Some(mut call) = self.active_call.take() {
            eprintln!("[VoiceNative] leaving channel={}", call.channel_id);
            if let Some(ref mut s) = call.audio_send {
                s.stop();
            }
            let _ = self.signal_tx.send(("voice:signal_out".to_string(), json!({
                "event": "voice:leave",
                "data": { "channelId": call.channel_id },
            })));
            drop(call);
        }
        self.emit_state("disconnected", None);
    }

    /// Called after TypeScript has obtained transport params from the server.
    /// Returns DTLS params (send_dtls, recv_dtls) and RTP parameters for produce.
    pub async fn begin_join(
        &mut self,
        channel_id: &str,
        ice_servers: Vec<Value>,
        send_params: Value,
        recv_params: Value,
    ) -> Result<(Value, Value, Value), String> {
        eprintln!("[VoiceNative] begin_join channel={channel_id}");

        let (transport_pair, send_dtls, recv_dtls) =
            transport::create_transports(
                self.app.clone(),
                &ice_servers,
                &send_params,
                &recv_params,
            )
            .await
            .map_err(|e| {
                eprintln!("[VoiceNative] begin_join: transport setup failed: {e}");
                format!("Transport setup: {e}")
            })?;

        let rtp_sender = transport_pair.audio_sender.clone();
        let params = rtp_sender.get_parameters().await;
        let ssrc = params.encodings.first().map(|e| e.ssrc).unwrap_or(1);

        let rtp_params = json!({
            "ssrc": ssrc,
            "codecs": [{
                "mimeType": "audio/opus",
                "clockRate": 48000,
                "channels": 1,
                "parameters": {
                    "useinbandfec": 1,
                    "minptime": 10,
                },
                "rtcpFeedback": [],
            }],
            "headerExtensions": [],
            "encodings": [{
                "ssrc": ssrc,
                "dtx": true,
                "maxBitrate": 64000,
            }],
            "rtcp": {
                "cname": "",
                "reducedSize": true,
            },
        });

        self.active_call = Some(ActiveCall {
            channel_id: channel_id.to_string(),
            send_pc: transport_pair.send_pc,
            recv_pc: transport_pair.recv_pc,
            pending_recv: transport_pair.pending_recv,
            router_caps: json!({
                "codecs": [{
                    "mimeType": "audio/opus",
                    "clockRate": 48000,
                    "channels": 2,
                    "parameters": { "useinbandfec": 1, "minptime": 10 },
                    "rtcpFeedback": []
                }],
                "headerExtensions": []
            }),
            voice_bitrate_kbps: 64,
            audio_track: Some(transport_pair.audio_track),
            audio_send: None,
        });

        eprintln!("[VoiceNative] begin_join OK: ssrc={ssrc}");
        Ok((send_dtls, recv_dtls, rtp_params))
    }

    /// Called after TypeScript has sent connectTransport + produce successfully.
    /// Starts audio capture and encoding.
    pub async fn finish_join(&mut self, voice_bitrate_kbps: u64) -> Result<(), String> {
        let call = self.active_call.as_mut().ok_or("No active call")?;
        let audio_track = call.audio_track.take().ok_or("No audio track")?;

        eprintln!("[VoiceNative] finish_join bitrate={voice_bitrate_kbps}kbps");

        let encoder = encode::AudioEncoder::new(48000, 1)
            .map_err(|e| format!("Opus encoder: {e}"))?;

        let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();
        let (speaking_tx, mut speaking_rx) = mpsc::unbounded_channel::<bool>();

        let cancel = Arc::new(AtomicBool::new(false));
        let stream = encode::start_native_audio_capture(
            None, 48000, 1, pcm_tx, cancel.clone(),
        )?;

        let audio_send = AudioSendSession::new(
            encoder,
            audio_track,
            pcm_rx,
            stream,
            speaking_tx,
        );

        // Relay speaking state changes to TypeScript via Tauri event
        let app = self.app.clone();
        let channel_id = call.channel_id.clone();
        tokio::spawn(async move {
            while let Some(speaking) = speaking_rx.recv().await {
                let _ = app.emit("voice:speaking", json!({
                    "channelId": channel_id,
                    "speaking": speaking,
                }));
            }
        });

        call.voice_bitrate_kbps = voice_bitrate_kbps;
        call.audio_send = Some(audio_send);

        self.emit_state("active", None);
        eprintln!("[VoiceNative] finish_join OK");
        Ok(())
    }

    /// Called after TypeScript has successfully consumed a peer.
    pub async fn add_remote_peer(&self, peer_id: &str) {
        if let Some(ref call) = self.active_call {
            call.pending_recv.lock().await.push(peer_id.to_string());
            eprintln!("[VoiceNative] add_remote_peer: {peer_id}");
        }
    }
}
