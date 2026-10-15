//! Native video receive for webviews without WebRTC (WebKitGTK on Linux).
//!
//! One webrtc-rs peer connection per call receives every remote screen and
//! camera from the SFU's video recv transport. As with the send side,
//! mediasoup's half is synthesised as a remote offer: each consumer is a
//! `sendonly` VP8 m-line carrying its SSRC, and we answer.
//!
//! Adding a consumer appends an m-line and re-offers. Removing one turns its
//! m-line `inactive`; m-lines are never removed (BUNDLE forbids it) and never
//! handed to a new consumer, because webrtc-rs does not start a second track
//! on a transceiver that has already received one.
//!
//! Each track is depacketised (`SampleBuilder<Vp8Packet>`) and decoded by a
//! GStreamer pipeline, `appsrc ! vp8dec ! videoconvert ! videoscale ! jpegenc
//! ! appsink`, whose JPEGs go to the page as raw IPC frames:
//!
//! ```text
//! [stream_id: u32 LE][width: u16 LE][height: u16 LE][reserved: u32][jpeg...]
//! ```

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use serde_json::Value;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::media::io::sample_builder::SampleBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp::codecs::vp8::Vp8Packet;
use webrtc::track::track_remote::TrackRemote;

use super::transport::{self, RemoteTransport};
use super::video::make_element;

/// Bytes in front of every frame sent to the page.
pub const FRAME_HEADER_BYTES: usize = 12;

/// Keyframe requests are throttled to one per this interval per stream.
const PLI_INTERVAL: Duration = Duration::from_millis(500);

/// Receives one finished frame message (header + JPEG).
pub type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// Builds the message the page decodes: see the module docs.
pub fn frame_message(stream_id: u32, width: u32, height: u32, jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + jpeg.len());
    out.extend_from_slice(&stream_id.to_le_bytes());
    out.extend_from_slice(&(width.min(u16::MAX as u32) as u16).to_le_bytes());
    out.extend_from_slice(&(height.min(u16::MAX as u32) as u16).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(jpeg);
    out
}

/// A VP8 frame is a keyframe when the P bit of its first byte is clear.
pub fn is_vp8_keyframe(frame: &[u8]) -> bool {
    frame.first().is_some_and(|b| b & 0x01 == 0)
}

struct Consumer {
    consumer_id: String,
    ssrc: u32,
    payload_type: u8,
    cname: String,
    stream_id: u32,
}

struct Slot {
    mid: String,
    consumer: Option<Consumer>,
}

/// What a track reader needs to know about the stream on its SSRC.
#[derive(Clone)]
struct StreamEntry {
    stream_id: u32,
    active: Arc<AtomicBool>,
}

pub struct VideoRecvController {
    ice_servers: Vec<RTCIceServer>,
    remote: RemoteTransport,
    pc: Option<Arc<RTCPeerConnection>>,
    slots: Vec<Slot>,
    sdp_version: u64,
    next_stream_id: u32,
    /// SSRC → stream, shared with the track readers.
    streams: Arc<Mutex<HashMap<u32, StreamEntry>>>,
    sink: FrameSink,
}

impl VideoRecvController {
    /// `transport_params` is the server's `voice:createTransport` answer for
    /// the video recv transport. No peer connection exists until the first
    /// consumer is added: an offer needs at least one m-line.
    pub fn new(ice_servers: &[Value], transport_params: &Value, sink: FrameSink) -> Self {
        Self {
            ice_servers: transport::build_ice_servers(ice_servers),
            remote: RemoteTransport::from_params(transport_params),
            pc: None,
            slots: Vec::new(),
            sdp_version: 0,
            next_stream_id: 1,
            streams: Arc::new(Mutex::new(HashMap::new())),
            sink,
        }
    }

    /// Start receiving a consumer. Returns the stream id its frames carry and,
    /// on the first call, the DTLS parameters for `voice:connectTransport`.
    pub async fn add_consumer(
        &mut self,
        consumer_id: &str,
        ssrc: u32,
        payload_type: u8,
        cname: &str,
    ) -> Result<(u32, Option<Value>), String> {
        gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;
        if let Some(existing) = self
            .slots
            .iter()
            .filter_map(|s| s.consumer.as_ref())
            .find(|c| c.consumer_id == consumer_id)
        {
            return Ok((existing.stream_id, None));
        }

        let first = self.pc.is_none();
        if first {
            self.pc = Some(self.create_pc().await?);
        }

        let stream_id = self.next_stream_id;
        self.next_stream_id = self.next_stream_id.wrapping_add(1).max(1);
        if let Ok(mut streams) = self.streams.lock() {
            streams.insert(
                ssrc,
                StreamEntry {
                    stream_id,
                    active: Arc::new(AtomicBool::new(true)),
                },
            );
        }
        let mid = self.slots.len().to_string();
        self.slots.push(Slot {
            mid,
            consumer: Some(Consumer {
                consumer_id: consumer_id.to_string(),
                ssrc,
                payload_type,
                cname: cname.to_string(),
                stream_id,
            }),
        });

        let answer = match self.renegotiate().await {
            Ok(answer) => answer,
            Err(e) => {
                // Leave no half-added consumer behind.
                if let Some(slot) = self.slots.last_mut() {
                    slot.consumer = None;
                }
                if let Ok(mut streams) = self.streams.lock() {
                    streams.remove(&ssrc);
                }
                return Err(e);
            }
        };
        eprintln!(
            "[VideoRecv] + consumer {consumer_id} ssrc={ssrc} pt={payload_type} -> stream {stream_id} (m-lines: {})",
            self.slots.len()
        );
        let dtls = if first {
            Some(
                transport::extract_dtls_params_from_sdp(&answer)
                    .ok_or("No DTLS fingerprint in the video recv answer")?,
            )
        } else {
            None
        };
        Ok((stream_id, dtls))
    }

    /// Stop receiving a consumer. Its m-line goes inactive.
    pub async fn remove_consumer(&mut self, consumer_id: &str) -> Result<(), String> {
        let Some(slot) = self.slots.iter_mut().find(|s| {
            s.consumer
                .as_ref()
                .is_some_and(|c| c.consumer_id == consumer_id)
        }) else {
            return Ok(());
        };
        if let Some(c) = slot.consumer.take() {
            if let Ok(mut streams) = self.streams.lock() {
                if let Some(entry) = streams.remove(&c.ssrc) {
                    entry.active.store(false, Ordering::Relaxed);
                }
            }
            eprintln!("[VideoRecv] - consumer {consumer_id} (stream {})", c.stream_id);
        }
        self.renegotiate().await.map(|_| ())
    }

    pub async fn close(&mut self) {
        if let Ok(mut streams) = self.streams.lock() {
            for (_, entry) in streams.drain() {
                entry.active.store(false, Ordering::Relaxed);
            }
        }
        if let Some(pc) = self.pc.take() {
            let _ = pc.close().await;
        }
        self.slots.clear();
    }

    #[cfg(test)]
    pub async fn local_sdp(&self) -> Option<String> {
        match &self.pc {
            Some(pc) => pc.local_description().await.map(|d| d.sdp),
            None => None,
        }
    }

    async fn create_pc(&self) -> Result<Arc<RTCPeerConnection>, String> {
        let api = transport::build_api()?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: self.ice_servers.clone(),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("Failed to create video recv PC: {e}"))?,
        );
        pc.on_peer_connection_state_change(Box::new(|state| {
            eprintln!("[VideoRecv] PC state: {state:?}");
            Box::pin(async {})
        }));

        let streams = self.streams.clone();
        let sink = self.sink.clone();
        let weak = Arc::downgrade(&pc);
        pc.on_track(Box::new(move |track, _receiver, _transceiver| {
            let streams = streams.clone();
            let sink = sink.clone();
            let weak = weak.clone();
            Box::pin(async move {
                tokio::spawn(run_track(track, streams, sink, weak));
            })
        }));
        Ok(pc)
    }

    /// The SFU's side of the recv transport: one VP8 m-line per consumer it
    /// ever sent us, live ones `sendonly`, finished ones `inactive`.
    fn build_offer(&mut self) -> String {
        self.sdp_version += 1;
        let mids: Vec<String> = self.slots.iter().map(|s| s.mid.clone()).collect();
        let mut sdp = String::new();
        transport::session_header(&mut sdp, self.sdp_version, &mids);
        for (i, slot) in self.slots.iter().enumerate() {
            let pt = slot
                .consumer
                .as_ref()
                .map(|c| c.payload_type)
                .unwrap_or(transport::VP8_PAYLOAD_TYPE);
            let direction = if slot.consumer.is_some() {
                "sendonly"
            } else {
                "inactive"
            };
            transport::media_section(
                &mut sdp,
                &self.remote,
                "video",
                &slot.mid,
                &[pt],
                direction,
                i == 0,
                |s| {
                    transport::vp8_lines(s, pt);
                    if let Some(c) = &slot.consumer {
                        let cname = if c.cname.is_empty() { "kizuna" } else { &c.cname };
                        let _ = write!(
                            s,
                            "a=msid:kizuna-{0} video-{0}\r\n\
                             a=ssrc:{1} cname:{2}\r\n\
                             a=ssrc:{1} msid:kizuna-{0} video-{0}\r\n",
                            c.stream_id, c.ssrc, cname
                        );
                    }
                },
            );
        }
        sdp
    }

    async fn renegotiate(&mut self) -> Result<String, String> {
        let pc = self.pc.clone().ok_or("Video receiver is not open")?;
        if self.slots.is_empty() {
            return Ok(String::new());
        }
        if pc.remote_description().await.is_some() {
            wait_for_ice_start(&pc).await;
        }
        let offer = self.build_offer();
        match transport::answer_remote_offer(&pc, offer.clone()).await {
            Ok(answer) => Ok(answer),
            Err(e) => {
                eprintln!("[VideoRecv] renegotiation failed ({e}), recovering");
                // A failed set_remote_description can leave the offer applied
                // but unanswered; finish that exchange so the connection is
                // stable again, then apply the offer once more.
                if pc.signaling_state() == RTCSignalingState::HaveRemoteOffer {
                    if let Ok(answer) = pc.create_answer(None).await {
                        let _ = pc.set_local_description(answer).await;
                    }
                }
                wait_for_ice_start(&pc).await;
                transport::answer_remote_offer(&pc, offer).await
            }
        }
    }
}

/// webrtc-rs hands the ICE agent the remote credentials on a task it spawns
/// after the first answer. A re-offer applied before that sees "changed"
/// credentials and fails as an ICE restart during gathering — which is what
/// two consumers added back to back (a screen and a camera at join) used to
/// hit. The agent leaves `New` once it has them.
async fn wait_for_ice_start(pc: &RTCPeerConnection) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while pc.ice_connection_state() == RTCIceConnectionState::New && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

impl Drop for VideoRecvController {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.streams.lock() {
            for (_, entry) in streams.drain() {
                entry.active.store(false, Ordering::Relaxed);
            }
        }
    }
}

/// Throttled PLI for one SSRC.
struct KeyframeAsker {
    pc: Weak<RTCPeerConnection>,
    ssrc: u32,
    last: Option<Instant>,
}

impl KeyframeAsker {
    async fn ask(&mut self) {
        let now = Instant::now();
        if self.last.is_some_and(|t| now.duration_since(t) < PLI_INTERVAL) {
            return;
        }
        self.last = Some(now);
        let Some(pc) = self.pc.upgrade() else { return };
        let pli = PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: self.ssrc,
        };
        if let Err(e) = pc.write_rtcp(&[Box::new(pli)]).await {
            eprintln!("[VideoRecv] PLI for ssrc {} failed: {e}", self.ssrc);
        }
    }
}

/// Reads one remote track until its stream is removed or the track ends.
async fn run_track(
    track: Arc<TrackRemote>,
    streams: Arc<Mutex<HashMap<u32, StreamEntry>>>,
    sink: FrameSink,
    pc: Weak<RTCPeerConnection>,
) {
    let ssrc = track.ssrc();
    let entry = streams.lock().ok().and_then(|s| s.get(&ssrc).cloned());
    let Some(entry) = entry else {
        eprintln!("[VideoRecv] track for unknown ssrc {ssrc}, ignoring");
        return;
    };
    eprintln!(
        "[VideoRecv] track started: ssrc={ssrc} pt={} -> stream {}",
        track.payload_type(),
        entry.stream_id
    );

    let mut asker = KeyframeAsker {
        pc,
        ssrc,
        last: None,
    };
    // A receiver that joins mid-stream can do nothing until a keyframe.
    asker.ask().await;

    let decoder = match DecodeSession::start(entry.stream_id, sink) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[VideoRecv] decoder for stream {} failed: {e}", entry.stream_id);
            return;
        }
    };

    let mut builder = SampleBuilder::new(256, Vp8Packet::default(), 90_000)
        .with_max_time_delay(Duration::from_millis(500));
    let mut have_keyframe = false;

    while entry.active.load(Ordering::Relaxed) {
        let packet = match tokio::time::timeout(Duration::from_secs(1), track.read_rtp()).await {
            Ok(Ok((packet, _))) => packet,
            Ok(Err(_)) => break, // track ended
            Err(_) => continue,  // idle (a still screen); re-check `active`
        };
        builder.push(packet);
        while let Some(sample) = builder.pop() {
            if sample.prev_dropped_packets > 0 {
                // Lost packets the NACKs could not recover: the picture is
                // corrupt until the next keyframe, so ask for one now.
                asker.ask().await;
            }
            if !have_keyframe {
                if !is_vp8_keyframe(&sample.data) {
                    asker.ask().await;
                    continue;
                }
                have_keyframe = true;
            }
            decoder.push(&sample.data);
        }
    }
    decoder.stop();
    eprintln!("[VideoRecv] track ended: ssrc={ssrc} stream {}", entry.stream_id);
}

/// VP8 → JPEG for one stream.
pub struct DecodeSession {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
}

impl DecodeSession {
    pub fn start(stream_id: u32, sink: FrameSink) -> Result<Self, String> {
        gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;
        let pipeline = gst::Pipeline::new();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&gst::Caps::builder("video/x-vp8").build())
            .is_live(true)
            .do_timestamp(true)
            .format(gst::Format::Time)
            .build();
        let decoder = make_element("vp8dec")?;
        // A frame decoded after unrecovered loss errors out; the next keyframe
        // fixes the picture, so never let errors stop the pipeline.
        if decoder.has_property("max-errors") {
            decoder.set_property("max-errors", -1i32);
        }
        let convert = make_element("videoconvert")?;
        let scale = make_element("videoscale")?;
        let jpegenc = make_element("jpegenc")?;
        jpegenc.set_property("quality", 80i32);
        let appsink = gst_app::AppSink::builder()
            .caps(&gst::Caps::builder("image/jpeg").build())
            .sync(false)
            .max_buffers(1)
            .drop(true)
            .build();

        let elements = [
            appsrc.upcast_ref::<gst::Element>(),
            &decoder,
            &convert,
            &scale,
            &jpegenc,
            appsink.upcast_ref::<gst::Element>(),
        ];
        pipeline
            .add_many(elements)
            .map_err(|e| format!("Failed to assemble decode pipeline: {e}"))?;
        gst::Element::link_many(elements)
            .map_err(|e| format!("Failed to link decode pipeline: {e}"))?;

        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let (w, h) = sample
                        .caps()
                        .and_then(|c| c.structure(0))
                        .map(|st| {
                            (
                                st.get::<i32>("width").unwrap_or(0).max(0) as u32,
                                st.get::<i32>("height").unwrap_or(0).max(0) as u32,
                            )
                        })
                        .unwrap_or((0, 0));
                    let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                    sink(frame_message(stream_id, w, h, map.as_slice()));
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("Failed to start decode pipeline: {e}"))?;
        Ok(Self { pipeline, appsrc })
    }

    pub fn push(&self, vp8_frame: &[u8]) {
        let buffer = gst::Buffer::from_mut_slice(vp8_frame.to_vec());
        let _ = self.appsrc.push_buffer(buffer);
    }

    pub fn stop(&self) {
        let _ = self.appsrc.end_of_stream();
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

impl Drop for DecodeSession {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::transport::tests::{mediasoup_params, sections};
    use crate::voice::video::tests::{frame, gst_available, vp8_track};
    use crate::voice::video::{VideoEncodeConfig, VideoSendSession};
    use serde_json::json;
    use webrtc::api::setting_engine::SettingEngine;
    use webrtc::api::APIBuilder;
    use webrtc::api::media_engine::MediaEngine;
    use webrtc::api::interceptor_registry::register_default_interceptors;
    use webrtc::interceptor::registry::Registry;
    use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
    use webrtc::track::track_local::TrackLocal;

    fn noop_sink() -> FrameSink {
        Arc::new(|_| {})
    }

    #[test]
    fn frame_header_layout() {
        let m = frame_message(7, 1920, 1080, &[0xFF, 0xD8]);
        assert_eq!(m.len(), FRAME_HEADER_BYTES + 2);
        assert_eq!(u32::from_le_bytes([m[0], m[1], m[2], m[3]]), 7);
        assert_eq!(u16::from_le_bytes([m[4], m[5]]), 1920);
        assert_eq!(u16::from_le_bytes([m[6], m[7]]), 1080);
        assert_eq!(&m[8..12], &[0, 0, 0, 0]);
        assert_eq!(&m[12..], &[0xFF, 0xD8]);
    }

    #[test]
    fn vp8_keyframe_bit() {
        assert!(is_vp8_keyframe(&[0x10, 0x02, 0x00]));
        assert!(!is_vp8_keyframe(&[0x11, 0x02, 0x00]));
        assert!(!is_vp8_keyframe(&[]));
    }

    /// m-lines are appended per consumer and go inactive on removal, never
    /// reused; the first add returns DTLS parameters and later ones do not.
    #[tokio::test(flavor = "multi_thread")]
    async fn consumers_append_mlines_and_retire_them_inactive() {
        if !gst_available() {
            eprintln!("skipping: GStreamer VP8 plugins not available");
            return;
        }
        let mut rx = VideoRecvController::new(&[], &mediasoup_params(), noop_sink());
        let (s1, dtls1) = rx.add_consumer("c1", 1111, 101, "a").await.expect("add c1");
        assert!(dtls1.is_some());
        assert_eq!(dtls1.as_ref().unwrap()["role"], "server");
        let (s2, dtls2) = rx.add_consumer("c2", 2222, 101, "b").await.expect("add c2");
        assert!(dtls2.is_none());
        assert_ne!(s1, s2);

        rx.remove_consumer("c1").await.expect("remove c1");
        let (s3, _) = rx.add_consumer("c3", 3333, 101, "c").await.expect("add c3");
        assert!(s3 != s1 && s3 != s2);

        let answer = rx.local_sdp().await.expect("answer");
        assert!(answer.contains("a=group:BUNDLE 0 1 2"), "{answer}");
        let secs = sections(&answer);
        assert_eq!(secs.len(), 3);
        assert!(secs[0].contains("a=inactive"), "{}", secs[0]);
        assert!(secs[1].contains("a=recvonly"), "{}", secs[1]);
        assert!(secs[2].contains("a=recvonly"), "{}", secs[2]);
        assert!(secs[1].contains("a=rtpmap:101 VP8/90000"), "{}", secs[1]);
        rx.close().await;
    }

    /// Converts a webrtc-rs offer into what mediasoup's createWebRtcTransport
    /// would have told us, plus the consumer's SSRC and payload type.
    fn as_mediasoup(sdp: &str) -> (Value, u32, u8) {
        let mut ufrag = "";
        let mut pwd = "";
        let mut fp = "";
        let mut cands = Vec::new();
        let mut ssrc = 0u32;
        let mut pt = 0u8;
        for line in sdp.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("a=ice-ufrag:") {
                ufrag = v;
            } else if let Some(v) = line.strip_prefix("a=ice-pwd:") {
                pwd = v;
            } else if let Some(v) = line.strip_prefix("a=fingerprint:sha-256 ") {
                fp = v;
            } else if let Some(v) = line.strip_prefix("a=candidate:") {
                let t: Vec<&str> = v.split_whitespace().collect();
                if t.len() >= 8 {
                    cands.push(json!({
                        "foundation": t[0],
                        "component": t[1].parse::<u64>().unwrap_or(1),
                        "protocol": t[2].to_lowercase(),
                        "priority": t[3].parse::<u64>().unwrap_or(0),
                        "address": t[4],
                        "port": t[5].parse::<u64>().unwrap_or(0),
                        "type": t[7],
                    }));
                }
            } else if let Some(v) = line.strip_prefix("a=ssrc:") {
                if ssrc == 0 {
                    ssrc = v.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
                }
            } else if let Some(v) = line.strip_prefix("a=rtpmap:") {
                if pt == 0 && v.contains("VP8/90000") {
                    pt = v.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
                }
            }
        }
        let params = json!({
            "iceParameters": { "usernameFragment": ufrag, "password": pwd },
            "iceCandidates": cands,
            "dtlsParameters": { "fingerprints": [{ "algorithm": "sha-256", "value": fp }] },
        });
        (params, ssrc, pt)
    }

    /// The end-to-end path on localhost: a webrtc-rs peer standing in for the
    /// SFU (ice-lite, offering one VP8 track) sends frames from the real
    /// encoder; the controller negotiates against what it offered, receives,
    /// depacketises, decodes and hands out JPEG frames.
    #[tokio::test(flavor = "multi_thread")]
    async fn loopback_send_to_recv_controller_produces_decoded_frames() {
        if !gst_available() {
            eprintln!("skipping: GStreamer VP8 plugins not available");
            return;
        }

        // The fake SFU.
        let mut media = MediaEngine::default();
        media.register_default_codecs().expect("codecs");
        let registry = register_default_interceptors(Registry::new(), &mut media).expect("ics");
        let mut settings = SettingEngine::default();
        settings.set_lite(true);
        settings.set_include_loopback_candidate(true);
        let sfu_api = APIBuilder::new()
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .with_setting_engine(settings)
            .build();
        let sfu = Arc::new(
            sfu_api
                .new_peer_connection(RTCConfiguration::default())
                .await
                .expect("sfu pc"),
        );
        let track = vp8_track();
        let sender = sfu
            .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .expect("track");
        // Drive the sender's interceptors (NACK responder, PLI) like the
        // native send path does.
        let plis = Arc::new(std::sync::atomic::AtomicU32::new(0));
        {
            let plis = plis.clone();
            tokio::spawn(async move {
                while let Ok((pkts, _)) = sender.read_rtcp().await {
                    for p in pkts {
                        if p.as_any().downcast_ref::<PictureLossIndication>().is_some() {
                            plis.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            });
        }
        let offer = sfu.create_offer(None).await.expect("offer");
        let mut gathered = sfu.gathering_complete_promise().await;
        sfu.set_local_description(offer).await.expect("local offer");
        let _ = gathered.recv().await;
        let sfu_offer = sfu.local_description().await.expect("offer sdp").sdp;
        let (params, ssrc, pt) = as_mediasoup(&sfu_offer);
        assert!(ssrc != 0 && pt != 0, "could not read the SFU offer:\n{sfu_offer}");

        // The receiver.
        let frames: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let frames = frames.clone();
            Arc::new(move |m| frames.lock().unwrap().push(m))
        };
        let mut rx = VideoRecvController::new(&[], &params, sink);
        let (stream_id, dtls) = rx
            .add_consumer("consumer-1", ssrc, pt, "kizuna")
            .await
            .expect("add consumer");
        assert_eq!(dtls.expect("first add returns DTLS")["role"], "server");

        // Hand the controller's answer to the SFU, as mediasoup would apply
        // the DTLS parameters from voice:connectTransport.
        let answer = rx.local_sdp().await.expect("answer");
        sfu.set_remote_description(RTCSessionDescription::answer(answer).expect("answer sdp"))
            .await
            .expect("sfu remote answer");

        // Encode and send.
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let mut enc = VideoSendSession::start(
            track,
            frame_rx,
            VideoEncodeConfig {
                fps: 15,
                start_bitrate_bps: 500_000,
                min_bitrate_bps: 300_000,
                max_bitrate_bps: 1_000_000,
                max_dimension: 1920,
                screen_content: false,
            },
        )
        .expect("encoder");
        let pump = std::thread::spawn(move || {
            for i in 0..150u32 {
                if frame_tx.send(frame(320, 240, (i * 3) as u8)).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(66));
            }
        });

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && frames.lock().unwrap().len() < 3 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let got = frames.lock().unwrap().clone();
        assert!(
            got.len() >= 3,
            "expected decoded frames, got {} (PLIs seen by sender: {})",
            got.len(),
            plis.load(Ordering::Relaxed)
        );
        let first = &got[0];
        assert_eq!(u32::from_le_bytes([first[0], first[1], first[2], first[3]]), stream_id);
        assert_eq!(u16::from_le_bytes([first[4], first[5]]), 320);
        assert_eq!(u16::from_le_bytes([first[6], first[7]]), 240);
        assert_eq!(&first[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 2], &[0xFF, 0xD8]);
        assert!(plis.load(Ordering::Relaxed) >= 1, "receiver never asked for a keyframe");

        rx.close().await;
        enc.stop();
        let _ = sfu.close().await;
        let _ = pump.join();
    }
}
