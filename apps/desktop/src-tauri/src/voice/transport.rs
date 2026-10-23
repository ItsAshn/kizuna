//! WebRTC transports to the mediasoup SFU.
//!
//! mediasoup does not do SDP: a transport is described by its ICE parameters,
//! candidates and DTLS fingerprint. webrtc-rs only speaks SDP, so we
//! synthesise mediasoup's side as a remote *offer* (ice-lite, every m-line
//! the SFU wants) and let the local peer connection answer it. The answer's
//! DTLS fingerprint and role are what `voice:connectTransport` hands back.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::{json, Value};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{APIBuilder, API};
use webrtc::dtls_transport::dtls_role::DTLSRole;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::capture::VideoSource;

/// Payload type the native client sends VP8 on. Declared in the synthesised
/// offer and in the producer's RTP parameters; mediasoup maps it to the
/// router's own VP8 payload type.
pub const VP8_PAYLOAD_TYPE: u8 = 100;
pub const OPUS_PAYLOAD_TYPE: u8 = 111;

/// The video m-lines of the send transport, in mid order (mid 1, mid 2).
pub const SEND_VIDEO_SOURCES: [VideoSource; 2] = [VideoSource::Screen, VideoSource::Camera];

/// RTCP feedback both sides of a video stream support. mediasoup only sends a
/// PLI/FIR/NACK to a producer whose RTP parameters list it, and an empty list
/// is why viewers' keyframe requests used to be dropped.
pub const VIDEO_RTCP_FEEDBACK: [(&str, &str); 3] = [("nack", ""), ("nack", "pli"), ("ccm", "fir")];

pub struct VideoSendTrack {
    pub track: Arc<TrackLocalStaticSample>,
    pub sender: Arc<RTCRtpSender>,
}

pub struct SendTransport {
    pub pc: RTCPeerConnection,
    pub audio_track: Arc<TrackLocalStaticSample>,
    pub audio_sender: Arc<RTCRtpSender>,
    pub video: HashMap<VideoSource, VideoSendTrack>,
    /// For `voice:connectTransport`.
    pub dtls: Value,
}

pub(crate) fn build_ice_servers(ice_servers: &[Value]) -> Vec<RTCIceServer> {
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

/// The webrtc-rs API every transport is built from.
///
/// * Default interceptors: NACK responder/generator and RTCP sender/receiver
///   reports. Without them a lost video packet is never retransmitted and
///   the SFU never hears how the stream is doing.
/// * An explicit answering DTLS role. With an `actpass` offer from an ice-lite
///   peer, webrtc-rs *writes* `a=setup:active` in its answer but then acts as
///   DTLS server (it derives the role from being ICE-controlling). Pinning the
///   role makes the answer tell the truth, so [`dtls_role_from_sdp`] can read it
///   instead of the role being hardcoded.
pub(crate) fn build_api() -> Result<API, String> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .map_err(|e| format!("Failed to register codecs: {e}"))?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .map_err(|e| format!("Failed to register interceptors: {e}"))?;
    let mut settings = SettingEngine::default();
    settings
        .set_answering_dtls_role(DTLSRole::Server)
        .map_err(|e| format!("Failed to set DTLS role: {e}"))?;
    Ok(APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(settings)
        .build())
}

/// ICE + DTLS identity of a mediasoup transport, as SDP attributes.
pub(crate) struct RemoteTransport {
    ufrag: String,
    pwd: String,
    fingerprint: String,
    candidates: Vec<String>,
}

impl RemoteTransport {
    pub(crate) fn from_params(params: &Value) -> Self {
        let ice = params.get("iceParameters").and_then(|v| v.as_object());
        let ufrag = ice
            .and_then(|i| i.get("usernameFragment"))
            .and_then(|v| v.as_str())
            .unwrap_or("kizuna")
            .to_string();
        let pwd = ice
            .and_then(|i| i.get("password"))
            .and_then(|v| v.as_str())
            .unwrap_or("kizuna")
            .to_string();

        // Prefer the sha-256 fingerprint: that is the algorithm the a= line
        // below declares.
        let fingerprints = params
            .get("dtlsParameters")
            .and_then(|d| d.get("fingerprints"))
            .and_then(|v| v.as_array());
        let pick = |alg: Option<&str>| {
            fingerprints.and_then(|arr| {
                arr.iter()
                    .find(|f| {
                        alg.is_none_or(|a| f.get("algorithm").and_then(|v| v.as_str()) == Some(a))
                    })
                    .and_then(|f| f.get("value"))
                    .and_then(|v| v.as_str())
            })
        };
        let fingerprint = pick(Some("sha-256"))
            .or_else(|| pick(None))
            .unwrap_or("00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00")
            .to_string();

        let candidates = params
            .get("iceCandidates")
            .and_then(|v| v.as_array())
            .map(|cands| cands.iter().map(candidate_line).collect())
            .unwrap_or_default();

        Self {
            ufrag,
            pwd,
            fingerprint,
            candidates,
        }
    }

    /// The transport-level attributes every BUNDLEd m-line repeats.
    fn write_media_attributes(&self, sdp: &mut String, with_candidates: bool) {
        let _ = write!(
            sdp,
            "a=rtcp-mux\r\n\
             a=rtcp-rsize\r\n\
             a=ice-ufrag:{}\r\n\
             a=ice-pwd:{}\r\n\
             a=fingerprint:sha-256 {}\r\n\
             a=setup:actpass\r\n",
            self.ufrag, self.pwd, self.fingerprint
        );
        if with_candidates {
            for c in &self.candidates {
                sdp.push_str(c);
            }
            sdp.push_str("a=end-of-candidates\r\n");
        }
    }
}

fn candidate_line(cand: &Value) -> String {
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
    let ip = cand
        .get("address")
        .or_else(|| cand.get("ip"))
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0.0");
    let port = cand.get("port").and_then(|v| v.as_u64()).unwrap_or(9);
    let ctype = cand.get("type").and_then(|v| v.as_str()).unwrap_or("host");
    let tcp = if transport == "tcp" {
        format!(
            " tcptype {}",
            cand.get("tcpType")
                .and_then(|v| v.as_str())
                .unwrap_or("passive")
        )
    } else {
        String::new()
    };
    format!("a=candidate:{foundation} {component} {transport} {priority} {ip} {port} typ {ctype}{tcp}\r\n")
}

pub(crate) fn session_header(sdp: &mut String, version: u64, mids: &[String]) {
    let _ = write!(
        sdp,
        "v=0\r\n\
         o=- 0 {version} IN IP4 0.0.0.0\r\n\
         s=-\r\n\
         t=0 0\r\n\
         a=group:BUNDLE {}\r\n\
         a=ice-lite\r\n\
         a=msid-semantic: WMS *\r\n",
        mids.join(" ")
    );
}

/// The VP8 lines of a video m-section: rtpmap and the RTCP feedback both
/// sides support.
pub(crate) fn vp8_lines(sdp: &mut String, pt: u8) {
    let _ = write!(sdp, "a=rtpmap:{pt} VP8/90000\r\n");
    for (typ, param) in VIDEO_RTCP_FEEDBACK {
        if param.is_empty() {
            let _ = write!(sdp, "a=rtcp-fb:{pt} {typ}\r\n");
        } else {
            let _ = write!(sdp, "a=rtcp-fb:{pt} {typ} {param}\r\n");
        }
    }
}

/// One m-section. `body` is called to write the codec/ssrc lines.
#[allow(clippy::too_many_arguments)]
pub(crate) fn media_section(
    sdp: &mut String,
    remote: &RemoteTransport,
    kind: &str,
    mid: &str,
    pts: &[u8],
    direction: &str,
    first: bool,
    body: impl FnOnce(&mut String),
) {
    let pt_list = pts
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    // Port 0 would mean "rejected"; an inactive section keeps port 9 so it
    // stays in the bundle and can be reused.
    let _ = write!(
        sdp,
        "m={kind} 9 UDP/TLS/RTP/SAVPF {pt_list}\r\n\
         c=IN IP4 0.0.0.0\r\n\
         a=mid:{mid}\r\n\
         a={direction}\r\n"
    );
    body(sdp);
    remote.write_media_attributes(sdp, first);
}

/// mediasoup's side of the send transport: it receives the microphone on
/// mid 0, screenshare on mid 1 and camera on mid 2, all BUNDLEd.
pub(crate) fn build_send_offer(transport_params: &Value) -> String {
    let remote = RemoteTransport::from_params(transport_params);
    let mids: Vec<String> = (0..=SEND_VIDEO_SOURCES.len()).map(|m| m.to_string()).collect();
    let mut sdp = String::new();
    session_header(&mut sdp, 0, &mids);
    media_section(
        &mut sdp,
        &remote,
        "audio",
        "0",
        &[OPUS_PAYLOAD_TYPE],
        "recvonly",
        true,
        |s| {
            let _ = write!(
                s,
                "a=rtpmap:{OPUS_PAYLOAD_TYPE} opus/48000/2\r\n\
                 a=fmtp:{OPUS_PAYLOAD_TYPE} minptime=10;useinbandfec=1\r\n"
            );
        },
    );
    for (i, _) in SEND_VIDEO_SOURCES.iter().enumerate() {
        let mid = (i + 1).to_string();
        media_section(
            &mut sdp,
            &remote,
            "video",
            &mid,
            &[VP8_PAYLOAD_TYPE],
            "recvonly",
            false,
            |s| vp8_lines(s, VP8_PAYLOAD_TYPE),
        );
    }
    sdp
}

/// mediasoup's DTLS role for *our* end, from the `a=setup` of the SDP we
/// answered with: `active` connects (client), `passive` waits (server).
pub fn dtls_role_from_sdp(sdp: &str) -> &'static str {
    for line in sdp.lines() {
        if let Some(setup) = line.trim().strip_prefix("a=setup:") {
            return match setup.trim() {
                "active" => "client",
                "passive" => "server",
                _ => "auto",
            };
        }
    }
    "auto"
}

pub fn extract_dtls_params_from_sdp(sdp_str: &str) -> Option<Value> {
    let fingerprint = sdp_str
        .lines()
        .find_map(|line| line.trim().strip_prefix("a=fingerprint:sha-256 "))
        .map(|fp| fp.trim().to_string())?;
    Some(json!({
        "fingerprints": [{
            "algorithm": "sha-256",
            "value": fingerprint,
        }],
        "role": dtls_role_from_sdp(sdp_str),
    }))
}

/// Applies a synthesised remote offer and returns our answer's SDP.
pub(crate) async fn answer_remote_offer(pc: &RTCPeerConnection, offer: String) -> Result<String, String> {
    let remote = RTCSessionDescription::offer(offer)
        .map_err(|e| format!("Failed to parse remote SDP: {e}"))?;
    pc.set_remote_description(remote)
        .await
        .map_err(|e| format!("Failed to set remote description: {e}"))?;
    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| format!("Failed to create answer: {e}"))?;
    pc.set_local_description(answer)
        .await
        .map_err(|e| format!("Failed to set local description: {e}"))?;
    pc.local_description()
        .await
        .map(|d| d.sdp)
        .ok_or_else(|| "No local description after answer".to_string())
}

fn video_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: "video/VP8".to_string(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![],
    }
}

pub async fn create_send_transport(
    ice_servers_json: &[Value],
    send_params: &Value,
) -> Result<SendTransport, String> {
    let api = build_api()?;
    let config = RTCConfiguration {
        ice_servers: build_ice_servers(ice_servers_json),
        ..Default::default()
    };

    let pc = api
        .new_peer_connection(config)
        .await
        .map_err(|e| format!("Failed to create send PC: {e}"))?;

    pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        eprintln!("[SendPC] state: {state:?}");
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
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
    let audio_sender = pc
        .add_track(audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("Failed to add audio track: {e}"))?;

    // Added in mid order: the offer's video m-lines are matched to video
    // transceivers in the order they were created.
    let mut video = HashMap::new();
    for source in SEND_VIDEO_SOURCES {
        let track = Arc::new(TrackLocalStaticSample::new(
            video_capability(),
            source.as_str().to_string(),
            format!("kizuna-{}", source.as_str()),
        ));
        let sender = pc
            .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| format!("Failed to add {} track: {e}", source.as_str()))?;
        video.insert(source, VideoSendTrack { track, sender });
    }

    let local_sdp = answer_remote_offer(&pc, build_send_offer(send_params)).await?;
    let dtls = extract_dtls_params_from_sdp(&local_sdp)
        .ok_or("Failed to extract DTLS params from send local SDP")?;

    Ok(SendTransport {
        pc,
        audio_track,
        audio_sender,
        video,
        dtls,
    })
}

/// `voice:produce` RTP parameters for a native video track.
pub fn video_rtp_parameters(ssrc: u32, max_bitrate_bps: u32) -> Value {
    let feedback: Vec<Value> = VIDEO_RTCP_FEEDBACK
        .iter()
        .map(|(typ, param)| json!({ "type": typ, "parameter": param }))
        .collect();
    json!({
        "codecs": [{
            "mimeType": "video/VP8",
            "payloadType": VP8_PAYLOAD_TYPE,
            "clockRate": 90000,
            "parameters": {},
            "rtcpFeedback": feedback,
        }],
        "headerExtensions": [],
        "encodings": [{
            "ssrc": ssrc,
            "maxBitrate": max_bitrate_bps,
        }],
        "rtcp": {
            "cname": "",
            "reducedSize": true,
        },
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// What mediasoup's `createWebRtcTransport` hands the client.
    pub(crate) fn mediasoup_params() -> Value {
        json!({
            "id": "t1",
            "iceParameters": { "usernameFragment": "ufragufragufrag1", "password": "passwordpasswordpassword", "iceLite": true },
            "iceCandidates": [
                { "foundation": "udpcandidate", "priority": 1076302079u64, "address": "127.0.0.1", "ip": "127.0.0.1", "protocol": "udp", "port": 40000, "type": "host" },
                { "foundation": "tcpcandidate", "priority": 1076276479u64, "address": "127.0.0.1", "ip": "127.0.0.1", "protocol": "tcp", "port": 40001, "type": "host", "tcpType": "passive" }
            ],
            "dtlsParameters": {
                "role": "auto",
                "fingerprints": [
                    { "algorithm": "sha-384", "value": "AA:BB" },
                    { "algorithm": "sha-256", "value": "82:5A:68:3D:36:C3:0A:DE:AF:E7:32:43:D2:88:83:57:AC:2D:65:E5:80:C4:B6:FB:AF:1A:A0:21:9F:6D:0C:AD" }
                ]
            }
        })
    }

    /// Splits an SDP into its m-sections (each starting at its `m=` line).
    pub(crate) fn sections(sdp: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for line in sdp.lines() {
            if line.starts_with("m=") {
                out.push(String::new());
            }
            if let Some(cur) = out.last_mut() {
                cur.push_str(line);
                cur.push('\n');
            }
        }
        out
    }

    #[test]
    fn offer_bundles_audio_and_two_video_lines() {
        let sdp = build_send_offer(&mediasoup_params());
        assert!(sdp.contains("a=group:BUNDLE 0 1 2\r\n"));
        assert!(sdp.contains("a=ice-lite\r\n"));
        // The sha-256 fingerprint is picked, not the first one listed.
        assert!(sdp.contains("a=fingerprint:sha-256 82:5A:68"));
        let s = sections(&sdp);
        assert_eq!(s.len(), 3);
        assert!(s[0].starts_with("m=audio 9 UDP/TLS/RTP/SAVPF 111"));
        for (i, sec) in s[1..].iter().enumerate() {
            assert!(sec.starts_with("m=video 9 UDP/TLS/RTP/SAVPF 100"), "{sec}");
            assert!(sec.contains(&format!("a=mid:{}", i + 1)));
            assert!(sec.contains("a=rtpmap:100 VP8/90000"));
            assert!(sec.contains("a=rtcp-fb:100 nack\n"));
            assert!(sec.contains("a=rtcp-fb:100 nack pli"));
            assert!(sec.contains("a=rtcp-fb:100 ccm fir"));
        }
        assert!(s[0].contains("a=candidate:udpcandidate 1 udp 1076302079 127.0.0.1 40000 typ host"));
        assert!(s[0].contains("tcptype passive"));
    }

    #[test]
    fn dtls_role_follows_the_answer() {
        assert_eq!(dtls_role_from_sdp("v=0\r\na=setup:active\r\n"), "client");
        assert_eq!(dtls_role_from_sdp("v=0\r\na=setup:passive\r\n"), "server");
        assert_eq!(dtls_role_from_sdp("v=0\r\na=setup:actpass\r\n"), "auto");
        assert_eq!(dtls_role_from_sdp("v=0\r\n"), "auto");
        let p = extract_dtls_params_from_sdp("a=setup:active\r\na=fingerprint:sha-256 AB:CD\r\n")
            .expect("params");
        assert_eq!(p["role"], "client");
        assert_eq!(p["fingerprints"][0]["value"], "AB:CD");
    }

    #[test]
    fn video_rtp_parameters_carry_rtcp_feedback() {
        let p = video_rtp_parameters(1234, 4_000_000);
        let fb = p["codecs"][0]["rtcpFeedback"].as_array().expect("feedback");
        let pairs: Vec<(String, String)> = fb
            .iter()
            .map(|f| {
                (
                    f["type"].as_str().unwrap_or_default().to_string(),
                    f["parameter"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        assert!(pairs.contains(&("nack".into(), "".into())));
        assert!(pairs.contains(&("nack".into(), "pli".into())));
        assert!(pairs.contains(&("ccm".into(), "fir".into())));
        assert_eq!(p["codecs"][0]["payloadType"], 100);
        assert_eq!(p["encodings"][0]["ssrc"], 1234);
    }

    /// The synthesised offer must be accepted by webrtc-rs, and the answer
    /// must send VP8 on both video mids with the feedback mediasoup expects,
    /// in a DTLS role that matches what we tell mediasoup.
    #[tokio::test(flavor = "multi_thread")]
    async fn webrtc_rs_answers_the_send_offer() {
        let t = create_send_transport(&[], &mediasoup_params())
            .await
            .expect("send transport");
        let answer = t.pc.local_description().await.expect("answer").sdp;

        assert!(answer.contains("a=group:BUNDLE 0 1 2"), "{answer}");
        let s = sections(&answer);
        assert_eq!(s.len(), 3, "{answer}");
        assert!(s[0].starts_with("m=audio"));
        assert!(s[0].contains("a=sendonly"), "{}", s[0]);
        for (i, sec) in s[1..].iter().enumerate() {
            assert!(sec.starts_with("m=video"), "{sec}");
            assert!(sec.contains(&format!("a=mid:{}", i + 1)), "{sec}");
            assert!(sec.contains("a=sendonly"), "{sec}");
            assert!(sec.contains("a=rtpmap:100 VP8/90000"), "{sec}");
            assert!(sec.contains("a=rtcp-fb:100 nack\n"), "{sec}");
            assert!(sec.contains("a=rtcp-fb:100 nack pli"), "{sec}");
            assert!(sec.contains("a=ssrc:"), "{sec}");
        }

        // We pinned the answering role to server: the answer says passive and
        // the params we hand mediasoup agree.
        assert!(answer.contains("a=setup:passive"), "{answer}");
        assert_eq!(t.dtls["role"], "server");

        // Both video senders are bound to distinct SSRCs we can announce.
        let mut ssrcs = Vec::new();
        for source in SEND_VIDEO_SOURCES {
            let p = t.video[&source].sender.get_parameters().await;
            ssrcs.push(p.encodings[0].ssrc);
        }
        assert_ne!(ssrcs[0], ssrcs[1]);
        let _ = t.pc.close().await;
    }
}
