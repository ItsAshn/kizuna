use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::dsp::AudioProcessor;
use super::encode::{self, AudioSendSession};
use super::rnnoise::NoiseSuppressionMode;
use super::transport;
use super::VoiceEvent;

pub struct ActiveCall {
    pub channel_id: String,
    pub send_pc: webrtc::peer_connection::RTCPeerConnection,
    pub voice_bitrate_kbps: u64,
    pub audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub video_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_send: Option<AudioSendSession>,
    pub processor: Option<Arc<tokio::sync::Mutex<AudioProcessor>>>,
    #[cfg(target_os = "linux")]
    pub video_sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    #[cfg(target_os = "linux")]
    pub video_send: Option<super::video::VideoSendSession>,
    #[cfg(target_os = "linux")]
    pub video_rtcp: Option<tokio::task::JoinHandle<()>>,
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
}

impl Drop for ActiveCall {
    fn drop(&mut self) {
        if let Some(ref mut s) = self.audio_send {
            s.stop();
        }
        #[cfg(target_os = "linux")]
        {
            // Detach the capture sink before the encoder goes away so capture
            // threads stop handing frames to a dead pipeline.
            crate::capture::clear_video_sink();
            if let Some(handle) = self.video_rtcp.take() {
                handle.abort();
            }
            if let Some(ref mut s) = self.video_send {
                s.stop();
            }
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

    pub fn video_track(&self) -> Option<Arc<TrackLocalStaticSample>> {
        self.active_call.as_ref().and_then(|c| c.video_track.clone())
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
    /// Returns DTLS params (send_dtls, null, null) and RTP parameters for produce.
    pub async fn begin_join(
        &mut self,
        channel_id: &str,
        ice_servers: Vec<Value>,
        send_params: Value,
        recv_params: Value,
        voice_bitrate_kbps: u64,
    ) -> Result<(Value, Value, Value, Value), String> {
        eprintln!("[VoiceNative] begin_join channel={channel_id}");

        let (transport_pair, send_dtls) =
            transport::create_transports(
                &ice_servers,
                &send_params,
            )
            .await
            .map_err(|e| {
                eprintln!("[VoiceNative] begin_join: transport setup failed: {e}");
                format!("Transport setup: {e}")
            })?;

        let _ = recv_params;

        let rtp_sender = transport_pair.audio_sender.clone();
        let params = rtp_sender.get_parameters().await;
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

        let video_sender = transport_pair.video_sender.clone();
        let video_params = video_sender.get_parameters().await;
        let video_ssrc = video_params.encodings.first().map(|e| e.ssrc).unwrap_or(2);

        let video_rtp_params = json!({
            "codecs": [{
                "mimeType": "video/VP8",
                "payloadType": 100,
                "clockRate": 90000,
                "channels": 0,
                "parameters": {},
                "rtcpFeedback": [],
            }],
            "headerExtensions": [],
            "encodings": [{
                "ssrc": video_ssrc,
                "maxBitrate": super::SCREEN_SHARE_BITRATE_BPS,
            }],
            "rtcp": {
                "cname": "",
                "reducedSize": true,
            },
        });

        self.active_call = Some(ActiveCall {
            channel_id: channel_id.to_string(),
            send_pc: transport_pair.send_pc,
            voice_bitrate_kbps,
            audio_track: Some(transport_pair.audio_track),
            video_track: Some(transport_pair.video_track),
            audio_send: None,
            processor: None,
            #[cfg(target_os = "linux")]
            video_sender,
            #[cfg(target_os = "linux")]
            video_send: None,
            #[cfg(target_os = "linux")]
            video_rtcp: None,
        });

        eprintln!("[VoiceNative] begin_join OK: audio_ssrc={ssrc} video_ssrc={video_ssrc}");
        Ok((send_dtls, json!({}), rtp_params, video_rtp_params))
    }

    /// Called after TypeScript has sent connectTransport + produce successfully.
    /// Starts audio capture and encoding.
    pub async fn finish_join(
        &mut self,
        voice_bitrate_kbps: u64,
        gate_enabled: bool,
        gate_threshold_db: f32,
        suppression_enabled: bool,
        suppression_strength: f32,
        auto_gain_enabled: bool,
        device_id: Option<String>,
    ) -> Result<(), String> {
        let call = self.active_call.as_mut().ok_or("No active call")?;
        let audio_track = call.audio_track.take().ok_or("No audio track")?;

        eprintln!("[VoiceNative] finish_join bitrate={voice_bitrate_kbps}kbps gate_enabled={gate_enabled} gate_threshold_db={gate_threshold_db} suppression_enabled={suppression_enabled} suppression_strength={suppression_strength} agc_enabled={auto_gain_enabled} device_id={device_id:?}");

        let bitrate_bps = (voice_bitrate_kbps * 1000) as u32;
        let encoder = encode::AudioEncoder::new(48000, 1, bitrate_bps)
            .map_err(|e| format!("Opus encoder: {e}"))?;

        let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();
        let (speaking_tx, mut speaking_rx) = mpsc::unbounded_channel::<encode::SpeakingEvent>();

        let cancel = Arc::new(AtomicBool::new(false));
        let cpal_stream = encode::start_native_audio_capture(
            device_id, 48000, 1, pcm_tx, cancel.clone(),
        )?;

        let mut processor = AudioProcessor::new(48000);
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
            cpal_stream,
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

    /// Starts encoding captured screen frames onto the call's video track.
    /// The caller is responsible for having produced the video track on the
    /// server first, and for starting the capture session that fills the sink.
    #[cfg(target_os = "linux")]
    pub fn start_screen_share(&mut self, fps: u32, bitrate_bps: u32) -> Result<(), String> {
        use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
        use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;

        let call = self
            .active_call
            .as_mut()
            .ok_or("Not connected to a voice channel")?;
        if call.video_send.is_some() {
            return Err("Screen share is already active".into());
        }
        let track = call
            .video_track
            .clone()
            .ok_or("This call has no video track")?;

        // Two frames of slack: enough to absorb a scheduling hiccup, small
        // enough that a slow encoder drops frames instead of adding latency.
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let session = super::video::VideoSendSession::start(track, frame_rx, bitrate_bps, fps)?;

        let requester = session.keyframe_requester();
        let video_sender = call.video_sender.clone();
        let rtcp = tokio::spawn(async move {
            while let Ok((packets, _)) = video_sender.read_rtcp().await {
                for packet in packets {
                    let any = packet.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        requester.request();
                    }
                }
            }
        });

        crate::capture::set_video_sink(frame_tx);
        call.video_send = Some(session);
        call.video_rtcp = Some(rtcp);
        eprintln!("[VoiceNative] screen share encoding started");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn stop_screen_share(&mut self) {
        // Detach the sink first: capture threads then stop producing frames for
        // a pipeline that is about to be torn down.
        crate::capture::clear_video_sink();
        if let Some(call) = self.active_call.as_mut() {
            if let Some(handle) = call.video_rtcp.take() {
                handle.abort();
            }
            if let Some(mut session) = call.video_send.take() {
                session.stop();
            }
        }
        eprintln!("[VoiceNative] screen share encoding stopped");
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
