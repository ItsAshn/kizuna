use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus::{Channels, Decoder as OpusDecoder, Encoder as OpusEncoder};
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

pub fn start_native_audio_capture(
    device_name: Option<String>,
    sample_rate: u32,
    channels: u16,
    pcm_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();

    let device = if let Some(ref name) = device_name {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
            .find(|d| {
                d.description()
                    .map(|desc| desc.name() == *name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Input device '{}' not found", name))?
    } else {
        host.default_input_device()
            .ok_or("No input device found")?
    };

    let config = cpal::StreamConfig {
        channels,
        sample_rate: sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    let err_fn = |err| {
        eprintln!("[AudioCapture] cpal error: {err}");
    };

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _info| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let _ = pcm_tx.send(data.to_vec());
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {e}"))?;

    Ok(stream)
}

pub struct AudioEncoder {
    encoder: OpusEncoder,
    sample_rate: u32,
    frame_size: usize,
    #[allow(dead_code)]
    running: Arc<AtomicBool>,
}

impl AudioEncoder {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, String> {
        let ch = if channels == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        };

        let encoder = OpusEncoder::new(sample_rate, ch, opus::Application::Voip)
            .map_err(|e| format!("Failed to create Opus encoder: {e}"))?;

        let frame_size = (sample_rate as usize * 20) / 1000;

        Ok(Self {
            encoder,
            sample_rate,
            frame_size,
            running: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn encode_frame(&mut self, pcm: &[f32]) -> Result<Vec<u8>, String> {
        let max_size = 4096;
        self.encoder
            .encode_vec_float(pcm, max_size)
            .map_err(|e| format!("Opus encode failed: {e}"))
    }

    pub fn frame_size_samples(&self) -> usize {
        self.frame_size
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

pub struct AudioSendSession {
    cancel: Arc<AtomicBool>,
    handle: Option<tokio::task::JoinHandle<()>>,
    _stream: Option<cpal::Stream>,
}

impl AudioSendSession {
    pub fn new(
        encoder: AudioEncoder,
        track: Arc<TrackLocalStaticSample>,
        pcm_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
        cpal_stream: cpal::Stream,
        speaking_tx: tokio::sync::mpsc::UnboundedSender<bool>,
    ) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        let handle = tokio::spawn(async move {
            let _ = run_audio_send(encoder, track, pcm_rx, cancel_clone, speaking_tx).await;
        });

        Self {
            cancel,
            handle: Some(handle),
            _stream: Some(cpal_stream),
        }
    }

    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.handle = None;
        self._stream = None;
    }
}

async fn run_audio_send(
    mut encoder: AudioEncoder,
    track: Arc<TrackLocalStaticSample>,
    mut pcm_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
    cancel: Arc<AtomicBool>,
    speaking_tx: tokio::sync::mpsc::UnboundedSender<bool>,
) -> Result<(), String> {
    let frame_duration =
        Duration::from_secs_f64(encoder.frame_size_samples() as f64 / encoder.sample_rate() as f64);

    let mut pcm_buffer: Vec<f32> = Vec::new();
    let frame_size = encoder.frame_size_samples();
    let mut seq = 0u32;
    let mut is_speaking = false;
    let mut silence_frames = 0u32;
    let hold_frames = 30u32; // ~600ms at 20ms frames
    let threshold = 0.01f32; // RMS threshold for speaking

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        match pcm_rx.recv().await {
            Some(samples) => {
                pcm_buffer.extend_from_slice(&samples);

                while pcm_buffer.len() >= frame_size {
                    let frame: Vec<f32> = pcm_buffer.drain(..frame_size).collect();

                    // VAD: compute RMS
                    let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame_size as f32).sqrt();
                    let speaking = rms > threshold;

                    if speaking && !is_speaking {
                        is_speaking = true;
                        silence_frames = 0;
                        let _ = speaking_tx.send(true);
                    } else if speaking {
                        silence_frames = 0;
                    } else if is_speaking {
                        silence_frames += 1;
                        if silence_frames >= hold_frames {
                            is_speaking = false;
                            let _ = speaking_tx.send(false);
                        }
                    }

                    match encoder.encode_frame(&frame) {
                        Ok(opus_data) => {
                            let sample = Sample {
                                data: bytes::Bytes::from(opus_data),
                                timestamp: SystemTime::now(),
                                duration: frame_duration,
                                packet_timestamp: seq
                                    .wrapping_mul(frame_size as u32),
                                prev_dropped_packets: 0,
                                prev_padding_packets: 0,
                            };

                            if let Err(e) = track.write_sample(&sample).await {
                                eprintln!("[AudioSend] write_sample error: {e}");
                                break;
                            }
                            seq += 1;
                        }
                        Err(e) => {
                            eprintln!("[AudioSend] encode error: {e}");
                        }
                    }
                }
            }
            None => {
                break;
            }
        }
    }

    Ok(())
}

impl Drop for AudioSendSession {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct AudioDecoder {
    decoder: OpusDecoder,
    sample_rate: u32,
}

impl AudioDecoder {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, String> {
        let ch = if channels == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        };
        let decoder = OpusDecoder::new(sample_rate, ch)
            .map_err(|e| format!("Failed to create Opus decoder: {e}"))?;
        Ok(Self {
            decoder,
            sample_rate,
        })
    }

    pub fn decode(&mut self, opus_data: &[u8]) -> Result<Vec<f32>, String> {
        let frame_size = (self.sample_rate as usize * 60) / 1000;
        let mut pcm = vec![0.0f32; frame_size * 2];
        let samples = self
            .decoder
            .decode_float(opus_data, &mut pcm, false)
            .map_err(|e| format!("Opus decode failed: {e}"))?;
        pcm.truncate(samples * 2);
        Ok(pcm)
    }
}

pub struct AudioRecvSession {
    cancel: Arc<AtomicBool>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl AudioRecvSession {
    pub fn spawn(
        app: tauri::AppHandle,
        peer_id: String,
        track: Arc<webrtc::track::track_remote::TrackRemote>,
    ) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        let handle = tokio::spawn(async move {
            let _ = run_audio_recv(app, peer_id, track, cancel_clone).await;
        });

        Self {
            cancel,
            handle: Some(handle),
        }
    }

    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.handle = None;
    }
}

async fn run_audio_recv(
    app: tauri::AppHandle,
    peer_id: String,
    track: Arc<webrtc::track::track_remote::TrackRemote>,
    cancel: Arc<AtomicBool>,
) {
    use tauri::Emitter;

    let mut decoder = match AudioDecoder::new(48000, 2) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[AudioRecv] Failed to create decoder: {e}");
            return;
        }
    };

    let mut buf = vec![0u8; 4096];

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        match track.read(&mut buf).await {
            Ok((packet, _attrs)) => {
                let opus_data = &packet.payload;
                if opus_data.is_empty() {
                    continue;
                }

                match decoder.decode(opus_data) {
                    Ok(pcm) => {
                        let _ = app.emit(
                            "voice:remote_audio",
                            serde_json::json!({
                                "peerId": peer_id,
                                "samples": pcm,
                                "sampleRate": 48000,
                            }),
                        );
                    }
                    Err(e) => {
                        eprintln!("[AudioRecv] Decode error: {e}");
                    }
                }
            }
            Err(e) => {
                eprintln!("[AudioRecv] read error: {e}");
                break;
            }
        }
    }
}

impl Drop for AudioRecvSession {
    fn drop(&mut self) {
        self.stop();
    }
}
