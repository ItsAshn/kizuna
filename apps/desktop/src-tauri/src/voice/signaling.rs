use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::RTCRtpCodingParameters;
use webrtc::rtp_transceiver::RTCRtpReceiveParameters;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use super::dsp::AudioProcessor;
use super::encode::{self, AudioSendSession};
use super::transport;
use super::VoiceEvent;

pub struct ActiveCall {
    pub channel_id: String,
    pub send_pc: webrtc::peer_connection::RTCPeerConnection,
    pub recv_pc: webrtc::peer_connection::RTCPeerConnection,
    pub pending_recv: Arc<tokio::sync::Mutex<Vec<String>>>,
    pub pending_tracks: Arc<tokio::sync::Mutex<Vec<Arc<TrackRemote>>>>,
    pub router_caps: Value,
    pub voice_bitrate_kbps: u64,
    pub audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_send: Option<AudioSendSession>,
    pub processor: Option<Arc<tokio::sync::Mutex<AudioProcessor>>>,
    pub buffered_peers: Arc<tokio::sync::Mutex<Vec<(String, u32)>>>,
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

    pub async fn set_noise_suppression(&self, enabled: bool) {
        if let Some(ref proc) = self.processor {
            let mut p = proc.lock().await;
            p.set_suppression_enabled(enabled);
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
        voice_bitrate_kbps: u64,
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

        self.active_call = Some(ActiveCall {
            channel_id: channel_id.to_string(),
            send_pc: transport_pair.send_pc,
            recv_pc: transport_pair.recv_pc,
            pending_recv: transport_pair.pending_recv,
            pending_tracks: transport_pair.pending_tracks,
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
            voice_bitrate_kbps,
            audio_track: Some(transport_pair.audio_track),
            audio_send: None,
            processor: None,
            buffered_peers: Arc::new(tokio::sync::Mutex::new(Vec::new())),
        });

        eprintln!("[VoiceNative] begin_join OK: ssrc={ssrc}");
        Ok((send_dtls, recv_dtls, rtp_params))
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
        let (speaking_tx, mut speaking_rx) = mpsc::unbounded_channel::<bool>();

        let cancel = Arc::new(AtomicBool::new(false));
        let stream = encode::start_native_audio_capture(
            device_id, 48000, 1, pcm_tx, cancel.clone(),
        )?;

        let mut processor = AudioProcessor::new(48000);
        processor.set_gate_enabled(gate_enabled);
        processor.set_gate_threshold_db(gate_threshold_db);
        processor.set_suppression_enabled(suppression_enabled);
        processor.set_suppression_strength(suppression_strength);
        processor.set_agc_enabled(auto_gain_enabled);

        let audio_send = AudioSendSession::new(
            encoder,
            audio_track,
            pcm_rx,
            stream,
            speaking_tx,
            processor,
            bitrate_bps,
        );

        call.processor = Some(audio_send.processor());

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
    /// Buffers the peer info. Call flush_peers() after all peers are buffered.
    pub async fn add_remote_peer(&self, peer_id: &str, ssrc: u32) {
        if let Some(ref call) = self.active_call {
            call.buffered_peers.lock().await.push((peer_id.to_string(), ssrc));
            eprintln!("[VoiceNative] add_remote_peer: {peer_id} ssrc={ssrc}");
        }
    }

    /// Flushes buffered peers: waits for DTLS, calls receive() once with all SSRCs,
    /// then spawns AudioRecvSession for each track.
    pub async fn flush_peers(&self) {
        let call = match self.active_call.as_ref() {
            Some(c) => c,
            None => return,
        };

        let buffered = {
            let mut guard = call.buffered_peers.lock().await;
            std::mem::take(&mut *guard)
        };
        if buffered.is_empty() {
            return;
        }

        eprintln!("[VoiceNative] flush_peers: waiting for DTLS ({} peers buffered)", buffered.len());

        let receiver = {
            let transceivers = call.recv_pc.get_transceivers().await;
            let mut found = None;
            for t in &transceivers {
                if t.kind() == RTPCodecType::Audio {
                    found = Some(t.receiver().await);
                    break;
                }
            }
            match found {
                Some(r) => r,
                None => {
                    eprintln!("[VoiceNative] flush_peers: no audio transceiver found");
                    return;
                }
            }
        };

        let encodings: Vec<RTCRtpCodingParameters> = buffered
            .iter()
            .map(|(_, ssrc)| RTCRtpCodingParameters {
                ssrc: *ssrc,
                ..Default::default()
            })
            .collect();

        let receive_params = RTCRtpReceiveParameters { encodings };

        // Wait for ICE to connect and DTLS to start before calling receive()
        for i in 0..40 {
            let ice_state = call.recv_pc.ice_connection_state();
            let connected = matches!(
                ice_state,
                webrtc::ice_transport::ice_connection_state::RTCIceConnectionState::Connected
                    | webrtc::ice_transport::ice_connection_state::RTCIceConnectionState::Completed
            );
            if connected && i >= 5 {
                // Give DTLS an extra half-second after ICE connects
                eprintln!("[VoiceNative] flush_peers: ICE connected, waiting a bit more for DTLS...");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                break;
            }
            if i == 0 {
                eprintln!("[VoiceNative] flush_peers: waiting for ICE (state={:?})...", ice_state);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        match receiver.receive(&receive_params).await {
            Ok(()) => {
                eprintln!("[VoiceNative] flush_peers: receive OK for {} peers", buffered.len());
            }
            Err(e) => {
                eprintln!("[VoiceNative] flush_peers: receiver.receive failed: {e}");
                return;
            }
        }

        let tracks = receiver.tracks().await;
        eprintln!("[VoiceNative] flush_peers: got {} tracks for {} peers", tracks.len(), buffered.len());

        for (i, (pid, _)) in buffered.into_iter().enumerate() {
            if i < tracks.len() {
                eprintln!("[VoiceNative] flush_peers: spawning AudioRecvSession for peer={pid} track_index={i}");
                let app = self.app.clone();
                let track = tracks[i].clone();
                tokio::spawn(async move {
                    encode::AudioRecvSession::spawn(app, pid, track);
                });
            } else {
                eprintln!("[VoiceNative] flush_peers: no track for peer={pid}");
            }
        }
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
        if let Some(ref call) = self.active_call {
            call.set_noise_suppression(enabled).await;
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
}
