use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const SAMPLE_RATE: u32 = 48000;
const FRAME_SAMPLES: usize = 960;
const PRIME_FRAMES: usize = 3;
const MAX_BUFFER_FRAMES: usize = 30;

struct PeerJitter {
    frames: Vec<Vec<f32>>,
    primed: bool,
}

struct OutputInner {
    peers: HashMap<String, PeerJitter>,
    volume: f32,
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

    pub fn push_pcm(&self, peer_id: &str, pcm: Vec<f32>) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[AudioOutput] lock poisoned: {e}");
                return;
            }
        };
        let peer = guard
            .peers
            .entry(peer_id.to_string())
            .or_insert_with(|| PeerJitter {
                frames: Vec::new(),
                primed: false,
            });

        peer.frames.push(pcm);

        while peer.frames.len() > MAX_BUFFER_FRAMES {
            peer.frames.remove(0);
            eprintln!("[AudioOutput] dropped late frame for peer={peer_id}");
        }

        if !peer.primed && peer.frames.len() >= PRIME_FRAMES {
            peer.primed = true;
            eprintln!("[AudioOutput] peer={peer_id} primed ({PRIME_FRAMES} frames)");
        }
    }

    pub fn remove_peer(&self, peer_id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.peers.remove(peer_id);
            eprintln!("[AudioOutput] removed peer={peer_id}");
        }
    }

    pub fn set_volume(&self, volume: f32) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.volume = volume.clamp(0.0, 2.0);
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

fn mix_next_frame(inner: &mut OutputInner, out: &mut [f32]) -> MixResult {
    if inner.peers.is_empty() {
        return MixResult::NoPeers;
    }

    let mut any_primed = false;
    let mut has_data = false;
    out.fill(0.0);

    for peer in inner.peers.values_mut() {
        if !peer.primed {
            continue;
        }
        any_primed = true;

        if let Some(frame) = peer.frames.first() {
            let len = frame.len().min(out.len());
            for i in 0..len {
                out[i] += frame[i];
            }
            has_data = true;
            peer.frames.remove(0);
        }
        // Underrun: primed but empty — keep primed, output silence for this peer
    }

    if !any_primed {
        return MixResult::NoPeers;
    }
    if !has_data {
        return MixResult::Silence;
    }

    let volume = inner.volume;
    for s in out.iter_mut() {
        *s = (*s * volume).clamp(-1.0, 1.0);
    }

    MixResult::Data
}

fn output_thread(inner: Arc<Mutex<OutputInner>>, cancel: Arc<AtomicBool>) {
    let period = std::time::Duration::from_millis(20);
    let mut mix_buf = vec![0.0f32; FRAME_SAMPLES];
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
            mix_next_frame(&mut guard, &mut mix_buf)
        };

        match result {
            MixResult::Data => write_output(&mix_buf),
            MixResult::Silence => write_silence(),
            MixResult::NoPeers => { /* nothing to output */ }
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

    let mut child = Command::new("paplay")
        .args([
            "--device",
            dev,
            "--raw",
            &format!("--rate={SAMPLE_RATE}"),
            "--channels=1",
            "--format=float32le",
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
