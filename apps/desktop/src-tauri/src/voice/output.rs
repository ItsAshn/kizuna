use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::jitter::{PeerJitter, Playout, FRAME_SAMPLES};

const SAMPLE_RATE: u32 = 48000;

struct OutputInner {
    peers: HashMap<String, PeerJitter>,
    volume: f32,
    /// Per-peer playback gain, 0.0-2.0, keyed by peer id. Absent means unity.
    /// Kept separate from `peers` so a volume set before that peer's first
    /// packet arrives still applies once their jitter buffer is created.
    peer_volumes: HashMap<String, f32>,
}

enum MixResult {
    Data,
    Silence,
    NoPeers,
}

pub struct AudioOutput {
    inner: Arc<Mutex<OutputInner>>,
    cancel: Arc<AtomicBool>,
    _handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioOutput {
    pub fn new(device_id: Option<String>, volume: f32) -> Result<Self, String> {
        let inner = Arc::new(Mutex::new(OutputInner {
            peers: HashMap::new(),
            volume: volume.clamp(0.0, 2.0),
            peer_volumes: HashMap::new(),
        }));
        let cancel = Arc::new(AtomicBool::new(false));

        start_backend(device_id.as_deref())?;

        let handle = {
            let inner = Arc::clone(&inner);
            let cancel = Arc::clone(&cancel);
            std::thread::Builder::new()
                .name("audio-output".into())
                .spawn(move || {
                    output_thread(inner, cancel);
                })
        };

        let handle = match handle {
            Ok(h) => Some(h),
            Err(e) => {
                cancel.store(true, Ordering::SeqCst);
                return Err(format!("Failed to spawn output thread: {e}"));
            }
        };

        Ok(Self {
            inner,
            cancel,
            _handle: handle,
        })
    }

    /// Hand an encoded Opus packet to a peer's jitter buffer. `seq`/`ts` are the
    /// RTP sequence number and timestamp, absent when the server predates
    /// sequence forwarding.
    pub fn push_packet(&self, peer_id: &str, seq: Option<u16>, ts: Option<u32>, opus: Vec<u8>) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[AudioOutput] lock poisoned: {e}");
                return;
            }
        };

        if !guard.peers.contains_key(peer_id) {
            match PeerJitter::new() {
                Ok(j) => {
                    guard.peers.insert(peer_id.to_string(), j);
                }
                Err(e) => {
                    eprintln!("[AudioOutput] cannot create jitter buffer for {peer_id}: {e}");
                    return;
                }
            }
        }

        if let Some(peer) = guard.peers.get_mut(peer_id) {
            peer.push(seq, ts, opus);
        }
    }

    pub fn remove_peer(&self, peer_id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.peers.remove(peer_id);
            guard.peer_volumes.remove(peer_id);
            eprintln!("[AudioOutput] removed peer={peer_id}");
        }
    }

    pub fn set_volume(&self, volume: f32) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.volume = volume.clamp(0.0, 2.0);
        }
    }

    /// Set an individual peer's playback gain, independent of master volume.
    pub fn set_peer_volume(&self, peer_id: &str, volume: f32) {
        if let Ok(mut guard) = self.inner.lock() {
            guard
                .peer_volumes
                .insert(peer_id.to_string(), volume.clamp(0.0, 2.0));
        }
    }

    pub fn set_output_device(&self, _device_id: Option<String>) {
        #[cfg(not(target_os = "linux"))]
        {
            cpalsink::set_device(_device_id);
        }
        #[cfg(target_os = "linux")]
        {
            // Changing device on Linux requires restarting paplay.
            // For now, just log it — full device switching requires re-init.
            eprintln!(
                "[AudioOutput] device change requested (not implemented in-flight): {:?}",
                _device_id
            );
        }
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(handle) = self._handle.take() {
            let _ = handle.join();
        }
        eprintln!("[AudioOutput] stopped");
    }
}

fn mix_next_frame(inner: &mut OutputInner, out: &mut [f32], scratch: &mut [f32]) -> MixResult {
    if inner.peers.is_empty() {
        return MixResult::NoPeers;
    }

    let mut has_data = false;
    out.fill(0.0);

    // Peers are summed at their individual gain. Taking the volume by lookup
    // here (rather than storing it on PeerJitter) keeps the jitter buffer
    // ignorant of playback concerns and lets a volume be set for a peer whose
    // buffer does not exist yet.
    let peer_volumes = &inner.peer_volumes;
    for (peer_id, peer) in inner.peers.iter_mut() {
        if let Playout::Data = peer.pop_frame(scratch) {
            let gain = peer_volumes.get(peer_id).copied().unwrap_or(1.0);
            if gain == 1.0 {
                for (o, s) in out.iter_mut().zip(scratch.iter()) {
                    *o += *s;
                }
            } else {
                for (o, s) in out.iter_mut().zip(scratch.iter()) {
                    *o += *s * gain;
                }
            }
            has_data = true;
        }
    }

    if !has_data {
        // Peers are present but none have audio ready (priming, or all silent).
        // Keep feeding the sink so its stream stays running — letting it drain
        // makes the next talk spurt start with a device-level underrun.
        return MixResult::Silence;
    }

    // Apply volume, then soft-clip. Below a 0.95 knee the signal is untouched;
    // above it we saturate smoothly into [-1, 1] (tanh knee) instead of hard
    // clipping, so volume boosts and summed peaks don't produce harsh distortion.
    let volume = inner.volume;
    const KNEE: f32 = 0.95;
    for s in out.iter_mut() {
        let x = *s * volume;
        *s = if x.abs() <= KNEE {
            x
        } else {
            let over = (x.abs() - KNEE) / (1.0 - KNEE);
            x.signum() * (KNEE + (1.0 - KNEE) * over.tanh())
        };
    }

    MixResult::Data
}

fn output_thread(inner: Arc<Mutex<OutputInner>>, cancel: Arc<AtomicBool>) {
    let period = std::time::Duration::from_millis(20);
    let mut mix_buf = vec![0.0f32; FRAME_SAMPLES];
    // Each peer decodes into this before being summed into the mix.
    let mut peer_buf = vec![0.0f32; FRAME_SAMPLES];
    let silence = vec![0.0f32; FRAME_SAMPLES];
    // Absolute-deadline scheduling. Sleeping a fixed `period` each iteration
    // drifts slow: oversleep plus mix/write time pushes the real cadence above
    // 20ms, so we feed the sink fewer than 48000 samples/s. That starves paplay
    // (gaps/clicks) AND overflows the jitter buffer (dropped frames) — choppy,
    // unintelligible audio. Pacing to a fixed deadline keeps the long-run rate
    // at exactly 50 frames/s regardless of per-iteration jitter.
    let mut next = std::time::Instant::now() + period;

    eprintln!("[AudioOutput] output thread started");

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let result = {
            let mut guard = match inner.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            mix_next_frame(&mut guard, &mut mix_buf, &mut peer_buf)
        };

        // Hand the echo canceller the signal we are about to play, before it
        // goes anywhere. This is its far-end reference. It runs every tick, even
        // when there is nothing to play: AEC3 lines the render and capture
        // streams up by cadence, so a silent tick still has to be accounted for.
        match result {
            MixResult::Data => {
                if let Some(aec) = super::aec::global() {
                    aec.process_render(&mix_buf);
                }
                write_output(&mix_buf);
            }
            MixResult::Silence | MixResult::NoPeers => {
                if let Some(aec) = super::aec::global() {
                    aec.process_render(&silence);
                }
                if matches!(result, MixResult::Silence) {
                    write_silence();
                }
            }
        }

        let now = std::time::Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        }
        next += period;
        // If a scheduler stall left us far behind, resync rather than bursting to
        // catch up (which would just dump backlog into the sink).
        let now = std::time::Instant::now();
        if now > next + period * 4 {
            next = now + period;
        }
    }

    eprintln!("[AudioOutput] output thread stopped");
}

// ─── Linux backend: paplay subprocess ───────────────────────────────────

#[cfg(target_os = "linux")]
static PAPLAY_STDIN: std::sync::Mutex<Option<std::process::ChildStdin>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "linux")]
fn start_backend(device_id: Option<&str>) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let dev = device_id.unwrap_or("@DEFAULT_SINK@");

    // Without --latency-msec, paplay takes the server's default playback buffer
    // (hundreds of ms, historically up to ~2s), and that sits on top of the
    // jitter buffer as pure end-to-end call delay. 50ms is low enough to be
    // imperceptible while leaving ~2 frames of slack for the 20ms-paced writer.
    let mut child = Command::new("paplay")
        .args([
            "--device",
            dev,
            "--raw",
            &format!("--rate={SAMPLE_RATE}"),
            "--channels=1",
            "--format=float32le",
            "--latency-msec=50",
        ])
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn paplay: {e}"))?;

    let stdin = child.stdin.take().ok_or("No stdin from paplay")?;
    let pid = child.id();
    eprintln!("[AudioOutput] paplay spawned (pid={pid}) device={dev}");

    let mut guard = PAPLAY_STDIN.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = Some(stdin);

    Ok(())
}

#[cfg(target_os = "linux")]
fn write_output(buf: &[f32]) {
    let mut guard = match PAPLAY_STDIN.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(ref mut stdin) = *guard {
        let bytes: Vec<u8> = buf.iter().flat_map(|s| s.to_le_bytes()).collect();
        let _ = std::io::Write::write_all(stdin, &bytes);
    }
}

#[cfg(target_os = "linux")]
fn write_silence() {
    let silence = vec![0.0f32; FRAME_SAMPLES];
    write_output(&silence);
}

// ─── Windows / macOS backend: CPAL with ring buffer ─────────────────────

#[cfg(not(target_os = "linux"))]
fn start_backend(_device_id: Option<&str>) -> Result<(), String> {
    cpalsink::init(_device_id)
}

#[cfg(not(target_os = "linux"))]
fn write_output(buf: &[f32]) {
    cpalsink::write(buf);
}

#[cfg(not(target_os = "linux"))]
fn write_silence() {
    let silence = vec![0.0f32; FRAME_SAMPLES];
    cpalsink::write(&silence);
}

#[cfg(not(target_os = "linux"))]
mod cpalsink {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use ringbuf::traits::*;
    use ringbuf::HeapRb;
    use std::sync::Mutex;

    static SINK: std::sync::OnceLock<Mutex<SinkState>> = std::sync::OnceLock::new();

    struct SinkState {
        prod: ringbuf::HeapProd<f32>,
        _stream: Option<cpal::Stream>,
    }

    pub fn init(device_id: Option<&str>) -> Result<(), String> {
        SINK.get_or_init(|| {
            let (prod, cons) = HeapRb::<f32>::new(48000).split();
            let stream = open_stream(cons, device_id);
            Mutex::new(SinkState {
                prod,
                _stream: stream,
            })
        });
        Ok(())
    }

    pub fn set_device(_device_id: Option<String>) {
        eprintln!(
            "[AudioOutput] CPAL device change not implemented mid-stream: {:?}",
            _device_id
        );
    }

    pub fn write(samples: &[f32]) {
        let lock = match SINK.get() {
            Some(l) => l,
            None => return,
        };
        let mut state = match lock.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        for &s in samples {
            let _ = state.prod.try_push(s);
        }
    }

    fn open_stream(mut cons: ringbuf::HeapCons<f32>, device_id: Option<&str>) -> Option<cpal::Stream> {
        let host = cpal::default_host();
        let device: cpal::Device = match device_id {
            Some(id) => {
                let devices = host.output_devices().ok()?;
                let mut found = None;
                for d in devices {
                    if d.id().map(|i| i.to_string() == id).unwrap_or(false) {
                        found = Some(d);
                        break;
                    }
                }
                found?
            }
            None => host.default_output_device()?,
        };

        let config = device.default_output_config().ok()?;
        let sample_format = config.sample_format();

        let dev_name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "unknown".into());
        eprintln!("[AudioOutput] CPAL output device: {dev_name}");

        let stream = match sample_format {
            cpal::SampleFormat::F32 => device
                .build_output_stream::<f32, _, _>(
                    &config.into(),
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        for sample in data.iter_mut() {
                            *sample = cons.try_pop().unwrap_or(0.0);
                        }
                    },
                    |err| eprintln!("[AudioOutput] CPAL error: {err}"),
                    None,
                )
                .ok()?,
            cpal::SampleFormat::I16 => device
                .build_output_stream::<i16, _, _>(
                    &config.into(),
                    move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                        for sample in data.iter_mut() {
                            let f: f32 = cons.try_pop().unwrap_or(0.0);
                            *sample = (f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    |err| eprintln!("[AudioOutput] CPAL error: {err}"),
                    None,
                )
                .ok()?,
            _ => {
                eprintln!("[AudioOutput] unsupported sample format: {sample_format:?}");
                return None;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[AudioOutput] stream.play() failed: {e}");
        }

        Some(stream)
    }
}
