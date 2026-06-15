use std::sync::Arc;

use serde_json::Value;
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
    pub audio_track: Arc<TrackLocalStaticSample>,
    pub audio_sender: Arc<RTCRtpSender>,
    pub video_track: Arc<TrackLocalStaticSample>,
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
         a=group:BUNDLE 0\r\n\
         a=ice-lite\r\n\
         m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n\
         c=IN IP4 0.0.0.0\r\n\
         a=mid:0\r\n\
          a=rtpmap:111 opus/48000/1\r\n\
         a=fmtp:111 minptime=10;useinbandfec=1\r\n\
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

    for line in sdp_str.lines() {
        if let Some(fp_str) = line.strip_prefix("a=fingerprint:sha-256 ") {
            fingerprint = Some(fp_str.trim().to_string());
        }
    }

    fingerprint.map(|fp| {
        serde_json::json!({
            "fingerprints": [{
                "algorithm": "sha-256",
                "value": fp,
            }],
            "role": "server",
        })
    })
}

pub async fn create_transports(
    ice_servers_json: &[Value],
    send_params: &Value,
) -> Result<(TransportPair, Value), String> {
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

    let send_pc = api
        .new_peer_connection(config.clone())
        .await
        .map_err(|e| format!("Failed to create send PC: {e}"))?;

    send_pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        eprintln!("[SendPC] state: {state:?}");
        Box::pin(async {})
    }));

    send_pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        eprintln!("[SendPC] ICE state: {state:?}");
        Box::pin(async {})
    }));

    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".to_string(),
            clock_rate: 48000,
            channels: 1,
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

    let send_answer = send_pc
        .create_answer(None)
        .await
        .map_err(|e| format!("Failed to create answer (send): {e}"))?;

    send_pc
        .set_local_description(send_answer)
        .await
        .map_err(|e| format!("Failed to set local description (send): {e}"))?;

    let local_sdp = send_pc
        .local_description()
        .await
        .ok_or("No local description after answer")?;

    let send_dtls = extract_dtls_params_from_sdp(&local_sdp.sdp)
        .ok_or("Failed to extract DTLS params from send local SDP")?;

    Ok((
        TransportPair {
            send_pc,
            audio_track,
            audio_sender: rtp_sender,
            video_track,
        },
        send_dtls,
    ))
}
