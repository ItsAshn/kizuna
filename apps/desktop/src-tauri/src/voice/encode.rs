use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus2::{Channels, Decoder as OpusDecoder, Encoder as OpusEncoder};
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::dsp::AudioProcessor;

/// Payload sent from the audio send loop to signal speaking state + audio level.
pub type SpeakingEvent = (bool, f32); // (is_speaking, rms_level)

pub fn start_native_audio_capture(
    device_id: Option<String>,
    sample_rate: u32,
    channels: u16,
    pcm_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: Arc<AtomicBool>,
) -> Result<Option<cpal::Stream>, String> {
    let host = cpal::default_host();
    let host_id = host.id();
    let is_alsa = format!("{:?}", host_id).to_lowercase().contains("alsa");

    // ─── PipeWire/PulseAudio path: use parec subprocess ────────────
    // CPAL's ALSA backend produces corrupted audio on PipeWire systems
    // due to S24LE ↔ F32 format conversion issues in the ALSA plugin.
    // `parec` talks through the pipewire-pulse protocol and reliably
    // produces correct float32 data.
    if is_alsa {
        let use_parec = device_id
            .as_deref()
            .map(|id| id.starts_with("alsa_input.") || id.starts_with("alsa_output."))
            .unwrap_or(true);

        if use_parec {
            // When no specific mic is selected, don't let "default" resolve to a
            // Bluetooth headset's HFP mic: capturing it forces the headset off
            // the high-quality A2DP profile onto mono HFP, which tears down the
            // A2DP sink (pausing other apps' audio) and wrecks playback quality.
            // An explicit user selection is always honored verbatim.
            let resolved = resolve_non_bluetooth_source(device_id.as_deref());
            let parec_device = resolved.as_deref().unwrap_or("default");
            eprintln!("[AudioCapture] trying parec (device: {parec_device}) — avoids CPAL ALSA/PipeWire corruption");
            if try_parec_capture(parec_device, sample_rate, channels, &pcm_tx, &cancel) {
                eprintln!("[AudioCapture] using parec subprocess for device: {parec_device}");
                return Ok(None);
            }
            eprintln!("[AudioCapture] parec failed for '{parec_device}', falling back to CPAL");
        }
    }

    // ─── CPAL path: for non-PipeWire devices or fallback ───────────
    // If a specific non-PipeWire device was requested, try it directly.
    if let Some(ref id) = device_id {
        let is_pipewire_device = id.starts_with("alsa_input.") || id.starts_with("alsa_output.");
        if !is_pipewire_device {
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
                .map(|s| { eprintln!("[AudioCapture] using specific device: {id}"); Some(s) });
        }
        eprintln!("[AudioCapture] PipeWire-managed device '{id}' selected — already tried parec above");
    }

    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
        .collect();

    // Helper: try opening a device matching a predicate on its description.
    let try_open_by_name = |pred: fn(&str) -> bool| -> Option<cpal::Stream> {
        for device in &devices {
            let dname = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| "unknown".into());
            let lower = dname.to_lowercase();
            if pred(&lower) {
                match open_device(device, sample_rate, channels, &pcm_tx, &cancel) {
                    Ok(stream) => {
                        eprintln!("[AudioCapture] using sound server device: {dname}");
                        return Some(stream);
                    }
                    Err(e) => {
                        eprintln!("[AudioCapture] sound server device '{dname}' failed: {e}");
                    }
                }
            }
        }
        None
    };

    // On Linux/ALSA, sound server devices (PipeWire/PulseAudio) are far more
    // reliable than raw ALSA hardware devices, which often open successfully
    // but produce silence through the dmix/dsnoop plugin chain.
    // Broaden the match: any device containing "pipewire" or "pulse" / "pulseaudio".
    if is_alsa {
        if let Some(stream) = try_open_by_name(|n| {
            n.contains("pipewire") || n.contains("pulseaudio") || n.contains(" pulse ")
        }) {
            return Ok(Some(stream));
        }
    }

    // Try the ALSA default PCM device — on PipeWire systems this routes
    // through the PipeWire ALSA plugin and captures the default source.
    if let Some(default_device) = host.default_input_device() {
        match open_device(&default_device, sample_rate, channels, &pcm_tx, &cancel) {
            Ok(stream) => {
                let dname = default_device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "default".into());
                eprintln!("[AudioCapture] using default device: {dname}");
                return Ok(Some(stream));
            }
            Err(e) => {
                eprintln!("[AudioCapture] default device failed: {e} (will try other devices)");
            }
        }
    }

    // Not ALSA or sound-server search didn't match: try broader matching.
    if !is_alsa {
        if let Some(stream) = try_open_by_name(|n| {
            n.contains("pipewire") || n.contains("pulseaudio") || n.contains(" pulse ")
        }) {
            return Ok(Some(stream));
        }
    }

    // Fall back to any available input device, skipping obvious non-microphones.
    let mut hardware_found = false;
    for device in &devices {
        let dname = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "unknown".into());

        let lower = dname.to_lowercase();
        if lower.contains("discard") || lower.contains("rate converter")
            || lower.contains("plugin for") || lower.contains("jack audio")
            || lower.contains("open sound") || lower.contains("speex")
            || lower.contains("upmix") || lower.contains("downmix")
            || (lower.contains("output") && !lower.contains("wave") && !lower.contains("usb"))
            || lower.contains("pipewire")
            || lower.contains("pulseaudio")
            // Skip Bluetooth headset mics: opening them forces the A2DP→HFP
            // profile switch that degrades playback and pauses other audio.
            || lower.contains("bluez")
            || lower.contains("bluetooth")
            || lower.contains("hands-free")
            || lower.contains("hfp")
            || lower.contains("hsp")
        {
            eprintln!("[AudioCapture] skipped virtual/plugin device: {dname}");
            continue;
        }

        hardware_found = true;
        match open_device(device, sample_rate, channels, &pcm_tx, &cancel) {
            Ok(stream) => {
                eprintln!("[AudioCapture] using fallback device: {dname}");
                return Ok(Some(stream));
            }
            Err(e) => {
                eprintln!("[AudioCapture] trying next device '{dname}' (error: {e})");
            }
        }
    }

    // Last resort: try parec with default source when everything else failed.
    if is_alsa {
        eprintln!("[AudioCapture] CPAL exhausted, trying parec with default source as last resort");
        if try_parec_capture("default", sample_rate, channels, &pcm_tx, &cancel) {
            eprintln!("[AudioCapture] using parec default fallback");
            return Ok(None);
        }
    }

    if !hardware_found {
        return Err("No audio input devices found".into());
    }

    Err("No working audio input device found".into())
}

/// Returns true if a PulseAudio/PipeWire source name looks like a Bluetooth
/// headset mic (HFP/HSP). Capturing these forces the device off A2DP.
fn is_bluetooth_source(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("bluez")
        || n.contains("bluetooth")
        || n.contains(".hfp")
        || n.contains(".hsp")
        || n.contains("hands-free")
}

/// Resolves which source `parec` should capture from.
///
/// An explicit user selection is honored verbatim. Otherwise, the PipeWire
/// "default" source is often a Bluetooth headset's HFP mic; capturing it forces
/// the headset off the high-quality A2DP profile onto mono HFP, which tears
/// down the A2DP sink (pausing other apps' audio, e.g. a browser's video) and
/// degrades headphone playback. To avoid that, when the default would be a
/// Bluetooth source we pick a concrete non-Bluetooth input source instead.
///
/// Returns `None` to mean "use parec's `default`" (the default isn't Bluetooth,
/// or no better source could be found).
fn resolve_non_bluetooth_source(requested: Option<&str>) -> Option<String> {
    // Honor an explicit selection as-is — including Bluetooth, if the user
    // genuinely has no other mic and chose it deliberately.
    if let Some(id) = requested {
        return Some(id.to_string());
    }

    // Find the current default source via pactl (ships alongside parec/paplay).
    let default_source = Command::new("pactl")
        .args(["get-default-source"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // If the default isn't Bluetooth, keep parec's normal "default" behavior.
    if !default_source.is_empty() && !is_bluetooth_source(&default_source) {
        return None;
    }

    // Default is a Bluetooth (or unknown) source — pick a non-Bluetooth,
    // non-monitor input source instead.
    let sources = Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    for line in sources.lines() {
        // Format: "<index>\t<name>\t<driver>\t<format>\t<state>"
        let name = match line.split('\t').nth(1) {
            Some(n) => n,
            None => continue,
        };
        let lower = name.to_lowercase();
        if lower.ends_with(".monitor") {
            continue; // output monitor, not a real microphone
        }
        if is_bluetooth_source(&lower) {
            continue; // skip Bluetooth HFP/HSP mics
        }
        eprintln!(
            "[AudioCapture] default source is Bluetooth/unknown ('{default_source}'); using non-Bluetooth source instead: {name}"
        );
        return Some(name.to_string());
    }

    if is_bluetooth_source(&default_source) {
        eprintln!(
            "[AudioCapture] WARNING: the only microphone is Bluetooth ('{default_source}'); capturing it will switch the headset to low-quality HFP and may pause other audio"
        );
    }
    None
}

/// Fallback capture using `parec` subprocess (PulseAudio/pipewire-pulse).
/// This is used when CPAL's ALSA backend cannot open the device.
/// Returns `true` if the subprocess was spawned successfully.
fn try_parec_capture(
    device_id: &str,
    sample_rate: u32,
    channels: u16,
    pcm_tx: &tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let device = device_id.to_string();
    let pcm_tx = pcm_tx.clone();
    let cancel = cancel.clone();
    let frame_size = 960usize;
    let read_size = frame_size * (channels as usize) * 4; // f32 = 4 bytes

    let mut child = match Command::new("parec")
        .args([
            "--device", &device,
            "--format=float32le",
            &format!("--rate={}", sample_rate),
            &format!("--channels={}", channels),
            "--latency-msec=20",
            "--raw",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ParecCapture] failed to spawn parec: {e}");
            return false;
        }
    };

    let pid = child.id();
    eprintln!("[ParecCapture] spawned parec (pid={pid}) for device: {device}");

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("[ParecCapture] no stdout from parec");
            let _ = child.kill();
            return false;
        }
    };

    std::thread::spawn(move || {
        let mut child = child;
        let mut leftover = Vec::new();
        let mut byte_buf = [0u8; 4];
        let mut callback_count = 0u64;

        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            // Read raw bytes from parec stdout
            let mut temp = vec![0u8; 65536];
            match stdout.read(&mut temp) {
                Ok(0) => {
                    eprintln!("[ParecCapture] stdout EOF");
                    break;
                }
                Ok(n) => {
                    temp.truncate(n);
                    leftover.extend_from_slice(&temp);

                    // Process complete frames
                    while leftover.len() >= read_size {
                        let raw: Vec<f32> = leftover[..read_size]
                            .chunks_exact(4)
                            .map(|b| {
                                byte_buf.copy_from_slice(b);
                                f32::from_le_bytes(byte_buf)
                            })
                            .collect();
                        leftover.drain(..read_size);

                        if cancel.load(Ordering::Relaxed) {
                            break;
                        }

                        callback_count += 1;
                        if callback_count <= 5 || callback_count % 500 == 0 {
                            eprintln!("[ParecCapture] callback #{callback_count}, samples={}", raw.len());
                        }

                        let _ = pcm_tx.send(raw);
                    }
                }
                Err(e) => {
                    eprintln!("[ParecCapture] read error: {e}");
                    break;
                }
            }
        }

        let _ = child.kill();
        eprintln!("[ParecCapture] thread exiting after {callback_count} callbacks");
    });

    true
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
                    let f32_samples: Vec<f32> = data.iter().map(|&s| s as f32 / 32767.0).collect();
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

        encoder
            .set_max_bandwidth(opus2::Bandwidth::Fullband)
            .map_err(|e| format!("Failed to set Opus max bandwidth: {e}"))?;

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
        cpal_stream: Option<cpal::Stream>,
        speaking_tx: tokio::sync::mpsc::UnboundedSender<SpeakingEvent>,
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
            _stream: cpal_stream,
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
    speaking_tx: tokio::sync::mpsc::UnboundedSender<SpeakingEvent>,
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
                    let speaking_now = rms > threshold;

                    if speaking_now && !is_speaking {
                        is_speaking = true;
                        silence_frames = 0;
                        let _ = speaking_tx.send((true, rms));
                    } else if speaking_now {
                        silence_frames = 0;
                    } else if is_speaking {
                        silence_frames += 1;
                        if silence_frames >= hold_frames {
                            is_speaking = false;
                            let _ = speaking_tx.send((false, rms));
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
