use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus2::{Channels, Encoder as OpusEncoder};
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::dsp::AudioProcessor;
use super::resample::{downmix_to_mono, LinearResampler, Rechunker};

/// Payload sent from the audio send loop to signal speaking state + audio level.
pub type SpeakingEvent = (bool, f32); // (is_speaking, rms_level)

/// A running microphone capture. Dropping it (or calling `stop`) releases the
/// device: the CPAL stream is closed, or the `parec` child is killed *and
/// reaped* and its reader thread joined. Before this existed the parec path
/// was fire-and-forget, so every join leaked a recording process.
pub struct CaptureHandle {
    cancel: Arc<AtomicBool>,
    stream: Option<cpal::Stream>,
    parec: Option<ParecCapture>,
}

impl CaptureHandle {
    fn from_stream(cancel: &Arc<AtomicBool>, stream: cpal::Stream) -> Self {
        Self {
            cancel: Arc::clone(cancel),
            stream: Some(stream),
            parec: None,
        }
    }

    fn from_parec(cancel: &Arc<AtomicBool>, parec: ParecCapture) -> Self {
        Self {
            cancel: Arc::clone(cancel),
            stream: None,
            parec: Some(parec),
        }
    }

    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.stream = None;
        if let Some(mut parec) = self.parec.take() {
            parec.stop();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

struct ParecCapture {
    /// Shared with the reader thread so whichever side finishes first can kill
    /// and reap the process; `reap` is idempotent.
    child: Arc<Mutex<Option<Child>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ParecCapture {
    fn stop(&mut self) {
        // Killing the child closes its stdout, which unblocks the reader's
        // `read` with EOF, so the join below cannot hang.
        reap(&self.child);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn reap(child: &Mutex<Option<Child>>) {
    let taken = match child.lock() {
        Ok(mut g) => g.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(mut c) = taken {
        let pid = c.id();
        let _ = c.kill();
        // wait() is what actually removes the process; kill alone leaves a
        // zombie behind for every call.
        let _ = c.wait();
        eprintln!("[ParecCapture] parec (pid={pid}) stopped");
    }
}

/// Start capturing the microphone as mono `f32` at `sample_rate`, delivered on
/// `pcm_tx` in 20ms frames.
///
/// Whatever the device's native format is, what comes out is mono at
/// `sample_rate`: CPAL devices are opened in a configuration they actually
/// support and converted here, and parec is asked for the target format
/// directly (the sound server converts).
pub fn start_native_audio_capture(
    device_id: Option<String>,
    sample_rate: u32,
    pcm_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
) -> Result<CaptureHandle, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let host = cpal::default_host();
    let host_id = host.id();
    let is_alsa = format!("{:?}", host_id).to_lowercase().contains("alsa");

    // Device ids the sound server knows as sources (`alsa_input.*`, but just as
    // well `bluez_input.*`, filter chains and virtual sources, all of which the
    // settings list offers) must be captured by name through parec. Only ids
    // that are not pulse sources, i.e. CPAL device ids, take the CPAL path.
    let requested_is_pulse = if is_alsa {
        device_id.as_deref().map(is_pulse_source)
    } else {
        None
    };

    // ─── PipeWire/PulseAudio path: use parec subprocess ────────────
    // CPAL's ALSA backend produces corrupted audio on PipeWire systems
    // due to S24LE ↔ F32 format conversion issues in the ALSA plugin.
    // `parec` talks through the pipewire-pulse protocol and reliably
    // produces correct float32 data.
    if is_alsa {
        let use_parec = requested_is_pulse.unwrap_or(true);

        if use_parec {
            // When no specific mic is selected, don't let "default" resolve to a
            // Bluetooth headset's HFP mic: capturing it forces the headset off
            // the high-quality A2DP profile onto mono HFP, which tears down the
            // A2DP sink (pausing other apps' audio) and wrecks playback quality.
            // An explicit user selection is always honored verbatim.
            let resolved = resolve_non_bluetooth_source(device_id.as_deref());
            let parec_device = resolved.as_deref().unwrap_or("default");
            eprintln!("[AudioCapture] trying parec (device: {parec_device}) — avoids CPAL ALSA/PipeWire corruption");
            if let Some(parec) = try_parec_capture(parec_device, sample_rate, &pcm_tx, &cancel) {
                eprintln!("[AudioCapture] using parec subprocess for device: {parec_device}");
                return Ok(CaptureHandle::from_parec(&cancel, parec));
            }
            eprintln!("[AudioCapture] parec failed for '{parec_device}', falling back to CPAL");
        }
    }

    // ─── CPAL path: for non-PipeWire devices or fallback ───────────
    // If a specific non-PipeWire device was requested, try it directly.
    if let Some(ref id) = device_id {
        if requested_is_pulse != Some(true) {
            let device = host
                .input_devices()
                .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
                .find(|d| {
                    d.id()
                        .map(|i| i.to_string() == *id)
                        .unwrap_or(false)
                })
                .ok_or_else(|| format!("Input device '{}' not found", id))?;

            return open_device(&device, sample_rate, &pcm_tx, &cancel).map(|s| {
                eprintln!("[AudioCapture] using specific device: {id}");
                CaptureHandle::from_stream(&cancel, s)
            });
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
                match open_device(device, sample_rate, &pcm_tx, &cancel) {
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
            return Ok(CaptureHandle::from_stream(&cancel, stream));
        }
    }

    // Try the ALSA default PCM device — on PipeWire systems this routes
    // through the PipeWire ALSA plugin and captures the default source.
    if let Some(default_device) = host.default_input_device() {
        match open_device(&default_device, sample_rate, &pcm_tx, &cancel) {
            Ok(stream) => {
                let dname = default_device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "default".into());
                eprintln!("[AudioCapture] using default device: {dname}");
                return Ok(CaptureHandle::from_stream(&cancel, stream));
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
            return Ok(CaptureHandle::from_stream(&cancel, stream));
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
        match open_device(device, sample_rate, &pcm_tx, &cancel) {
            Ok(stream) => {
                eprintln!("[AudioCapture] using fallback device: {dname}");
                return Ok(CaptureHandle::from_stream(&cancel, stream));
            }
            Err(e) => {
                eprintln!("[AudioCapture] trying next device '{dname}' (error: {e})");
            }
        }
    }

    // Last resort: try parec with default source when everything else failed.
    if is_alsa {
        eprintln!("[AudioCapture] CPAL exhausted, trying parec with default source as last resort");
        if let Some(parec) = try_parec_capture("default", sample_rate, &pcm_tx, &cancel) {
            eprintln!("[AudioCapture] using parec default fallback");
            return Ok(CaptureHandle::from_parec(&cancel, parec));
        }
    }

    if !hardware_found {
        return Err("No audio input devices found".into());
    }

    Err("No working audio input device found".into())
}

/// Names of the sound server's capture sources (`pactl list short sources`),
/// or `None` when pactl is unavailable.
fn pulse_source_names() -> Option<Vec<String>> {
    let out = Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    Some(parse_short_list_names(&String::from_utf8_lossy(&out.stdout)))
}

/// Second column of `pactl list short ...` output: `<index>\t<name>\t...`.
fn parse_short_list_names(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.split('\t').nth(1))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// Whether `id` names a PulseAudio/PipeWire source, and so has to be captured
/// with `parec --device=<id>`, rather than being a CPAL device id.
///
/// Asking pactl is authoritative. The prefix check only covers a system where
/// pactl is missing or the source vanished between listing and joining (parec
/// then fails and we fall back to CPAL, which is still the right outcome).
fn is_pulse_source(id: &str) -> bool {
    if let Some(names) = pulse_source_names() {
        if names.iter().any(|n| n == id) {
            return true;
        }
    }
    looks_like_pulse_name(id)
}

fn looks_like_pulse_name(id: &str) -> bool {
    [
        "alsa_input.",
        "alsa_output.",
        "bluez_input.",
        "bluez_output.",
        "bluez_source.",
        "bluez_sink.",
    ]
    .iter()
    .any(|p| id.starts_with(p))
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

/// Capture through a `parec` subprocess (PulseAudio/pipewire-pulse), mono at
/// `sample_rate`. Returns `None` when parec cannot be started.
///
/// The reader thread stops on cancel, on EOF, and as soon as `pcm_tx.send`
/// fails (the consumer is gone). Whichever side stops first kills and reaps the
/// child, so no parec outlives its call.
fn try_parec_capture(
    device_id: &str,
    sample_rate: u32,
    pcm_tx: &tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: &Arc<AtomicBool>,
) -> Option<ParecCapture> {
    let device = device_id.to_string();
    let pcm_tx = pcm_tx.clone();
    let cancel = cancel.clone();
    let frame_size = (sample_rate as usize / 50).max(1); // 20ms
    let read_size = frame_size * 4; // mono f32

    let mut child = match Command::new("parec")
        .args([
            &format!("--device={device}"),
            "--format=float32le",
            &format!("--rate={}", sample_rate),
            "--channels=1",
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
            return None;
        }
    };

    let pid = child.id();
    eprintln!("[ParecCapture] spawned parec (pid={pid}) for device: {device}");

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("[ParecCapture] no stdout from parec");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };

    let child = Arc::new(Mutex::new(Some(child)));
    let thread_child = Arc::clone(&child);

    let thread = std::thread::Builder::new()
        .name("parec-capture".into())
        .spawn(move || {
            let mut leftover = Vec::new();
            let mut temp = vec![0u8; 65536];
            let mut callback_count = 0u64;

            'read: loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                match stdout.read(&mut temp) {
                    Ok(0) => {
                        eprintln!("[ParecCapture] stdout EOF");
                        break;
                    }
                    Ok(n) => {
                        leftover.extend_from_slice(&temp[..n]);

                        while leftover.len() >= read_size {
                            let raw: Vec<f32> = leftover[..read_size]
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .map(|b| f32::from_le_bytes(*b))
                                .collect();
                            leftover.drain(..read_size);

                            if cancel.load(Ordering::Relaxed) {
                                break 'read;
                            }

                            callback_count += 1;
                            if callback_count <= 5 || callback_count.is_multiple_of(500) {
                                eprintln!(
                                    "[ParecCapture] callback #{callback_count}, samples={}",
                                    raw.len()
                                );
                            }

                            if pcm_tx.send(raw).is_err() {
                                // Nobody is listening any more: stop recording
                                // rather than spin on a dead channel forever.
                                eprintln!("[ParecCapture] consumer gone, stopping");
                                break 'read;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[ParecCapture] read error: {e}");
                        break;
                    }
                }
            }

            reap(&thread_child);
            eprintln!("[ParecCapture] thread exiting after {callback_count} callbacks");
        });

    match thread {
        Ok(t) => Some(ParecCapture {
            child,
            thread: Some(t),
        }),
        Err(e) => {
            eprintln!("[ParecCapture] failed to spawn reader thread: {e}");
            reap(&child);
            None
        }
    }
}

/// Rank of a sample format for capture, lower is better; `None` if unsupported.
fn input_format_rank(f: cpal::SampleFormat) -> Option<u8> {
    match f {
        cpal::SampleFormat::F32 => Some(0),
        cpal::SampleFormat::I16 => Some(1),
        cpal::SampleFormat::I32 => Some(2),
        cpal::SampleFormat::U16 => Some(3),
        _ => None,
    }
}

/// Pick a configuration the device really supports, preferring one that runs
/// at `target_rate` (no resampling) with as few channels as possible.
///
/// The old code forced `{1 channel, 48 kHz, 960-frame buffer}` regardless of
/// what the device offered. Devices that only do stereo or 44.1 kHz then either
/// failed to open or, worse, opened and delivered samples at a different rate
/// than we assumed.
fn choose_input_config(
    device: &cpal::Device,
    target_rate: u32,
) -> Result<cpal::SupportedStreamConfig, String> {
    let ranges: Vec<cpal::SupportedStreamConfigRange> = device
        .supported_input_configs()
        .map(|it| it.collect())
        .unwrap_or_default();

    let best_at_target = ranges
        .iter()
        .filter(|r| r.min_sample_rate() <= target_rate && target_rate <= r.max_sample_rate())
        .filter_map(|r| input_format_rank(r.sample_format()).map(|rank| (r, rank)))
        .min_by_key(|(r, rank)| (r.channels(), *rank));
    if let Some((range, _)) = best_at_target {
        return Ok((*range).with_sample_rate(target_rate));
    }

    // Nothing runs at the target rate: take the device's own default if we can
    // read its sample format, and resample.
    if let Ok(default) = device.default_input_config() {
        if input_format_rank(default.sample_format()).is_some() {
            return Ok(default);
        }
    }

    ranges
        .iter()
        .filter_map(|r| input_format_rank(r.sample_format()).map(|rank| (r, rank)))
        .min_by_key(|(r, rank)| (r.channels(), *rank))
        .map(|(r, _)| (*r).with_max_sample_rate())
        .ok_or_else(|| "Device offers no usable input configuration".to_string())
}

fn open_device(
    device: &cpal::Device,
    sample_rate: u32,
    pcm_tx: &tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let supported = choose_input_config(device, sample_rate)?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();
    eprintln!(
        "[AudioCapture] opening input: {}ch {}Hz {:?} (converting to mono {}Hz)",
        config.channels, config.sample_rate, sample_format, sample_rate
    );

    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_input::<f32>(device, &config, sample_rate, pcm_tx, cancel),
        cpal::SampleFormat::I16 => build_input::<i16>(device, &config, sample_rate, pcm_tx, cancel),
        cpal::SampleFormat::I32 => build_input::<i32>(device, &config, sample_rate, pcm_tx, cancel),
        cpal::SampleFormat::U16 => build_input::<u16>(device, &config, sample_rate, pcm_tx, cancel),
        other => return Err(format!("Unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("Failed to build input stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {e}"))?;

    Ok(stream)
}

/// Build an input stream in the device's native format: convert to `f32`,
/// downmix to mono, resample to `target_rate`, and emit 20ms frames.
fn build_input<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    target_rate: u32,
    pcm_tx: &tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    cancel: &Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let pcm_tx = pcm_tx.clone();
    let cancel = cancel.clone();
    let channels = config.channels.max(1) as usize;
    let mut resampler = LinearResampler::new(config.sample_rate, target_rate);
    let mut chunker = Rechunker::new((target_rate as usize / 50).max(1));
    let mut converted: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut resampled: Vec<f32> = Vec::new();
    let mut closed = false;

    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _info| {
            if closed || cancel.load(Ordering::Relaxed) {
                return;
            }
            converted.clear();
            converted.extend(data.iter().map(|s| s.to_sample::<f32>().clamp(-1.0, 1.0)));
            mono.clear();
            downmix_to_mono(&converted, channels, &mut mono);
            resampled.clear();
            resampler.process(&mono, &mut resampled);
            if !chunker.push(&resampled, |frame| pcm_tx.send(frame).is_ok()) {
                closed = true;
            }
        },
        |err| eprintln!("[AudioCapture] cpal error: {err}"),
        None,
    )
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
    capture: Option<CaptureHandle>,
    processor: Arc<tokio::sync::Mutex<AudioProcessor>>,
    desired_bitrate: Arc<AtomicU32>,
}

impl AudioSendSession {
    pub fn new(
        encoder: AudioEncoder,
        track: Arc<TrackLocalStaticSample>,
        pcm_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
        capture: CaptureHandle,
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
            capture: Some(capture),
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

    /// Stop sending and release the microphone. Idempotent.
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        // Dropping a JoinHandle only detaches the task; abort it so it does not
        // sit parked on `pcm_rx.recv()` holding the encoder and track.
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
        // Kills and reaps parec / closes the CPAL stream.
        if let Some(mut capture) = self.capture.take() {
            capture.stop();
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_source_names_from_pactl_short_output() {
        let out = "52\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n\
                   61\tbluez_input.AA_BB_CC_DD_EE_FF.0\tPipeWire\tfloat32le 1ch 16000Hz\tRUNNING\n\
                   70\teffect_input.rnnoise\tPipeWire\tfloat32le 1ch 48000Hz\tIDLE\n";
        assert_eq!(
            parse_short_list_names(out),
            vec![
                "alsa_input.pci-0000_00_1f.3.analog-stereo",
                "bluez_input.AA_BB_CC_DD_EE_FF.0",
                "effect_input.rnnoise",
            ]
        );
    }

    #[test]
    fn recognises_pulse_names_without_pactl() {
        assert!(looks_like_pulse_name("bluez_input.AA_BB.0"));
        assert!(looks_like_pulse_name("alsa_input.usb-foo"));
        assert!(!looks_like_pulse_name("hw:CARD=PCH,DEV=0"));
    }

    /// Needs a running PulseAudio/PipeWire session, so it is opt-in:
    /// `cargo test -- --ignored parec_capture_is_reaped`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn parec_capture_is_reaped_on_stop() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let parec = try_parec_capture("default", 48_000, &tx, &cancel).expect("parec");
        drop(tx);
        let pid = parec.child.lock().unwrap().as_ref().unwrap().id();
        std::thread::sleep(Duration::from_millis(300));
        assert!(rx.try_recv().is_ok(), "parec should have produced audio");

        // What voice_leave does: drop the capture handle.
        drop(CaptureHandle::from_parec(&cancel, parec));
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "parec (pid {pid}) must be killed and reaped, not left running or as a zombie"
        );
    }
}
