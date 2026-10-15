use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::jitter::{PeerJitter, Playout, FRAME_SAMPLES};
use super::resample::nudge_length;

const SAMPLE_RATE: u32 = 48000;
/// How often a failed or missing sink is retried.
const REOPEN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

struct OutputInner {
    peers: HashMap<String, PeerJitter>,
    volume: f32,
    /// Per-peer playback gain, 0.0-2.0, keyed by peer id. Absent means unity.
    /// Kept separate from `peers` so a volume set before that peer's first
    /// packet arrives still applies once their jitter buffer is created.
    peer_volumes: HashMap<String, f32>,
    /// A device switch requested by `set_output_device`, applied by the output
    /// thread (which owns the sink) on its next tick. `Some(None)` means "the
    /// system default".
    pending_device: Option<Option<String>>,
}

enum MixResult {
    Data,
    Silence,
    NoPeers,
}

/// Native playback for one call. Owns its sink outright: creating it opens the
/// device, dropping it closes the device (and reaps paplay on Linux), so
/// nothing about a call's output outlives the call.
pub struct AudioOutput {
    inner: Arc<Mutex<OutputInner>>,
    cancel: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioOutput {
    pub fn new(device_id: Option<String>, volume: f32) -> Result<Self, String> {
        let inner = Arc::new(Mutex::new(OutputInner {
            peers: HashMap::new(),
            volume: volume.clamp(0.0, 2.0),
            peer_volumes: HashMap::new(),
            pending_device: None,
        }));
        let cancel = Arc::new(AtomicBool::new(false));

        let backend = Backend::open(device_id)?;

        let handle = {
            let inner = Arc::clone(&inner);
            let cancel = Arc::clone(&cancel);
            std::thread::Builder::new()
                .name("audio-output".into())
                .spawn(move || {
                    output_thread(inner, cancel, backend);
                })
                .map_err(|e| format!("Failed to spawn output thread: {e}"))?
        };

        Ok(Self {
            inner,
            cancel,
            handle: Some(handle),
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

    /// Move playback to another device mid-call. The output thread re-opens
    /// its sink on the new device on its next tick (within ~20ms).
    pub fn set_output_device(&self, device_id: Option<String>) {
        let device_id = device_id.filter(|d| !d.is_empty());
        eprintln!("[AudioOutput] device change requested: {device_id:?}");
        if let Ok(mut guard) = self.inner.lock() {
            guard.pending_device = Some(device_id);
        }
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            // The thread drops its backend on the way out, which closes the
            // CPAL stream / kills and waits for paplay.
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

fn output_thread(inner: Arc<Mutex<OutputInner>>, cancel: Arc<AtomicBool>, mut backend: Backend) {
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
    // at exactly 50 frames/s *by the system clock*. The device runs on its own
    // crystal, so the backend additionally trims or pads a sample now and then
    // to hold its buffer level (see FillController).
    let mut next = std::time::Instant::now() + period;

    eprintln!("[AudioOutput] output thread started");

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let (result, pending_device) = {
            let mut guard = match inner.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            let pending = guard.pending_device.take();
            (mix_next_frame(&mut guard, &mut mix_buf, &mut peer_buf), pending)
        };

        if let Some(device) = pending_device {
            backend.set_device(device);
        }
        backend.maintain();

        // Hand the echo canceller the signal we are about to play, before it
        // goes anywhere. This is its far-end reference. It runs every tick, even
        // when there is nothing to play: AEC3 lines the render and capture
        // streams up by cadence, so a silent tick still has to be accounted for.
        //
        // The reference is the 48 kHz frame before any device-rate conversion
        // or drift trimming. AEC3 estimates the render-to-capture delay itself;
        // the backend holds its buffer at a constant fill, so that delay stays
        // put instead of creeping as the two clocks drift apart.
        match result {
            MixResult::Data => {
                if let Some(aec) = super::aec::global() {
                    aec.process_render(&mix_buf);
                }
                backend.write(&mix_buf);
            }
            MixResult::Silence | MixResult::NoPeers => {
                if let Some(aec) = super::aec::global() {
                    aec.process_render(&silence);
                }
                if matches!(result, MixResult::Silence) {
                    backend.write(&silence);
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

    drop(backend);
    eprintln!("[AudioOutput] output thread stopped");
}

// ─── Clock-drift control ────────────────────────────────────────────────

/// What the writer should do with the frame it is about to queue.
#[derive(Debug, PartialEq, Eq)]
enum FillAction {
    /// Queue it as is.
    Write,
    /// Queue it with this many samples added (positive) or removed (negative).
    Nudge(i32),
    /// The sink drained (underrun): queue this many samples of silence first so
    /// playback restarts with the target cushion instead of hovering at empty.
    Reprime(usize),
    /// Far too much is queued (a stall): drop this frame to catch up at once.
    Skip,
}

/// Holds a playback buffer at a target fill level against clock drift.
///
/// The writer is paced by the system clock, the sink is drained by the audio
/// device's clock, and the two never agree exactly (100 ppm is typical, which is
/// a 20ms frame every few minutes). Uncorrected, the buffer slowly fills (latency
/// creeps up, then audio is dropped in a lump) or slowly empties (periodic
/// underrun clicks). Instead we watch the fill level, smoothed so scheduling
/// jitter does not register as drift, and add or remove one sample per 10ms
/// while it is off target: a 0.2% correction, far below what is audible.
struct FillController {
    target: f32,
    threshold: f32,
    skip_above: usize,
    reprime_below: usize,
    avg: Option<f32>,
}

impl FillController {
    /// All levels in samples at the sink's rate.
    fn new(target: usize, threshold: usize, skip_above: usize, reprime_below: usize) -> Self {
        Self {
            target: target as f32,
            threshold: threshold as f32,
            skip_above,
            reprime_below,
            avg: None,
        }
    }

    fn reset(&mut self) {
        self.avg = None;
    }

    /// Decide what to do with a frame of `frame_len` samples, given that `fill`
    /// samples are queued right now. `halves` is how many 10ms blocks the
    /// frame spans, i.e. the most samples a correction may move.
    fn decide(&mut self, fill: usize, halves: i32) -> FillAction {
        if fill < self.reprime_below {
            self.avg = Some(self.target);
            let deficit = (self.target as usize).saturating_sub(fill);
            return if deficit > 0 {
                FillAction::Reprime(deficit)
            } else {
                FillAction::Write
            };
        }
        if fill >= self.skip_above {
            self.avg = Some(self.target);
            return FillAction::Skip;
        }
        // ~0.4s smoothing at one decision per 20ms frame.
        const ALPHA: f32 = 0.05;
        let avg = match self.avg {
            Some(a) => a + ALPHA * (fill as f32 - a),
            None => fill as f32,
        };
        self.avg = Some(avg);
        if avg > self.target + self.threshold {
            FillAction::Nudge(-halves)
        } else if avg < self.target - self.threshold {
            FillAction::Nudge(halves)
        } else {
            FillAction::Write
        }
    }
}

/// Apply a `Nudge`, spreading it across the frame's 10ms halves so no single
/// spot carries more than one sample of correction.
fn apply_nudge(frame: &mut Vec<f32>, delta: i32) {
    if delta == 0 || frame.is_empty() {
        return;
    }
    let parts = delta.unsigned_abs() as usize;
    let step = delta.signum();
    let chunk = frame.len().div_ceil(parts);
    let mut out = Vec::with_capacity(frame.len() + parts);
    for piece in frame.chunks(chunk) {
        let mut piece = piece.to_vec();
        nudge_length(&mut piece, step);
        out.extend_from_slice(&piece);
    }
    *frame = out;
}

// ─── Linux backend: paplay subprocess ───────────────────────────────────

#[cfg(target_os = "linux")]
struct Backend {
    /// Pulse sink name, `None` for the default sink.
    device: Option<String>,
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    fill: FillController,
    frame: Vec<f32>,
    bytes: Vec<u8>,
    last_spawn: Option<std::time::Instant>,
}

#[cfg(target_os = "linux")]
impl Backend {
    fn open(device: Option<String>) -> Result<Self, String> {
        let mut backend = Self {
            device: device.filter(|d| !d.is_empty()),
            child: None,
            stdin: None,
            // paplay pulls eagerly into its own `--latency-msec` buffer, so the
            // pipe in front of it is normally empty: target 0, trim once more
            // than a frame sits there on average, drop a frame past 160ms. An
            // empty pipe says nothing about underrun, so never re-prime.
            fill: FillController::new(0, FRAME_SAMPLES, FRAME_SAMPLES * 8, 0),
            frame: Vec::with_capacity(FRAME_SAMPLES + 4),
            bytes: Vec::with_capacity((FRAME_SAMPLES + 4) * 4),
            last_spawn: None,
        };
        backend.spawn()?;
        Ok(backend)
    }

    fn spawn(&mut self) -> Result<(), String> {
        use std::process::{Command, Stdio};

        self.last_spawn = Some(std::time::Instant::now());
        let dev = self.device.clone().unwrap_or_else(|| "@DEFAULT_SINK@".into());

        // Without --latency-msec, paplay takes the server's default playback
        // buffer (hundreds of ms, historically up to ~2s), and that sits on top
        // of the jitter buffer as pure end-to-end call delay. 50ms is low enough
        // to be imperceptible while leaving ~2 frames of slack for the
        // 20ms-paced writer.
        let mut child = Command::new("paplay")
            .args([
                &format!("--device={dev}"),
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

        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("No stdin from paplay".into());
        };
        eprintln!("[AudioOutput] paplay spawned (pid={}) device={dev}", child.id());
        self.child = Some(child);
        self.stdin = Some(stdin);
        self.fill.reset();
        Ok(())
    }

    fn shutdown(&mut self) {
        // Closing stdin first lets paplay drain and exit by itself; the kill is
        // for a paplay stuck on a suspended sink.
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[AudioOutput] paplay (pid={pid}) stopped");
        }
    }

    /// Switch sinks by restarting paplay on the new one. The ~50ms paplay had
    /// buffered is lost, which is inaudible next to the switch itself.
    fn set_device(&mut self, device: Option<String>) {
        self.device = device;
        self.shutdown();
        if let Err(e) = self.spawn() {
            eprintln!("[AudioOutput] device switch failed: {e}");
        }
    }

    /// Respawn paplay if it died (e.g. the sink disappeared).
    fn maintain(&mut self) {
        if self.stdin.is_some() {
            return;
        }
        if self.last_spawn.is_some_and(|t| t.elapsed() < REOPEN_INTERVAL) {
            return;
        }
        self.shutdown();
        if let Err(e) = self.spawn() {
            eprintln!("[AudioOutput] paplay respawn failed: {e}");
        }
    }

    /// Bytes written to paplay's stdin that it has not read yet.
    fn pipe_backlog(stdin: &std::process::ChildStdin) -> Option<usize> {
        use std::os::unix::io::AsRawFd;
        let mut n: libc::c_int = 0;
        // SAFETY: FIONREAD writes one c_int through the pointer, which points at
        // a live local; the fd is owned by `stdin` and open for this call.
        let rc = unsafe { libc::ioctl(stdin.as_raw_fd(), libc::FIONREAD, &mut n) };
        (rc == 0 && n >= 0).then_some(n as usize)
    }

    fn write(&mut self, buf: &[f32]) {
        let Some(stdin) = self.stdin.as_mut() else {
            return;
        };

        self.frame.clear();
        self.frame.extend_from_slice(buf);

        // Drift: if paplay's device runs slower than our clock, the excess
        // piles up in the pipe (up to its 64 KiB, ~340ms) as added latency.
        // Measure it and trim. The opposite direction (device faster) only
        // shows up inside paplay's own buffer, which we cannot observe; there
        // the sound server's underrun handling inserts silence, rarely (a 20ms
        // gap every few minutes at 100 ppm).
        if let Some(backlog) = Self::pipe_backlog(stdin) {
            match self.fill.decide(backlog / 4, 2) {
                FillAction::Skip => return,
                FillAction::Nudge(d) if d < 0 => apply_nudge(&mut self.frame, d),
                _ => {}
            }
        }

        self.bytes.clear();
        for s in &self.frame {
            self.bytes.extend_from_slice(&s.to_le_bytes());
        }
        if let Err(e) = std::io::Write::write_all(stdin, &self.bytes) {
            eprintln!("[AudioOutput] paplay write failed ({e}); will respawn");
            self.shutdown();
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for Backend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ─── Windows / macOS backend: CPAL with ring buffer ─────────────────────

#[cfg(not(target_os = "linux"))]
use cpalsink::Backend;

// Compiled into Linux test builds too (unused there), so `cargo test` and
// clippy on Linux type-check the CPAL path that only ships on Windows/macOS.
#[cfg(any(not(target_os = "linux"), test))]
#[cfg_attr(target_os = "linux", allow(dead_code))]
mod cpalsink {
    use super::super::resample::LinearResampler;
    use super::{apply_nudge, FillAction, FillController, REOPEN_INTERVAL, SAMPLE_RATE};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use ringbuf::traits::*;
    use ringbuf::HeapRb;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Ring fill the writer aims for, in milliseconds. The writer adds 20ms at a
    /// time and the device pulls in blocks of ~10ms, so this leaves a full
    /// frame of cushion at the low point.
    const TARGET_MS: usize = 30;
    const THRESHOLD_MS: usize = 10;
    const SKIP_ABOVE_MS: usize = 250;
    const REPRIME_BELOW_MS: usize = 2;

    struct Sink {
        /// Mono samples at the device rate; the callback fans them out.
        prod: ringbuf::HeapProd<f32>,
        _stream: cpal::Stream,
        failed: Arc<AtomicBool>,
        resampler: LinearResampler,
        fill: FillController,
        scratch: Vec<f32>,
    }

    impl Sink {
        fn write(&mut self, samples: &[f32]) {
            self.scratch.clear();
            self.resampler.process(samples, &mut self.scratch);

            let fill = self.prod.occupied_len();
            match self.fill.decide(fill, 2) {
                FillAction::Write => {}
                FillAction::Nudge(d) => apply_nudge(&mut self.scratch, d),
                FillAction::Reprime(n) => {
                    let pad = n.min(self.prod.vacant_len());
                    self.prod.push_iter(std::iter::repeat_n(0.0f32, pad));
                }
                FillAction::Skip => return,
            }
            self.prod.push_slice(&self.scratch);
        }
    }

    pub(super) struct Backend {
        device_id: Option<String>,
        sink: Option<Sink>,
        last_attempt: Option<std::time::Instant>,
    }

    impl Backend {
        pub(super) fn open(device_id: Option<String>) -> Result<Self, String> {
            let mut backend = Self {
                device_id: device_id.filter(|d| !d.is_empty()),
                sink: None,
                last_attempt: None,
            };
            // A device that is not ready yet is retried from the output thread,
            // so a failure here is not fatal to the call.
            backend.reopen();
            Ok(backend)
        }

        fn reopen(&mut self) {
            self.sink = None; // release the old stream before opening a new one
            self.last_attempt = Some(std::time::Instant::now());
            match open_sink(self.device_id.as_deref()) {
                Ok(sink) => self.sink = Some(sink),
                Err(e) => eprintln!("[AudioOutput] cannot open output: {e}"),
            }
        }

        pub(super) fn set_device(&mut self, device_id: Option<String>) {
            self.device_id = device_id;
            self.reopen();
        }

        /// Rebuild the stream after a device error (unplugged headset, default
        /// device changed, stream invalidated) or a failed open.
        pub(super) fn maintain(&mut self) {
            let broken = match &self.sink {
                Some(s) => s.failed.load(Ordering::Relaxed),
                None => true,
            };
            if !broken {
                return;
            }
            if self.last_attempt.is_some_and(|t| t.elapsed() < REOPEN_INTERVAL) {
                return;
            }
            eprintln!("[AudioOutput] output stream lost; re-opening");
            self.reopen();
        }

        pub(super) fn write(&mut self, samples: &[f32]) {
            if let Some(sink) = self.sink.as_mut() {
                sink.write(samples);
            }
        }
    }

    fn format_rank(f: cpal::SampleFormat) -> Option<u8> {
        match f {
            cpal::SampleFormat::F32 => Some(0),
            cpal::SampleFormat::I16 => Some(1),
            cpal::SampleFormat::I32 => Some(2),
            cpal::SampleFormat::U16 => Some(3),
            _ => None,
        }
    }

    fn find_device(host: &cpal::Host, device_id: Option<&str>) -> Option<cpal::Device> {
        if let Some(id) = device_id {
            let found = host.output_devices().ok().and_then(|mut devices| {
                devices.find(|d| d.id().map(|i| i.to_string() == id).unwrap_or(false))
            });
            if found.is_some() {
                return found;
            }
            eprintln!("[AudioOutput] output device '{id}' not found; using the default");
        }
        host.default_output_device()
    }

    /// Prefer a configuration that runs at 48 kHz natively, keeping the
    /// device's default channel count when it can; otherwise take the default
    /// configuration and resample.
    fn choose_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
        let default = device.default_output_config().ok();
        let default_channels = default.as_ref().map(|c| c.channels());
        let ranges: Vec<cpal::SupportedStreamConfigRange> = device
            .supported_output_configs()
            .map(|it| it.collect())
            .unwrap_or_default();

        let at_48k = ranges
            .iter()
            .filter(|r| r.min_sample_rate() <= SAMPLE_RATE && SAMPLE_RATE <= r.max_sample_rate())
            .filter_map(|r| format_rank(r.sample_format()).map(|rank| (r, rank)))
            .min_by_key(|(r, rank)| (Some(r.channels()) != default_channels, *rank, r.channels()));
        if let Some((range, _)) = at_48k {
            return Ok((*range).with_sample_rate(SAMPLE_RATE));
        }

        if let Some(d) = default {
            if format_rank(d.sample_format()).is_some() {
                return Ok(d);
            }
        }
        ranges
            .iter()
            .filter_map(|r| format_rank(r.sample_format()).map(|rank| (r, rank)))
            .min_by_key(|(_, rank)| *rank)
            .map(|(r, _)| (*r).with_max_sample_rate())
            .ok_or_else(|| "device offers no usable output configuration".to_string())
    }

    fn open_sink(device_id: Option<&str>) -> Result<Sink, String> {
        let host = cpal::default_host();
        let device = find_device(&host, device_id).ok_or("no output device")?;
        let supported = choose_config(&device)?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.config();
        let rate = config.sample_rate;
        let ms = (rate as usize / 1000).max(1);

        let dev_name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "unknown".into());
        eprintln!(
            "[AudioOutput] CPAL output device: {dev_name} ({}ch {}Hz {:?})",
            config.channels, rate, sample_format
        );

        // One second of mono at the device rate; the controller keeps it near
        // TARGET_MS, so this only matters as an upper bound.
        let (prod, cons) = HeapRb::<f32>::new(rate as usize).split();
        let failed = Arc::new(AtomicBool::new(false));

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build::<f32>(&device, &config, cons, &failed),
            cpal::SampleFormat::I16 => build::<i16>(&device, &config, cons, &failed),
            cpal::SampleFormat::I32 => build::<i32>(&device, &config, cons, &failed),
            cpal::SampleFormat::U16 => build::<u16>(&device, &config, cons, &failed),
            other => return Err(format!("unsupported sample format: {other:?}")),
        }
        .map_err(|e| format!("build_output_stream: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("stream.play() failed: {e}"))?;

        Ok(Sink {
            prod,
            _stream: stream,
            failed,
            resampler: LinearResampler::new(SAMPLE_RATE, rate),
            fill: FillController::new(
                TARGET_MS * ms,
                THRESHOLD_MS * ms,
                SKIP_ABOVE_MS * ms,
                REPRIME_BELOW_MS * ms,
            ),
            scratch: Vec::with_capacity(rate as usize / 25),
        })
    }

    /// The callback reads one mono sample per device frame and copies it to
    /// every channel. Feeding mono samples one-per-interleaved-slot (as before)
    /// played a stereo device at double speed and pitch.
    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        mut cons: ringbuf::HeapCons<f32>,
        failed: &Arc<AtomicBool>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: cpal::SizedSample + cpal::FromSample<f32>,
    {
        let channels = config.channels.max(1) as usize;
        let failed = Arc::clone(failed);
        device.build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                for frame in data.chunks_mut(channels) {
                    let s: f32 = cons.try_pop().unwrap_or(0.0).clamp(-1.0, 1.0);
                    let v = T::from_sample(s);
                    for slot in frame.iter_mut() {
                        *slot = v;
                    }
                }
            },
            move |err| {
                eprintln!("[AudioOutput] CPAL error: {err}");
                // An underrun is a glitch, not a dead stream; everything else
                // (device gone, stream invalidated, backend failure) needs the
                // stream rebuilt, which the output thread does.
                if !matches!(err, cpal::StreamError::BufferUnderrun) {
                    failed.store(true, Ordering::Relaxed);
                }
            },
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_steady_when_on_target() {
        let mut c = FillController::new(1440, 480, 12_000, 96);
        for _ in 0..100 {
            assert_eq!(c.decide(1440, 2), FillAction::Write);
        }
    }

    #[test]
    fn trims_when_the_device_runs_slow_and_pads_when_it_runs_fast() {
        let mut slow = FillController::new(1440, 480, 12_000, 96);
        let mut action = FillAction::Write;
        for _ in 0..200 {
            action = slow.decide(2400, 2);
        }
        assert_eq!(action, FillAction::Nudge(-2), "overfull buffer must shed samples");

        let mut fast = FillController::new(1440, 480, 12_000, 96);
        for _ in 0..200 {
            action = fast.decide(600, 2);
        }
        assert_eq!(action, FillAction::Nudge(2), "underfull buffer must gain samples");
    }

    #[test]
    fn ignores_momentary_scheduling_jitter() {
        let mut c = FillController::new(1440, 480, 12_000, 96);
        c.decide(1440, 2);
        // One late tick looks overfull, but it is not drift.
        assert_eq!(c.decide(2400, 2), FillAction::Write);
    }

    #[test]
    fn reprimes_after_an_underrun_and_skips_after_a_stall() {
        let mut c = FillController::new(1440, 480, 12_000, 96);
        assert_eq!(c.decide(0, 2), FillAction::Reprime(1440));
        assert_eq!(c.decide(20_000, 2), FillAction::Skip);
    }

    #[test]
    fn nudge_moves_exactly_the_requested_samples() {
        let base: Vec<f32> = (0..960).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut a = base.clone();
        apply_nudge(&mut a, -2);
        assert_eq!(a.len(), 958);
        let mut b = base.clone();
        apply_nudge(&mut b, 2);
        assert_eq!(b.len(), 962);
    }
}
