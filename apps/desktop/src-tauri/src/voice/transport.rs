use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

pub struct TransportPair {
    pub send_pc: RTCPeerConnection,
    pub recv_pc: RTCPeerConnection,
    pub audio_track: Arc<TrackLocalStaticSample>,
    pub audio_sender: Arc<RTCRtpSender>,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub pending_recv: Arc<tokio::sync::Mutex<Vec<String>>>,
}

fn build_ice_servers(ice_servers: &[Value]) -> Vec<RTCIceServer> {
    ice_servers
        .iter()
        .filter_map(|s| {
            let urls = s.get("urls").and_then(|v| v.as_str())?;
            let username = s
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let credential = s
                .get("credential")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(RTCIceServer {
                urls: vec![urls.to_string()],
                username,
                credential,
            })
        })
        .collect()
}

fn build_remote_sdp(transport_params: &Value) -> String {
    let ice = transport_params
        .get("iceParameters")
        .and_then(|v| v.as_object());
    let ufrag = ice
        .and_then(|i| i.get("usernameFragment"))
        .and_then(|v| v.as_str())
        .unwrap_or("kizuna");
    let pwd = ice
        .and_then(|i| i.get("password"))
        .and_then(|v| v.as_str())
        .unwrap_or("kizuna");

    let dtls = transport_params.get("dtlsParameters");
    let fp = dtls
        .and_then(|d| d.get("fingerprints"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|f| f.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00");

    let candidates = transport_params
        .get("iceCandidates")
        .and_then(|v| v.as_array());

    let mut sdp = format!(
        "v=0\r\n\
         o=- 0 0 IN IP4 0.0.0.0\r\n\
         s=-\r\n\
         t=0 0\r\n\
         a=group:BUNDLE 0 1\r\n\
         a=ice-lite\r\n\
         m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n\
         c=IN IP4 0.0.0.0\r\n\
         a=mid:0\r\n\
          a=rtpmap:111 opus/48000/2\r\n\
          a=fmtp:111 minptime=10;useinbandfec=1\r\n\
         a=rtcp-mux\r\n\
         a=rtcp-rsize\r\n\
         m=video 9 UDP/TLS/RTP/SAVPF 101\r\n\
         c=IN IP4 0.0.0.0\r\n\
         a=mid:1\r\n\
         a=rtpmap:101 VP8/90000\r\n\
         a=rtcp-mux\r\n\
         a=rtcp-rsize\r\n\
         a=ice-ufrag:{ufrag}\r\n\
         a=ice-pwd:{pwd}\r\n\
         a=fingerprint:sha-256 {fp}\r\n\
         a=setup:actpass\r\n"
    );

    if let Some(cands) = candidates {
        for cand in cands {
            let foundation = cand
                .get("foundation")
                .and_then(|v| v.as_str())
                .unwrap_or("1");
            let component = cand.get("component").and_then(|v| v.as_u64()).unwrap_or(1);
            let transport = cand
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("udp");
            let priority = cand.get("priority").and_then(|v| v.as_u64()).unwrap_or(0);
            let ip = cand.get("ip").and_then(|v| v.as_str()).unwrap_or("0.0.0.0");
            let port = cand.get("port").and_then(|v| v.as_u64()).unwrap_or(9);
            let ctype = cand.get("type").and_then(|v| v.as_str()).unwrap_or("host");

            let tcp_type = if transport == "tcp" {
                cand.get("tcpType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("passive")
            } else {
                ""
            };

            let tcp_str = if transport == "tcp" {
                format!(" tcptype {}", tcp_type)
            } else {
                String::new()
            };

            sdp.push_str(&format!(
                "a=candidate:{foundation} {component} {transport} {priority} {ip} {port} typ {ctype}{tcp_str}\r\n"
            ));
        }
    }

    sdp
}

pub fn extract_dtls_params_from_sdp(sdp_str: &str) -> Option<Value> {
    let mut fingerprint = None;
    let mut setup = "active";

    for line in sdp_str.lines() {
        if let Some(fp_str) = line.strip_prefix("a=fingerprint:sha-256 ") {
            fingerprint = Some(fp_str.trim().to_string());
        }
        if let Some(setup_val) = line.strip_prefix("a=setup:") {
            setup = setup_val.trim();
        }
    }

    let role = match setup {
        "active" => "client",
        "passive" => "server",
        _ => "auto",
    };

    fingerprint.map(|fp| {
        serde_json::json!({
            "fingerprints": [{
                "algorithm": "sha-256",
                "value": fp,
            }],
            "role": role,
        })
    })
}

pub async fn create_transports(
    app: AppHandle,
    ice_servers_json: &[Value],
    send_params: &Value,
    recv_params: &Value,
) -> Result<(TransportPair, Value, Value), String> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()
        .map_err(|e| format!("Failed to register codecs: {e}"))?;

    let api = APIBuilder::new()
        .with_media_engine(m)
        .build();

    let config = RTCConfiguration {
        ice_servers: build_ice_servers(ice_servers_json),
        ..Default::default()
    };

    let pending_tracks: Arc<tokio::sync::Mutex<Vec<String>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let pending_tracks_clone = pending_tracks.clone();

    let send_pc = api
        .new_peer_connection(config.clone())
        .await
        .map_err(|e| format!("Failed to create send PC: {e}"))?;

    let send_app = app.clone();
    send_pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        let app = send_app.clone();
        Box::pin(async move {
            eprintln!("[SendPC] state: {state:?}");
            if state == RTCPeerConnectionState::Failed
                || state == RTCPeerConnectionState::Disconnected
            {
                let _ = app.emit(
                    "voice:event",
                    serde_json::json!({
                        "type": "State",
                        "data": {
                            "state": "failed",
                            "error": format!("Send connection {state:?}")
                        }
                    }),
                );
            }
        })
    }));

    send_pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        eprintln!("[SendPC] ICE state: {state:?}");
        Box::pin(async {})
    }));

    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".to_string(),
            clock_rate: 48000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
            rtcp_feedback: vec![],
        },
        "audio".to_string(),
        "kizuna-audio".to_string(),
    ));

    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "video/VP8".to_string(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        },
        "video".to_string(),
        "kizuna-video".to_string(),
    ));

    send_pc
        .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("Failed to add video track: {e}"))?;

    let rtp_sender = send_pc
        .add_track(audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("Failed to add audio track: {e}"))?;

    let remote_sdp_str = build_remote_sdp(send_params);
    let remote_sdp = RTCSessionDescription::offer(remote_sdp_str)
        .map_err(|e| format!("Failed to parse remote SDP: {e}"))?;

    send_pc
        .set_remote_description(remote_sdp)
        .await
        .map_err(|e| format!("Failed to set remote description (send): {e}"))?;

    let answer = send_pc
        .create_answer(None)
        .await
        .map_err(|e| format!("Failed to create answer (send): {e}"))?;

    send_pc
        .set_local_description(answer)
        .await
        .map_err(|e| format!("Failed to set local description (send): {e}"))?;

    let local_sdp = send_pc
        .local_description()
        .await
        .ok_or("No local description after answer")?;

    let send_dtls = extract_dtls_params_from_sdp(&local_sdp.sdp)
        .ok_or("Failed to extract DTLS params from send local SDP")?;

    let recv_pc = api
        .new_peer_connection(config)
        .await
        .map_err(|e| format!("Failed to create recv PC: {e}"))?;

    let recv_app = app.clone();
    recv_pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        let app = recv_app.clone();
        Box::pin(async move {
            eprintln!("[RecvPC] state: {state:?}");
            if state == RTCPeerConnectionState::Failed
                || state == RTCPeerConnectionState::Disconnected
            {
                let _ = app.emit(
                    "voice:event",
                    serde_json::json!({
                        "type": "State",
                        "data": {
                            "state": "failed",
                            "error": format!("Recv connection {state:?}")
                        }
                    }),
                );
            }
        })
    }));

    recv_pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        eprintln!("[RecvPC] ICE state: {state:?}");
        Box::pin(async {})
    }));

    let recv_app = app.clone();
    recv_pc.on_track(Box::new(
        move |track: Arc<webrtc::track::track_remote::TrackRemote>,
              _receiver: Arc<webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver>,
              _transceiver: Arc<webrtc::rtp_transceiver::RTCRtpTransceiver>| {
            let pending = pending_tracks_clone.clone();
            let app = recv_app.clone();
            Box::pin(async move {
                let peer_id = {
                    let mut pending = pending.lock().await;
                    if pending.is_empty() {
                        eprintln!("[RecvPC] on_track: no pending peer for track");
                        return;
                    }
                    pending.remove(0)
                };
                eprintln!("[RecvPC] on_track: peer={peer_id}");
                super::encode::AudioRecvSession::spawn(app, peer_id, track);
            })
        },
    ));

    let remote_recv_sdp_str = build_remote_sdp(recv_params);
    let remote_recv_sdp = RTCSessionDescription::offer(remote_recv_sdp_str)
        .map_err(|e| format!("Failed to parse remote recv SDP: {e}"))?;

    recv_pc
        .set_remote_description(remote_recv_sdp)
        .await
        .map_err(|e| format!("Failed to set remote description (recv): {e}"))?;

    let recv_answer = recv_pc
        .create_answer(None)
        .await
        .map_err(|e| format!("Failed to create answer (recv): {e}"))?;

    recv_pc
        .set_local_description(recv_answer)
        .await
        .map_err(|e| format!("Failed to set local description (recv): {e}"))?;

    let recv_local_sdp = recv_pc
        .local_description()
        .await
        .ok_or("No local description for recv")?;

    let recv_dtls = extract_dtls_params_from_sdp(&recv_local_sdp.sdp)
        .ok_or("Failed to extract DTLS params from recv local SDP")?;

    Ok((
        TransportPair {
            send_pc,
            recv_pc,
            audio_track,
            audio_sender: rtp_sender,
            video_track,
            pending_recv: pending_tracks,
        },
        send_dtls,
        recv_dtls,
    ))
}
