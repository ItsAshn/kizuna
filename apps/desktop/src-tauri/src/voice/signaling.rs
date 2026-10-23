use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::capture::VideoSource;

use super::dsp::AudioProcessor;
use super::encode::{self, AudioSendSession};
use super::rnnoise::NoiseSuppressionMode;
use super::transport::{self, VideoSendTrack};
use super::VoiceEvent;

/// What `voice_begin` hands the frontend: the DTLS parameters for
/// `voice:connectTransport` and the RTP parameters to `voice:produce` each
/// track with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinTransportParams {
    pub send_dtls: Value,
    pub audio: Value,
    pub screen: Value,
    pub camera: Value,
}

/// One outgoing video track and, while it is live, its encoder.
pub struct VideoSlot {
    pub track: Arc<TrackLocalStaticSample>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    #[cfg(target_os = "linux")]
    pub session: Option<super::video::VideoSendSession>,
    #[cfg(target_os = "linux")]
    pub rtcp: Option<tokio::task::JoinHandle<()>>,
}

impl VideoSlot {
    fn new(t: VideoSendTrack) -> Self {
        Self {
            track: t.track,
            sender: t.sender,
            #[cfg(target_os = "linux")]
            session: None,
            #[cfg(target_os = "linux")]
            rtcp: None,
        }
    }

    #[cfg(target_os = "linux")]
    fn stop(&mut self, source: VideoSource) {
        // Detach the capture sink before the encoder goes away so capture
        // threads stop handing frames to a dead pipeline.
        crate::capture::clear_video_sink(source);
        if let Some(handle) = self.rtcp.take() {
            handle.abort();
        }
        if let Some(mut session) = self.session.take() {
            session.stop();
        }
    }
}

pub struct ActiveCall {
    pub channel_id: String,
    pub send_pc: webrtc::peer_connection::RTCPeerConnection,
    pub voice_bitrate_kbps: u64,
    pub audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_send: Option<AudioSendSession>,
    pub processor: Option<Arc<tokio::sync::Mutex<AudioProcessor>>>,
    pub video: HashMap<VideoSource, VideoSlot>,
}

impl ActiveCall {
    pub async fn update_bitrate(&mut self, voice_bitrate_kbps: u64) {
        self.voice_bitrate_kbps = voice_bitrate_kbps;
        let bitrate_bps = (voice_bitrate_kbps * 1000) as u32;
        if let Some(ref audio_send) = self.audio_send {
            audio_send.update_bitrate(bitrate_bps);
        }
    }

    pub async fn set_gate_threshold(&self, threshold_db: f32) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_gate_threshold_db(threshold_db);
        }
    }

    pub async fn set_suppression_mode(&self, mode: NoiseSuppressionMode) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_suppression_mode(mode);
        }
    }

    pub async fn set_suppression_strength(&self, strength: f32) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_suppression_strength(strength);
        }
    }

    pub async fn set_auto_gain(&self, enabled: bool) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_agc_enabled(enabled);
        }
    }

    pub async fn set_gate_enabled(&self, enabled: bool) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_gate_enabled(enabled);
        }
    }

    pub async fn set_input_gain(&self, gain: f32) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_input_gain(gain);
        }
    }
}

impl Drop for ActiveCall {
    fn drop(&mut self) {
        if let Some(ref mut s) = self.audio_send {
            s.stop();
        }
        #[cfg(target_os = "linux")]
        for (source, slot) in self.video.iter_mut() {
            slot.stop(*source);
        }
        tokio::task::block_in_place(|| {
            tauri::async_runtime::block_on(async {
                let _ = self.send_pc.close().await;
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

    #[allow(dead_code)]
    pub fn video_track(&self, source: VideoSource) -> Option<Arc<TrackLocalStaticSample>> {
        self.active_call
            .as_ref()
            .and_then(|c| c.video.get(&source))
            .map(|slot| slot.track.clone())
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
    /// Builds the send transport and returns its DTLS parameters plus the RTP
    /// parameters each of its tracks is produced with.
    pub async fn begin_join(
        &mut self,
        channel_id: &str,
        ice_servers: Vec<Value>,
        send_params: Value,
        _recv_params: Value,
        voice_bitrate_kbps: u64,
    ) -> Result<JoinTransportParams, String> {
        eprintln!("[VoiceNative] begin_join channel={channel_id}");

        // A rejoin replaces the previous call; drop it (and its encoders)
        // before building the new transport.
        self.active_call = None;

        let send = transport::create_send_transport(&ice_servers, &send_params)
            .await
            .map_err(|e| {
                eprintln!("[VoiceNative] begin_join: transport setup failed: {e}");
                format!("Transport setup: {e}")
            })?;

        let params = send.audio_sender.get_parameters().await;
        let ssrc = params.encodings.first().map(|e| e.ssrc).unwrap_or(1);

        let rtp_params = json!({
            "codecs": [{
                "mimeType": "audio/opus",
                "payloadType": 111,
                "clockRate": 48000,
                "channels": 2,
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

        let mut video_params = HashMap::new();
        let mut video = HashMap::new();
        for (source, t) in send.video {
            let p = t.sender.get_parameters().await;
            let video_ssrc = p.encodings.first().map(|e| e.ssrc).unwrap_or(0);
            let max = match source {
                VideoSource::Screen => super::SCREEN_SHARE_MAX_BITRATE_BPS,
                VideoSource::Camera => super::CAMERA_MAX_BITRATE_BPS,
            };
            video_params.insert(source, transport::video_rtp_parameters(video_ssrc, max));
            video.insert(source, VideoSlot::new(t));
        }

        self.active_call = Some(ActiveCall {
            channel_id: channel_id.to_string(),
            send_pc: send.pc,
            voice_bitrate_kbps,
            audio_track: Some(send.audio_track),
            audio_send: None,
            processor: None,
            video,
        });

        let screen = video_params.remove(&VideoSource::Screen).unwrap_or(Value::Null);
        let camera = video_params.remove(&VideoSource::Camera).unwrap_or(Value::Null);
        eprintln!(
            "[VoiceNative] begin_join OK: audio_ssrc={ssrc} screen_ssrc={} camera_ssrc={} dtls_role={}",
            screen["encodings"][0]["ssrc"], camera["encodings"][0]["ssrc"], send.dtls["role"]
        );
        Ok(JoinTransportParams {
            send_dtls: send.dtls,
            audio: rtp_params,
            screen,
            camera,
        })
    }

    /// Called after TypeScript has sent connectTransport + produce successfully.
    /// Starts audio capture and encoding.
    #[allow(clippy::too_many_arguments)]
    pub async fn finish_join(
        &mut self,
        voice_bitrate_kbps: u64,
        gate_enabled: bool,
        gate_threshold_db: f32,
        suppression_enabled: bool,
        suppression_strength: f32,
        auto_gain_enabled: bool,
        device_id: Option<String>,
        muted: bool,
    ) -> Result<(), String> {
        let call = self.active_call.as_mut().ok_or("No active call")?;
        let audio_track = call.audio_track.take().ok_or("No audio track")?;

        eprintln!("[VoiceNative] finish_join bitrate={voice_bitrate_kbps}kbps gate_enabled={gate_enabled} gate_threshold_db={gate_threshold_db} suppression_enabled={suppression_enabled} suppression_strength={suppression_strength} agc_enabled={auto_gain_enabled} device_id={device_id:?} muted={muted}");

        let bitrate_bps = (voice_bitrate_kbps * 1000) as u32;
        let encoder = encode::AudioEncoder::new(48000, 1, bitrate_bps)
            .map_err(|e| format!("Opus encoder: {e}"))?;

        let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();
        let (speaking_tx, mut speaking_rx) = mpsc::unbounded_channel::<encode::SpeakingEvent>();

        let capture = encode::start_native_audio_capture(device_id, 48000, pcm_tx)?;

        let mut processor = AudioProcessor::new(48000);
        // Start muted when the user is muted or on push-to-talk. The first
        // captured frame goes through the processor before JS gets a chance to
        // call voice_set_muted, so applying it afterwards let a moment of open
        // mic reach the channel on every join.
        processor.set_muted(muted);
        processor.set_gate_enabled(gate_enabled);
        processor.set_gate_threshold_db(gate_threshold_db);
        if suppression_enabled {
            // Use RNNoise (DNN-based). The legacy `Spectral` multiband suppressor
            // colors the voice (non-reconstructing crossover) and tracks speech as
            // noise, making audio robotic/choppy. See voice/dsp.rs SpectralGate.
            processor.set_suppression_mode(NoiseSuppressionMode::Rnnoise);
        }
        processor.set_suppression_strength(suppression_strength);
        processor.set_agc_enabled(auto_gain_enabled);

        let audio_send = AudioSendSession::new(
            encoder,
            audio_track,
            pcm_rx,
            capture,
            speaking_tx,
            processor,
            bitrate_bps,
        );

        call.processor = Some(audio_send.processor());

        // Relay speaking state + audio level to TypeScript via Tauri event
        let app = self.app.clone();
        let channel_id = call.channel_id.clone();
        tokio::spawn(async move {
            while let Some((speaking, rms)) = speaking_rx.recv().await {
                let _ = app.emit("voice:speaking", json!({
                    "channelId": channel_id,
                    "speaking": speaking,
                    "level": rms,
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
    pub async fn add_remote_peer(&self, peer_id: &str, ssrc: u32) {
        eprintln!("[VoiceNative] add_remote_peer: {peer_id} ssrc={ssrc}");
    }

    pub async fn flush_peers(&self) {
        // No-op: receive handled via DirectTransport + Socket.IO RTP forwarding
    }

    pub fn update_bitrate(&mut self, voice_bitrate_kbps: u64) {
        if let Some(ref mut call) = self.active_call {
            call.voice_bitrate_kbps = voice_bitrate_kbps;
            let bitrate_bps = (voice_bitrate_kbps * 1000) as u32;
            if let Some(ref audio_send) = call.audio_send {
                audio_send.update_bitrate(bitrate_bps);
            }
            eprintln!("[VoiceNative] update_bitrate: {voice_bitrate_kbps}kbps");
        }
    }

    pub async fn set_gate_threshold(&self, threshold_db: f32) {
        if let Some(ref call) = self.active_call {
            call.set_gate_threshold(threshold_db).await;
        }
    }

    pub async fn set_noise_suppression(&self, enabled: bool) {
        let mode = if enabled {
            NoiseSuppressionMode::Rnnoise
        } else {
            NoiseSuppressionMode::Off
        };
        if let Some(ref call) = self.active_call {
            call.set_suppression_mode(mode).await;
        }
    }

    pub async fn set_suppression_mode(&self, mode: NoiseSuppressionMode) {
        if let Some(ref call) = self.active_call {
            call.set_suppression_mode(mode).await;
        }
    }

    pub async fn set_suppression_strength(&self, strength: f32) {
        if let Some(ref call) = self.active_call {
            call.set_suppression_strength(strength).await;
        }
    }

    pub async fn set_auto_gain(&self, enabled: bool) {
        if let Some(ref call) = self.active_call {
            call.set_auto_gain(enabled).await;
        }
    }

    pub async fn set_gate_enabled(&self, enabled: bool) {
        if let Some(ref call) = self.active_call {
            call.set_gate_enabled(enabled).await;
        }
    }

    pub async fn set_input_gain(&self, gain: f32) {
        if let Some(ref call) = self.active_call {
            call.set_input_gain(gain).await;
        }
    }

    /// Starts encoding captured frames for `source` onto its video track. The
    /// caller is responsible for having produced the track on the server, and
    /// for starting the capture session that fills the sink.
    #[cfg(target_os = "linux")]
    pub fn start_video(
        &mut self,
        source: VideoSource,
        fps: u32,
        start_bitrate_bps: Option<u32>,
    ) -> Result<(), String> {
        use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
        use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        use webrtc::rtcp::receiver_report::ReceiverReport;
        use webrtc::rtcp::sender_report::SenderReport;

        let call = self
            .active_call
            .as_mut()
            .ok_or("Not connected to a voice channel")?;
        let slot = call
            .video
            .get_mut(&source)
            .ok_or("This call has no video track for that source")?;
        if slot.session.is_some() {
            return Err(format!("{} video is already active", source.as_str()));
        }

        let mut cfg = super::video::VideoEncodeConfig::for_source(source, fps.max(1));
        if let Some(bps) = start_bitrate_bps {
            cfg.start_bitrate_bps = bps;
        }

        // Two frames of slack: enough to absorb a scheduling hiccup, small
        // enough that a slow encoder drops frames instead of adding latency.
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let session = super::video::VideoSendSession::start(slot.track.clone(), frame_rx, cfg)?;

        // Reading the sender's RTCP also drives its interceptors (the NACK
        // responder retransmits from here). PLI/FIR force a keyframe; receiver
        // reports for our SSRC feed the loss-based bitrate controller.
        let requester = session.keyframe_requester();
        let bitrate = session.bitrate_handle();
        let sender = slot.sender.clone();
        let rtcp = tokio::spawn(async move {
            let ssrc = sender
                .get_parameters()
                .await
                .encodings
                .first()
                .map(|e| e.ssrc)
                .unwrap_or(0);
            let on_reports = |reports: &[webrtc::rtcp::reception_report::ReceptionReport]| {
                for r in reports.iter().filter(|r| r.ssrc == ssrc) {
                    let before = bitrate.get();
                    let after = bitrate.on_loss_report(r.fraction_lost);
                    if before != after && (before.abs_diff(after) * 10 > before) {
                        eprintln!(
                            "[VoiceNative] {} bitrate {}kbps -> {}kbps (loss {}/256)",
                            source.as_str(),
                            before / 1000,
                            after / 1000,
                            r.fraction_lost
                        );
                    }
                }
            };
            while let Ok((packets, _)) = sender.read_rtcp().await {
                for packet in packets {
                    let any = packet.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        requester.request();
                    } else if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                        on_reports(&rr.reports);
                    } else if let Some(sr) = any.downcast_ref::<SenderReport>() {
                        on_reports(&sr.reports);
                    }
                }
            }
        });

        crate::capture::set_video_sink(source, frame_tx);
        slot.session = Some(session);
        slot.rtcp = Some(rtcp);
        eprintln!("[VoiceNative] {} video encoding started", source.as_str());
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn stop_video(&mut self, source: VideoSource) {
        // Detach the sink first: capture threads then stop producing frames for
        // a pipeline that is about to be torn down.
        crate::capture::clear_video_sink(source);
        if let Some(slot) = self
            .active_call
            .as_mut()
            .and_then(|call| call.video.get_mut(&source))
        {
            slot.stop(source);
        }
        eprintln!("[VoiceNative] {} video encoding stopped", source.as_str());
    }

    #[cfg(target_os = "linux")]
    pub fn start_screen_share(&mut self, fps: u32, bitrate_bps: Option<u32>) -> Result<(), String> {
        self.start_video(VideoSource::Screen, fps, bitrate_bps)
    }

    #[cfg(target_os = "linux")]
    pub fn stop_screen_share(&mut self) {
        self.stop_video(VideoSource::Screen)
    }

    pub async fn set_muted(&self, muted: bool) {
        if let Some(ref call) = self.active_call {
            if let Some(ref proc) = call.processor {
                let mut p = proc.lock().await;
                p.set_muted(muted);
            }
        }
    }
}
