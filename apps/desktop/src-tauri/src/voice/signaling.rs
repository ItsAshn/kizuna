use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::FutureExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use rust_socketio::asynchronous::{ClientBuilder, Client as SocketClient};
use rust_socketio::Payload;

use super::encode::{self, AudioSendSession};
use super::transport;
use super::{VoiceCommand, VoiceEvent};

struct ActiveCall {
    channel_id: String,
    send_pc: webrtc::peer_connection::RTCPeerConnection,
    recv_pc: webrtc::peer_connection::RTCPeerConnection,
    audio_send: Option<AudioSendSession>,
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

pub async fn run_signaling_loop(
    app: AppHandle,
    server_url: String,
    auth_token: String,
    user_id: String,
    username: String,
    mut command_rx: mpsc::Receiver<VoiceCommand>,
    muted: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) {
    let mut active_call: Option<ActiveCall> = None;
    let mut recv_pending: Option<Arc<tokio::sync::Mutex<Vec<String>>>> = None;
    let mut current_channel: Option<String> = None;
    let mut router_caps: Option<Value> = None;

    'outer: loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let app_clone = app.clone();
        let (peer_tx, mut peer_rx) =
            tokio::sync::mpsc::unbounded_channel::<(String, String, String)>();

        let on_new_peer = {
            let app = app.clone();
            let peer_tx = peer_tx.clone();
            move |payload: Payload, _socket: SocketClient| {
                let app = app.clone();
                let peer_tx = peer_tx.clone();
                async move {
                    if let Payload::Text(values) = payload {
                        if let Some(data) = values.first() {
                            let peer_id = data
                                .get("peerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let uid = data
                                .get("userId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let uname = data
                                .get("username")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let _ = peer_tx.send((peer_id.clone(), uid.clone(), uname.clone()));
                            let _ = app.emit(
                                "voice:event",
                                VoiceEvent::PeerJoined {
                                    peer_id,
                                    user_id: uid,
                                    username: uname,
                                },
                            );
                        }
                    }
                }
                .boxed()
            }
        };

        let on_peer_left = {
            let app = app.clone();
            move |payload: Payload, _socket: SocketClient| {
                let app = app.clone();
                async move {
                    if let Payload::Text(values) = payload {
                        if let Some(data) = values.first() {
                            let peer_id = data
                                .get("peerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let _ = app.emit("voice:event", VoiceEvent::PeerLeft { peer_id });
                        }
                    }
                }
                .boxed()
            }
        };

        let on_screen_start = {
            let app = app.clone();
            move |payload: Payload, _socket: SocketClient| {
                let app = app.clone();
                async move {
                    if let Payload::Text(values) = payload {
                        if let Some(data) = values.first() {
                            let peer_id = data
                                .get("peerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let uid = data
                                .get("userId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let uname = data
                                .get("username")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let _ = app.emit(
                                "voice:event",
                                VoiceEvent::ScreenShareStarted {
                                    peer_id,
                                    user_id: uid,
                                    username: uname,
                                },
                            );
                        }
                    }
                }
                .boxed()
            }
        };

        let on_screen_stop = {
            let app = app.clone();
            move |payload: Payload, _socket: SocketClient| {
                let app = app.clone();
                async move {
                    if let Payload::Text(values) = payload {
                        if let Some(data) = values.first() {
                            let peer_id = data
                                .get("peerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let _ =
                                app.emit("voice:event", VoiceEvent::ScreenShareStopped { peer_id });
                        }
                    }
                }
                .boxed()
            }
        };

        let on_speaking = {
            let app = app.clone();
            move |payload: Payload, _socket: SocketClient| {
                let app = app.clone();
                async move {
                    if let Payload::Text(values) = payload {
                        if let Some(data) = values.first() {
                            let peer_id = data
                                .get("peerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let speaking =
                                data.get("speaking").and_then(|v| v.as_bool()).unwrap_or(false);
                            let _ = app.emit(
                                "voice:event",
                                VoiceEvent::PeerSpeaking { peer_id, speaking },
                            );
                        }
                    }
                }
                .boxed()
            }
        };

        let builder = ClientBuilder::new(server_url.clone())
            .namespace("/")
            .auth(json!({ "token": auth_token }))
            .on("voice:newPeer", on_new_peer)
            .on("voice:peerLeft", on_peer_left)
            .on("screen:peerStarted", on_screen_start)
            .on("screen:peerStopped", on_screen_stop)
            .on("voice:peerSpeaking", on_speaking);

        let socket = match builder.connect().await {
            Ok(s) => s,
            Err(e) => {
                let _ = app_clone.emit(
                    "voice:event",
                    VoiceEvent::State {
                        state: "disconnected".into(),
                        error: Some(format!("Connection failed: {e}")),
                    },
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let _ = app_clone.emit(
            "voice:event",
            VoiceEvent::State {
                state: "connected".into(),
                error: None,
            },
        );

        loop {
            tokio::select! {
                cmd = command_rx.recv() => {
                    match cmd {
                        Some(VoiceCommand::Join { channel_id: cid }) => {
                            handle_join(
                                &app_clone,
                                &socket,
                                &cid,
                                &user_id,
                                &username,
                                &muted,
                                &mut active_call,
                                &mut recv_pending,
                                &mut current_channel,
                                &mut router_caps,
                            )
                            .await;
                        }
                        Some(VoiceCommand::Leave) => {
                            if let Some(call) = active_call.take() {
                                let cid = call.channel_id.clone();
                                let _ = socket.emit("voice:leave", json!({ "channelId": cid })).await;
                                drop(call);
                            }
                            let _ = app_clone.emit(
                                "voice:event",
                                VoiceEvent::State {
                                    state: "disconnected".into(),
                                    error: None,
                                },
                            );
                            break;
                        }
                        Some(VoiceCommand::SetMuted { muted: m }) => {
                            if active_call.is_some() {
                                let _ = socket.emit("voice:mute", json!({ "muted": m })).await;
                            }
                        }
                        Some(VoiceCommand::SetVolume { .. }) => {}
                        None => {
                            break 'outer;
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if cancel.load(Ordering::Relaxed) {
                        break 'outer;
                    }
                }
                peer = peer_rx.recv() => {
                    if let Some((peer_id, _uid, _uname)) = peer {
                        if let (Some(ref channel), Some(ref pending), Some(ref caps)) =
                            (&current_channel, &recv_pending, &router_caps)
                        {
                            consume_peer(&socket, channel, &peer_id, pending, caps).await;
                        }
                    }
                }
            }
        }

        if let Some(call) = active_call.take() {
            let cid = call.channel_id.clone();
            let _ = socket.emit("voice:leave", json!({ "channelId": cid })).await;
            drop(call);
        }
        let _ = socket.disconnect().await;
    }
}

fn emit_state(app: &AppHandle, state: &str, error: Option<&str>) {
    let _ = app.emit(
        "voice:event",
        VoiceEvent::State {
            state: state.to_string(),
            error: error.map(|s| s.to_string()),
        },
    );
}

async fn ack_emit(
    socket: &SocketClient,
    event: &str,
    data: Value,
) -> Result<Payload, String> {
    let (tx, mut rx) = mpsc::channel::<Payload>(1);
    let _ = socket
        .emit_with_ack(
            event,
            data,
            Duration::from_secs(10),
            move |payload: Payload, _client: SocketClient| {
                let tx = tx.clone();
                Box::pin(async move {
                    let _ = tx.send(payload).await;
                })
            },
        )
        .await;
    rx.recv().await.ok_or_else(|| "No ack received".to_string())
}

async fn handle_join(
    app: &AppHandle,
    socket: &SocketClient,
    channel_id: &str,
    user_id: &str,
    username: &str,
    _muted: &Arc<AtomicBool>,
    active_call: &mut Option<ActiveCall>,
    recv_pending: &mut Option<Arc<tokio::sync::Mutex<Vec<String>>>>,
    current_channel: &mut Option<String>,
    router_caps: &mut Option<Value>,
) {
    if active_call.is_some() {
        emit_state(app, "failed", Some("Already in a voice channel"));
        return;
    }

    let join_payload = json!({
        "channelId": channel_id,
        "userId": user_id,
        "username": username,
    });

    let ack = match ack_emit(socket, "voice:join", join_payload).await {
        Ok(p) => p,
        Err(e) => {
            emit_state(app, "failed", Some(&e));
            return;
        }
    };

    let ack_data = match &ack {
        Payload::Text(values) => values.first(),
        _ => None,
    };

    let ice_servers: Vec<Value> = ack_data
        .and_then(|d| d.get("iceServers"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(data) = ack_data {
        if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
            emit_state(app, "failed", Some(err));
            return;
        }
    }

    let router_rtp_capabilities: Value = ack_data
        .and_then(|d| d.get("routerRtpCapabilities"))
        .cloned()
        .unwrap_or(json!({
            "codecs": [{
                "mimeType": "audio/opus",
                "clockRate": 48000,
                "channels": 2,
                "parameters": { "useinbandfec": 1, "minptime": 10 },
                "rtcpFeedback": []
            }],
            "headerExtensions": []
        }));

    let voice_bitrate_kbps: u64 = ack_data
        .and_then(|d| d.get("voiceBitrateKbps"))
        .and_then(|v| v.as_u64())
        .unwrap_or(64);

    let _ = app.emit(
        "voice:event",
        VoiceEvent::State {
            state: "joined".into(),
            error: None,
        },
    );

    if let Some(data) = ack_data {
        emit_existing_peers(app, data);
    }

    let send_params = match ack_emit(
        socket,
        "voice:createTransport",
        json!({ "channelId": channel_id, "direction": "send" }),
    )
    .await
    {
        Ok(Payload::Text(values)) => values.into_iter().next().unwrap_or(json!({})),
        _ => {
            emit_state(app, "failed", Some("Failed to create send transport"));
            let _ = socket
                .emit("voice:leave", json!({ "channelId": channel_id }))
                .await;
            return;
        }
    };

    if send_params.get("error").is_some() {
        emit_state(app, "failed", Some("Send transport error"));
        let _ = socket
            .emit("voice:leave", json!({ "channelId": channel_id }))
            .await;
        return;
    }

    let recv_params = match ack_emit(
        socket,
        "voice:createTransport",
        json!({ "channelId": channel_id, "direction": "recv" }),
    )
    .await
    {
        Ok(Payload::Text(values)) => values.into_iter().next().unwrap_or(json!({})),
        _ => {
            emit_state(app, "failed", Some("Failed to create recv transport"));
            let _ = socket
                .emit("voice:leave", json!({ "channelId": channel_id }))
                .await;
            return;
        }
    };

    if recv_params.get("error").is_some() {
        emit_state(app, "failed", Some("Recv transport error"));
        let _ = socket
            .emit("voice:leave", json!({ "channelId": channel_id }))
            .await;
        return;
    }

    let (transport_pair, send_dtls, recv_dtls) = match transport::create_transports(
        app.clone(),
        &ice_servers,
        &send_params,
        &recv_params,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            emit_state(app, "failed", Some(&format!("Transport setup: {e}")));
            let _ = socket
                .emit("voice:leave", json!({ "channelId": channel_id }))
                .await;
            return;
        }
    };

    let send_transport_id = send_params
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let _ = ack_emit(
        socket,
        "voice:connectTransport",
        json!({
            "channelId": channel_id,
            "transportId": send_transport_id,
            "dtlsParameters": send_dtls,
        }),
    )
    .await;

    let recv_transport_id = recv_params
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let _ = ack_emit(
        socket,
        "voice:connectTransport",
        json!({
            "channelId": channel_id,
            "transportId": recv_transport_id,
            "dtlsParameters": recv_dtls,
        }),
    )
    .await;

    let rtp_sender = transport_pair.audio_sender.clone();
    let params = rtp_sender.get_parameters().await;
    let ssrc = params
        .encodings
        .first()
        .map(|e| e.ssrc)
        .unwrap_or(1);

    let produce_rtp = json!({
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
            "maxBitrate": voice_bitrate_kbps * 1000,
        }],
        "rtcp": {
            "cname": "",
            "reducedSize": true,
        },
    });

    let produce_ack = ack_emit(
        socket,
        "voice:produce",
        json!({
            "channelId": channel_id,
            "transportId": send_transport_id,
            "kind": "audio",
            "rtpParameters": produce_rtp,
        }),
    )
    .await;

    match produce_ack {
        Ok(Payload::Text(values)) => {
            if let Some(data) = values.first() {
                if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
                    emit_state(app, "failed", Some(&format!("Produce failed: {err}")));
                    let _ = socket
                        .emit("voice:leave", json!({ "channelId": channel_id }))
                        .await;
                    return;
                }
            }
        }
        _ => {
            emit_state(app, "failed", Some("Produce failed: no response"));
            let _ = socket
                .emit("voice:leave", json!({ "channelId": channel_id }))
                .await;
            return;
        }
    }

    let _ = app.emit(
        "voice:event",
        VoiceEvent::State {
            state: "active".into(),
            error: None,
        },
    );

    let audio_track = transport_pair.audio_track.clone();
    let encoder = match encode::AudioEncoder::new(48000, 1) {
        Ok(enc) => enc,
        Err(e) => {
            emit_state(app, "failed", Some(&format!("Opus encoder: {e}")));
            return;
        }
    };

    let pending_recv = transport_pair.pending_recv.clone();

    let (pcm_tx, pcm_rx) =
        tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
    let (speaking_tx, mut speaking_rx) =
        tokio::sync::mpsc::unbounded_channel::<bool>();

    let cancel = Arc::new(AtomicBool::new(false));
    match encode::start_native_audio_capture(
        None, 48000, 1, pcm_tx, cancel.clone(),
    ) {
        Ok(stream) => {
            let audio_send = AudioSendSession::new(
                encoder,
                audio_track,
                pcm_rx,
                stream,
                speaking_tx,
            );

            // Spawn speaking state emitter
            let speak_socket = socket.clone();
            let cid = channel_id.to_string();
            tokio::spawn(async move {
                while let Some(speaking) = speaking_rx.recv().await {
                    let _ = speak_socket
                        .emit(
                            "voice:speaking",
                            json!({ "channelId": cid, "speaking": speaking }),
                        )
                        .await;
                }
            });

            *active_call = Some(ActiveCall {
                channel_id: channel_id.to_string(),
                send_pc: transport_pair.send_pc,
                recv_pc: transport_pair.recv_pc,
                audio_send: Some(audio_send),
            });

            *recv_pending = Some(pending_recv.clone());
            *current_channel = Some(channel_id.to_string());
            *router_caps = Some(router_rtp_capabilities.clone());

            if let Some(data) = ack_data {
                for peer in data.get("peers").and_then(|v| v.as_array()).into_iter().flatten() {
                    let peer_id = peer.get("peerId")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    consume_peer(socket, channel_id, &peer_id, &pending_recv, &router_rtp_capabilities).await;
                }
            }
        }
        Err(e) => {
            emit_state(app, "failed", Some(&format!("Audio capture: {e}")));
        }
    }
}

async fn consume_peer(
    socket: &SocketClient,
    channel_id: &str,
    peer_id: &str,
    pending: &Arc<tokio::sync::Mutex<Vec<String>>>,
    rtp_capabilities: &Value,
) {
    let result = ack_emit(
        socket,
        "voice:consume",
        json!({
            "channelId": channel_id,
            "peerId": peer_id,
            "rtpCapabilities": rtp_capabilities,
        }),
    )
    .await;

    match result {
        Ok(Payload::Text(values)) => {
            if let Some(data) = values.first() {
                if data.get("error").is_none() {
                    pending.lock().await.push(peer_id.to_string());
                    eprintln!("[Signaling] consumed peer={peer_id}");
                }
            }
        }
        _ => {
            eprintln!("[Signaling] consume failed for peer={peer_id}");
        }
    }
}

fn emit_existing_peers(app: &AppHandle, data: &Value) {
    if let Some(peers) = data.get("peers").and_then(|v| v.as_array()) {
        for peer in peers {
            let peer_id = peer
                .get("peerId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let uid = peer
                .get("userId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let uname = peer
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let _ = app.emit(
                "voice:event",
                VoiceEvent::PeerJoined {
                    peer_id,
                    user_id: uid,
                    username: uname,
                },
            );
        }
    }

    if let Some(screen) = data.get("screenSharePeer") {
        if let Some(pid) = screen.get("peerId").and_then(|v| v.as_str()) {
            let uid = screen
                .get("userId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let uname = screen
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let _ = app.emit(
                "voice:event",
                VoiceEvent::ScreenShareStarted {
                    peer_id: pid.to_string(),
                    user_id: uid.to_string(),
                    username: uname.to_string(),
                },
            );
        }
    }
}
