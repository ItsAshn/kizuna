use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus2::{Channels, Decoder as OpusDecoder, Encoder as OpusEncoder};
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::dsp::AudioProcessor;

pub fn start_native_audio_capture(
    device_id: Option<String>,
    sample_rate: u32,
    channels: u16,
    pcm_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();

    // If a specific device was requested, try only that
    if let Some(ref id) = device_id {
        let device = host
            .input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
            .find(|d| {
                d.id()
                    .map(|i| i.to_string() == *id)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Input device '{}' not found", id))?;

        return open_device(&device, sample_rate, channels, &pcm_tx, &cancel)
            .map(|s| { eprintln!("[AudioCapture] using specific device: {id}"); s });
    }

    // On Linux/ALSA, sound server devices (PipeWire/PulseAudio) are far more
    // reliable than the raw ALSA default device, which often opens successfully
    // but produces silence through the dmix/dsnoop plugin chain. Try them first.
    let host_id = host.id();
    let is_alsa = format!("{:?}", host_id).to_lowercase().contains("alsa");

    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
        .collect();

    // Pass 1 (Linux/ALSA only): try sound server devices first since they use
    // proper audio routing through the system sound server.
    if is_alsa {
        for device in &devices {
            let dname = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| "unknown".into());
            let lower = dname.to_lowercase();
            if lower.contains("pipewire sound server")
                || lower.contains("pulseaudio sound server")
            {
                match open_device(device, sample_rate, channels, &pcm_tx, &cancel) {
                    Ok(stream) => {
                        eprintln!("[AudioCapture] using sound server device: {dname}");
                        return Ok(stream);
                    }
                    Err(e) => {
                        eprintln!("[AudioCapture] sound server device '{dname}' failed: {e}");
                    }
                }
            }
        }
    }

    // Try default device
    if let Some(default_device) = host.default_input_device() {
        match open_device(&default_device, sample_rate, channels, &pcm_tx, &cancel) {
            Ok(stream) => {
                let dname = default_device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "default".into());
                eprintln!("[AudioCapture] using default device: {dname}");
                return Ok(stream);
            }
            Err(e) => {
                eprintln!("[AudioCapture] default device failed: {e} (will try other devices)");
            }
        }
    }

    // Fall back to any available input device, skipping obvious non-microphones.
    let mut sound_server_found = false;
    let mut hardware_found = false;

    // Pass 2: try sound server devices (pipewire, pulseaudio) — they may work
    // even when the ALSA pipewire plugin is broken because they use different
    // plugins (libasound_module_pcm_pulse.so etc.)
    if !is_alsa {
        for device in &devices {
            let dname = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| "unknown".into());

            let lower = dname.to_lowercase();
            if lower.contains("pipewire sound server")
                || lower.contains("pulseaudio sound server")
            {
                sound_server_found = true;
                match open_device(device, sample_rate, channels, &pcm_tx, &cancel) {
                    Ok(stream) => {
                        eprintln!("[AudioCapture] using sound server device: {dname}");
                        return Ok(stream);
                    }
                    Err(e) => {
                        eprintln!("[AudioCapture] sound server device '{dname}' failed: {e}");
                    }
                }
            }
        }
    }

    // Pass 3: try remaining real hardware devices
    for device in &devices {
        let dname = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "unknown".into());

        let lower = dname.to_lowercase();
        // Skip virtual dummy devices and already-tried sound server devices
        if lower.contains("discard") || lower.contains("rate converter")
            || lower.contains("plugin for") || lower.contains("jack audio")
            || lower.contains("open sound") || lower.contains("speex")
            || lower.contains("upmix") || lower.contains("downmix")
            || (lower.contains("output") && !lower.contains("wave") && !lower.contains("usb"))
            || lower.contains("pipewire sound server")
            || lower.contains("pulseaudio sound server")
        {
            eprintln!("[AudioCapture] skipped virtual device: {dname}");
            continue;
        }

        hardware_found = true;
        match open_device(device, sample_rate, channels, &pcm_tx, &cancel) {
            Ok(stream) => {
                eprintln!("[AudioCapture] using fallback device: {dname}");
                return Ok(stream);
            }
            Err(e) => {
                eprintln!("[AudioCapture] trying next device '{dname}' (error: {e})");
            }
        }
    }

    if !sound_server_found && !hardware_found {
        return Err("No audio input devices found".into());
    }

    Err("No working audio input device found".into())
}

fn open_device(
    device: &cpal::Device,
    sample_rate: u32,
    channels: u16,
    pcm_tx: &tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let default_cfg = device
        .default_input_config()
        .map_err(|e| format!("Cannot get default input config: {e}"))?;
    let sample_format = default_cfg.sample_format();

    let config = cpal::StreamConfig {
        channels,
        sample_rate,
        buffer_size: cpal::BufferSize::Fixed(960),
    };

    let err_fn = |err| {
        eprintln!("[AudioCapture] cpal error: {err}");
    };

    let pcm_tx = pcm_tx.clone();
    let cancel = cancel.clone();
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _info| {
                if cancel.load(Ordering::Relaxed) { return; }
                let _ = pcm_tx.send(data.to_vec());
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            {
                let pcm_tx = pcm_tx.clone();
                move |data: &[i16], _info| {
                    if cancel.load(Ordering::Relaxed) { return; }
                    let f32_samples: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    let _ = pcm_tx.send(f32_samples);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            {
                let pcm_tx = pcm_tx.clone();
                move |data: &[u16], _info| {
                    if cancel.load(Ordering::Relaxed) { return; }
                    let f32_samples: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                    let _ = pcm_tx.send(f32_samples);
                }
            },
            err_fn,
            None,
        ),
        _ => {
            return Err(format!("Unsupported sample format: {:?}", sample_format));
        }
    }
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
    pub fn new(sample_rate: u32, channels: u16, bitrate_bps: u32) -> Result<Self, String> {
        let ch = if channels == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        };

        let mut encoder = OpusEncoder::new(sample_rate, ch, opus2::Application::Voip)
            .map_err(|e| format!("Failed to create Opus encoder: {e}"))?;

        encoder
            .set_bitrate(opus2::Bitrate::Bits(bitrate_bps as i32))
            .map_err(|e| format!("Failed to set Opus bitrate: {e}"))?;

        encoder
            .set_inband_fec(true)
            .map_err(|e| format!("Failed to enable Opus FEC: {e}"))?;

        encoder
            .set_dtx(true)
            .map_err(|e| format!("Failed to enable Opus DTX: {e}"))?;

        encoder
            .set_complexity(10)
            .map_err(|e| format!("Failed to set Opus complexity: {e}"))?;

        encoder
            .set_packet_loss_perc(5)
            .map_err(|e| format!("Failed to set Opus packet loss perc: {e}"))?;

        encoder
            .set_signal(opus2::Signal::Voice)
            .map_err(|e| format!("Failed to set Opus signal type: {e}"))?;

        let frame_size = (sample_rate as usize * 20) / 1000;

        Ok(Self {
            encoder,
            sample_rate,
            frame_size,
            running: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn update_bitrate(&mut self, bitrate_bps: u32) -> Result<(), String> {
        self.encoder
            .set_bitrate(opus2::Bitrate::Bits(bitrate_bps as i32))
            .map_err(|e| format!("Failed to update Opus bitrate: {e}"))
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
    processor: Arc<tokio::sync::Mutex<AudioProcessor>>,
    desired_bitrate: Arc<AtomicU32>,
}

impl AudioSendSession {
    pub fn new(
        encoder: AudioEncoder,
        track: Arc<TrackLocalStaticSample>,
        pcm_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
        cpal_stream: cpal::Stream,
        speaking_tx: tokio::sync::mpsc::UnboundedSender<bool>,
        processor: AudioProcessor,
        initial_bitrate_bps: u32,
    ) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();
        let processor = Arc::new(tokio::sync::Mutex::new(processor));
        let processor_clone = processor.clone();
        let desired_bitrate = Arc::new(AtomicU32::new(initial_bitrate_bps));
        let desired_bitrate_clone = desired_bitrate.clone();

        let handle = tokio::spawn(async move {
            let _ = run_audio_send(encoder, track, pcm_rx, cancel_clone, speaking_tx, processor_clone, desired_bitrate_clone).await;
        });

        Self {
            cancel,
            handle: Some(handle),
            _stream: Some(cpal_stream),
            processor,
            desired_bitrate,
        }
    }

    pub fn processor(&self) -> Arc<tokio::sync::Mutex<AudioProcessor>> {
        self.processor.clone()
    }

    pub fn update_bitrate(&self, bitrate_bps: u32) {
        self.desired_bitrate.store(bitrate_bps, Ordering::SeqCst);
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
    processor: Arc<tokio::sync::Mutex<AudioProcessor>>,
    desired_bitrate: Arc<AtomicU32>,
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
    let mut last_bitrate = desired_bitrate.load(Ordering::SeqCst);

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        match pcm_rx.recv().await {
            Some(samples) => {
                pcm_buffer.extend_from_slice(&samples);

                while pcm_buffer.len() >= frame_size {
                    let mut frame: Vec<f32> = pcm_buffer.drain(..frame_size).collect();

                    // Run DSP pipeline (noise gate + spectral suppression)
                    {
                        let mut proc = processor.lock().await;
                        proc.process_frame(&mut frame);
                    }

                    // VAD: compute RMS on processed frame
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

                    let current_bitrate = desired_bitrate.load(Ordering::SeqCst);
                    if current_bitrate != last_bitrate {
                        if let Err(e) = encoder.update_bitrate(current_bitrate) {
                            eprintln!("[AudioSend] Failed to update bitrate to {current_bitrate}: {e}");
                        } else {
                            eprintln!("[AudioSend] Bitrate updated: {last_bitrate} -> {current_bitrate} bps");
                            last_bitrate = current_bitrate;
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
        let mut pcm = vec![0.0f32; frame_size];
        let samples = self
            .decoder
            .decode_float(opus_data, &mut pcm, false)
            .map_err(|e| format!("Opus decode failed: {e}"))?;
        pcm.truncate(samples);
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

    let mut decoder = match AudioDecoder::new(48000, 1) {
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
