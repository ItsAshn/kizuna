// Per-peer receive jitter buffer: reordering, loss concealment, and adaptive depth.
//
// This buffers *encoded* Opus packets rather than decoded PCM. Decoding at
// playout time is what makes Opus's inband FEC usable: a lost frame is
// reconstructed from the redundant copy carried inside the *following* packet,
// which is only possible if that packet hasn't been decoded yet.
//
// Packets are keyed by RTP sequence number, so the buffer can tell three
// situations apart that the previous PCM-FIFO could not:
//
//   * the next frame is here            -> decode normally
//   * the next frame is missing but a later one is buffered
//                                       -> genuine loss: recover via FEC, else PLC
//   * nothing newer is buffered at all  -> the sender stopped (DTX, or a stall);
//                                          emit silence, never invent audio
//
// Depth adapts to *timing*, not to loss. A lost packet is concealed by FEC/PLC
// no matter how deep the buffer is, so growing on loss only added latency: on a
// link with steady 1% loss the old rule ratcheted the target up to its 300ms
// ceiling and never came back down, because every loss also reset the shrink
// counter. Now the target grows only when a packet arrives too late to be
// played (or the buffer runs dry under a stall), is sized from a smoothed
// measure of inter-arrival jitter, and shrinks whenever that jitter has been
// low for a while, whatever the loss rate.

use std::collections::BTreeMap;
use std::time::Instant;

use opus2::{Channels, Decoder};

/// 20ms at 48kHz — the frame size the encoder produces.
pub const FRAME_SAMPLES: usize = 960;
const SAMPLE_RATE: f32 = 48000.0;

/// Adaptive target depth bounds, in 20ms frames.
const MIN_TARGET_FRAMES: usize = 2;
/// Default ceiling (160ms). Late arrivals alone cannot push past this; only
/// measured jitter that genuinely needs more can.
const DEFAULT_CAP_FRAMES: usize = 8;
/// Absolute ceiling (300ms), reachable only on a link whose measured jitter
/// calls for it.
const MAX_TARGET_FRAMES: usize = 15;
const INITIAL_TARGET_FRAMES: usize = 3;
/// Hard cap; beyond this the sender is far ahead of us and old audio is stale.
const MAX_BUFFER_FRAMES: usize = 40;
/// How far past target the buffer may sit before it walks latency back down.
const OVERFULL_SLACK: usize = 4;
/// Playouts the jitter estimate must sit below the current target before the
/// target steps down one frame (150 * 20ms = 3s).
const SHRINK_AFTER_CALM_FRAMES: u32 = 150;
/// Playouts after a growth step during which further late packets from the
/// same burst do not grow the target again.
const GROW_COOLDOWN_FRAMES: u32 = 10;
/// How many jitter standard-ish deviations the buffer should cover. The RFC
/// 3550 estimator is a mean absolute deviation; three of them comfortably
/// covers the tail of real-world arrival spread.
const JITTER_HEADROOM: f64 = 3.0;

#[derive(Debug, PartialEq, Eq)]
pub enum Playout {
    /// `out` holds audio for this peer.
    Data,
    /// Peer contributed nothing this tick.
    Silence,
}

pub struct PeerJitter {
    decoder: Decoder,
    /// Encoded packets keyed by extended (unwrapped) sequence number.
    packets: BTreeMap<u64, Vec<u8>>,
    /// Extended sequence number of the frame to play next.
    next_seq: Option<u64>,

    // 16-bit wire sequence numbers, unwrapped to a monotonic u64.
    last_wire_seq: Option<u16>,
    seq_cycles: u64,
    /// Highest extended sequence seen, with its RTP timestamp — used to tell a
    /// deliberate DTX pause from a network stall.
    highest_seq: Option<u64>,
    highest_ts: Option<u32>,
    /// Arrival counter used when the server is too old to send sequence numbers.
    synth_seq: u64,

    primed: bool,
    /// Set when playout ran dry; resolved on the next arrival, which reveals
    /// whether the sender had stopped (DTX) or we simply fell behind.
    starved: bool,
    target_frames: usize,
    /// Consecutive playouts during which jitter called for a shallower target.
    calm_frames: u32,
    grow_cooldown: u32,

    // RFC 3550 interarrival jitter, in samples: a running mean of how much each
    // packet's transit time differs from the previous one's.
    epoch: Option<Instant>,
    last_transit: Option<f64>,
    jitter: f64,
    last_wire_ts: Option<u32>,
    ts_cycles: u64,

    /// Last sample handed out, used to ramp out of a gap instead of stepping to
    /// zero (a step is an audible click).
    last_sample: f32,
}

impl PeerJitter {
    pub fn new() -> Result<Self, String> {
        let decoder = Decoder::new(48000, Channels::Mono)
            .map_err(|e| format!("Opus decoder: {e}"))?;
        Ok(Self {
            decoder,
            packets: BTreeMap::new(),
            next_seq: None,
            last_wire_seq: None,
            seq_cycles: 0,
            highest_seq: None,
            highest_ts: None,
            synth_seq: 0,
            primed: false,
            starved: false,
            target_frames: INITIAL_TARGET_FRAMES,
            calm_frames: 0,
            grow_cooldown: 0,
            epoch: None,
            last_transit: None,
            jitter: 0.0,
            last_wire_ts: None,
            ts_cycles: 0,
            last_sample: 0.0,
        })
    }

    /// Current target depth in 20ms frames.
    #[cfg(test)]
    pub fn target_frames(&self) -> usize {
        self.target_frames
    }

    /// Update the interarrival jitter estimate with a packet that arrived at
    /// `now` carrying media time `media_ts` (in samples). DTX pauses advance
    /// both clocks together, so they do not register as jitter.
    fn observe_arrival(&mut self, now: Instant, media_ts: u64) {
        let epoch = *self.epoch.get_or_insert(now);
        let arrival = now.saturating_duration_since(epoch).as_secs_f64() * SAMPLE_RATE as f64;
        let transit = arrival - media_ts as f64;
        if let Some(prev) = self.last_transit {
            let d = (transit - prev).abs();
            // A multi-second jump is a clock reset or a sender restart, not
            // jitter; don't let one event inflate the buffer for a minute.
            if d < SAMPLE_RATE as f64 * 2.0 {
                self.jitter += (d - self.jitter) / 16.0;
            }
        }
        self.last_transit = Some(transit);
    }

    /// Depth the measured jitter calls for, before caps.
    fn jitter_frames(&self) -> usize {
        let needed = (JITTER_HEADROOM * self.jitter / FRAME_SAMPLES as f64).ceil() as usize;
        1 + needed
    }

    /// Highest target allowed right now: the default cap, unless measured
    /// jitter needs more, and never past the absolute ceiling.
    fn cap(&self) -> usize {
        DEFAULT_CAP_FRAMES
            .max(self.jitter_frames())
            .min(MAX_TARGET_FRAMES)
    }

    /// Unwrap a 16-bit wire sequence number into a monotonic 64-bit one.
    fn extend_seq(&mut self, wire: u16) -> u64 {
        let last = match self.last_wire_seq {
            None => {
                self.last_wire_seq = Some(wire);
                return wire as u64;
            }
            Some(l) => l,
        };

        // Forward vs backward is decided on the short way round the circle.
        if wire.wrapping_sub(last) < 0x8000 {
            if wire < last {
                self.seq_cycles += 1; // wrapped past 65535
            }
            self.last_wire_seq = Some(wire);
            self.seq_cycles * 0x1_0000 + wire as u64
        } else {
            // Reordered packet from before `last`; don't move the high-water mark.
            let back = last.wrapping_sub(wire) as u64;
            (self.seq_cycles * 0x1_0000 + last as u64).saturating_sub(back)
        }
    }

    /// Unwrap a 32-bit RTP timestamp into a monotonic 64-bit one, the same way
    /// as sequence numbers. Only differences matter (for jitter), so the
    /// starting offset is irrelevant.
    fn extend_ts(&mut self, wire: u32) -> u64 {
        let Some(last) = self.last_wire_ts else {
            self.last_wire_ts = Some(wire);
            return wire as u64 + (1 << 32);
        };
        if wire.wrapping_sub(last) < 0x8000_0000 {
            if wire < last {
                self.ts_cycles += 1;
            }
            self.last_wire_ts = Some(wire);
            (self.ts_cycles + 1) * (1 << 32) + wire as u64
        } else {
            let back = last.wrapping_sub(wire) as u64;
            ((self.ts_cycles + 1) * (1 << 32) + last as u64).saturating_sub(back)
        }
    }

    /// Accept a packet. `seq`/`ts` are `None` when talking to a server old enough
    /// that it forwards bare Opus payloads; the buffer then degrades to arrival
    /// order, which disables reordering and FEC but keeps everything else.
    pub fn push(&mut self, seq: Option<u16>, ts: Option<u32>, payload: Vec<u8>) {
        self.push_at(Instant::now(), seq, ts, payload);
    }

    /// `push` with an explicit arrival time, so tests can model a network.
    pub fn push_at(&mut self, now: Instant, seq: Option<u16>, ts: Option<u32>, payload: Vec<u8>) {
        let ext = match seq {
            Some(w) => self.extend_seq(w),
            None => {
                let s = self.synth_seq;
                self.synth_seq += 1;
                s
            }
        };

        // Jitter needs the sender's media clock. Without timestamps (legacy
        // server) a DTX pause would be indistinguishable from a huge delay
        // spike, so the estimate is simply not kept; late arrivals and stalls
        // still adapt the depth.
        if let Some(t) = ts {
            let media_ts = self.extend_ts(t);
            self.observe_arrival(now, media_ts);
        }

        // A packet we have already played past is useless, and it is the one
        // thing that says the buffer is too shallow: it arrived, just after its
        // slot was concealed. That — not loss — is what deepens the buffer.
        if self.next_seq.is_some_and(|n| ext < n) {
            self.grow_target();
            return;
        }

        // Measured jitter can call for more depth before anything is late.
        let wanted = self.jitter_frames().min(self.cap());
        if wanted > self.target_frames {
            self.target_frames = wanted;
            self.calm_frames = 0;
        }

        if self.starved {
            self.starved = false;
            self.resolve_starvation(ext, ts);
        }

        if self.highest_seq.is_none_or(|h| ext >= h) {
            self.highest_seq = Some(ext);
            self.highest_ts = ts;
        }

        self.packets.insert(ext, payload);

        while self.packets.len() > MAX_BUFFER_FRAMES {
            if let Some(oldest) = self.packets.keys().next().copied() {
                self.packets.remove(&oldest);
                if self.next_seq.is_some_and(|n| n <= oldest) {
                    self.next_seq = Some(oldest + 1);
                }
            }
        }

        if !self.primed && self.packets.len() >= self.target_frames {
            self.primed = true;
            if self.next_seq.is_none() {
                self.next_seq = self.packets.keys().next().copied();
            }
        }
    }

    /// After a dry spell, decide whether it was the sender's doing or ours.
    ///
    /// With DTX the sender simply stops transmitting during silence, so its
    /// sequence numbers stay contiguous while the RTP timestamp jumps by the
    /// length of the pause. A congestion stall looks different: the timestamp
    /// advances exactly one frame per sequence step, because every packet the
    /// sender emitted was real. Only the latter is a reason to buffer deeper —
    /// growing on every talk spurt would ratchet latency up over a call.
    fn resolve_starvation(&mut self, ext: u64, ts: Option<u32>) {
        let (Some(prev_seq), Some(prev_ts), Some(ts)) = (self.highest_seq, self.highest_ts, ts)
        else {
            // No timestamps to reason with (legacy server): assume it was us.
            self.grow_target();
            return;
        };

        let seq_advance = ext.saturating_sub(prev_seq);
        let ts_advance = ts.wrapping_sub(prev_ts) as u64;
        let continuous = seq_advance.saturating_mul(FRAME_SAMPLES as u64);

        // One frame of slack absorbs rounding between the two clocks.
        if ts_advance <= continuous + FRAME_SAMPLES as u64 {
            self.grow_target();
        }
    }

    /// One step deeper, for a late packet or a stall. Bounded by `cap()`, and
    /// rate-limited so one burst of stragglers counts once.
    fn grow_target(&mut self) {
        self.calm_frames = 0;
        if self.grow_cooldown > 0 {
            return;
        }
        if self.target_frames < self.cap() {
            self.target_frames += 1;
            self.grow_cooldown = GROW_COOLDOWN_FRAMES;
        }
    }

    /// Called once per playout tick. Steps the target down when measured jitter
    /// has wanted less depth for long enough. Loss plays no part: it neither
    /// grows the target nor holds off a shrink.
    fn adapt_on_tick(&mut self) {
        self.grow_cooldown = self.grow_cooldown.saturating_sub(1);
        let floor = self.jitter_frames().clamp(MIN_TARGET_FRAMES, MAX_TARGET_FRAMES);
        if self.target_frames > floor {
            self.calm_frames += 1;
            if self.calm_frames >= SHRINK_AFTER_CALM_FRAMES {
                self.target_frames -= 1;
                self.calm_frames = 0;
            }
        } else {
            self.calm_frames = 0;
        }
    }

    /// Produce one 20ms frame into `out` (fully overwritten).
    pub fn pop_frame(&mut self, out: &mut [f32]) -> Playout {
        self.adapt_on_tick();
        if !self.primed {
            return self.ramp_out(out);
        }
        let Some(next) = self.next_seq else {
            return self.ramp_out(out);
        };

        // Latency creep: a burst can leave the buffer permanently deeper than it
        // needs to be, and a frame-clocked playout will never drain it on its
        // own. Skip a frame per tick until it is back near target.
        if self.packets.len() > self.target_frames + OVERFULL_SLACK {
            if let Some(oldest) = self.packets.keys().next().copied() {
                self.packets.remove(&oldest);
                self.next_seq = Some(oldest.max(next) + 1);
            }
        }

        let next = self.next_seq.unwrap_or(next);

        if let Some(packet) = self.packets.remove(&next) {
            let n = self.decode(&packet, out, false);
            self.next_seq = Some(next + 1);
            return self.finish(out, n);
        }

        let have_newer = self.packets.keys().next().is_some_and(|&k| k > next);
        if have_newer {
            // Something newer arrived, so this frame is lost or late. Either
            // way it is concealed now and the buffer is left alone: if it was
            // merely late, its arrival after this slot grows the target (see
            // `push_at`); if it was lost, depth would not have helped.
            //
            // Opus carries a lower-bitrate copy of the previous frame inside the
            // next packet. If seq+1 is buffered we can rebuild the lost frame
            // from it; the packet stays put so it still decodes normally next tick.
            let n = match self.packets.get(&(next + 1)).cloned() {
                Some(following) => self.decode(&following, out, true),
                None => self.decode(&[], out, false), // no FEC source: conceal
            };
            self.next_seq = Some(next + 1);
            return self.finish(out, n);
        }

        // Nothing newer buffered. The sender has stopped — DTX, a stall, or the
        // talker went quiet. Concealment here would invent audio out of silence,
        // so ramp out and refill before resuming.
        self.starved = true;
        self.primed = false;
        self.ramp_out(out)
    }

    fn decode(&mut self, data: &[u8], out: &mut [f32], fec: bool) -> usize {
        match self.decoder.decode_float(data, out, fec) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[Jitter] decode failed (fec={fec}): {e}; concealing");
                self.decoder.decode_float(&[], out, false).unwrap_or(0)
            }
        }
    }

    fn finish(&mut self, out: &mut [f32], decoded: usize) -> Playout {
        if decoded == 0 {
            return self.ramp_out(out);
        }
        for s in out[..decoded].iter_mut() {
            *s = s.clamp(-1.0, 1.0);
        }
        out[decoded..].fill(0.0);
        self.last_sample = out[decoded - 1];
        Playout::Data
    }

    /// Decay the last sample to zero over ~5ms. Stepping straight to digital
    /// silence mid-waveform is a discontinuity, and it clicks.
    fn ramp_out(&mut self, out: &mut [f32]) -> Playout {
        if self.last_sample.abs() <= 1e-6 {
            self.last_sample = 0.0;
            return Playout::Silence;
        }
        let decay = (-1.0f32 / (0.005 * SAMPLE_RATE)).exp();
        let mut s = self.last_sample;
        for o in out.iter_mut() {
            s *= decay;
            *o = s;
        }
        self.last_sample = 0.0;
        Playout::Data
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opus2::{Application, Encoder};
    use std::sync::OnceLock;
    use std::time::Duration;

    /// One encodable 20ms frame of a tone, so decodes produce real audio.
    fn tone_packet(encoder: &mut Encoder, phase: &mut f32) -> Vec<u8> {
        let mut pcm = vec![0.0f32; FRAME_SAMPLES];
        for s in pcm.iter_mut() {
            *s = (*phase).sin() * 0.3;
            *phase += 2.0 * std::f32::consts::PI * 440.0 / 48000.0;
        }
        encoder.encode_vec_float(&pcm, 4000).expect("encode")
    }

    fn encoder() -> Encoder {
        let mut e = Encoder::new(48000, Channels::Mono, Application::Voip).expect("encoder");
        e.set_inband_fec(true).expect("fec");
        e
    }

    fn base() -> Instant {
        static BASE: OnceLock<Instant> = OnceLock::new();
        *BASE.get_or_init(Instant::now)
    }

    fn at_ms(ms: f64) -> Instant {
        base() + Duration::from_secs_f64(ms / 1000.0)
    }

    fn ts_of(seq: u16) -> u32 {
        (seq as u32).wrapping_mul(FRAME_SAMPLES as u32)
    }

    /// Fill a buffer with `count` sequential packets starting at `first_seq`,
    /// arriving exactly on their 20ms cadence (no jitter).
    fn prime(j: &mut PeerJitter, enc: &mut Encoder, phase: &mut f32, first_seq: u16, count: u16) {
        for i in 0..count {
            let seq = first_seq.wrapping_add(i);
            j.push_at(at_ms(seq as f64 * 20.0), Some(seq), Some(ts_of(seq)), tone_packet(enc, phase));
        }
    }

    /// Small deterministic PRNG so the network simulations are reproducible.
    struct Lcg(u64);
    impl Lcg {
        fn next_f64(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Drive a buffer like the real output thread does: the sender emits frame
    /// `k` at `k * 20ms`, it arrives `delay_ms(k)` later unless `lost(k)`, and
    /// playout ticks every 20ms. Returns the target depth after every tick.
    fn simulate(
        frames: u64,
        mut lost: impl FnMut(u64) -> bool,
        mut delay_ms: impl FnMut(u64) -> f64,
    ) -> Vec<usize> {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        let mut arrivals: Vec<(f64, u64, Vec<u8>)> = (0..frames)
            .filter_map(|k| {
                let packet = tone_packet(&mut enc, &mut phase);
                if lost(k) {
                    None
                } else {
                    Some((k as f64 * 20.0 + delay_ms(k), k, packet))
                }
            })
            .collect();
        arrivals.sort_by(|a, b| a.0.total_cmp(&b.0));

        let mut targets = Vec::with_capacity(frames as usize);
        let mut next = arrivals.into_iter().peekable();
        // Playout ticks run a little past the last send so the tail drains.
        for tick in 0..frames + 50 {
            let now = tick as f64 * 20.0;
            while next.peek().is_some_and(|(t, _, _)| *t <= now) {
                let (t, k, packet) = next.next().unwrap();
                let seq = (k & 0xFFFF) as u16;
                j.push_at(at_ms(t), Some(seq), Some(ts_of(seq)), packet);
            }
            j.pop_frame(&mut out);
            targets.push(j.target_frames());
        }
        targets
    }

    #[test]
    fn extends_sequence_across_the_16_bit_wrap() {
        let mut j = PeerJitter::new().unwrap();
        assert_eq!(j.extend_seq(65534), 65534);
        assert_eq!(j.extend_seq(65535), 65535);
        // Wrapping forward must keep counting up, not restart at 0.
        assert_eq!(j.extend_seq(0), 65536);
        assert_eq!(j.extend_seq(1), 65537);
    }

    #[test]
    fn extends_reordered_sequence_without_moving_the_high_water_mark() {
        let mut j = PeerJitter::new().unwrap();
        assert_eq!(j.extend_seq(100), 100);
        assert_eq!(j.extend_seq(103), 103);
        // A straggler from before 103 must map below it, not wrap forward.
        assert_eq!(j.extend_seq(101), 101);
        assert_eq!(j.extend_seq(104), 104);
    }

    #[test]
    fn extends_timestamps_across_the_32_bit_wrap() {
        let mut j = PeerJitter::new().unwrap();
        let a = j.extend_ts(u32::MAX - 959);
        let b = j.extend_ts(0); // wrapped forward by 960
        assert_eq!(b - a, 960);
        let c = j.extend_ts(u32::MAX - 959); // reordered straggler
        assert_eq!(c, a);
    }

    #[test]
    fn does_not_play_until_primed() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        prime(&mut j, &mut enc, &mut phase, 0, 1);
        assert_eq!(j.pop_frame(&mut out), Playout::Silence, "one packet is not a full buffer");

        prime(&mut j, &mut enc, &mut phase, 1, 2);
        assert_eq!(j.pop_frame(&mut out), Playout::Data);
    }

    #[test]
    fn reorders_packets_that_arrive_out_of_order() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        // Arrive 2, 0, 1 — playout must still start at 0 and run in order.
        let p0 = tone_packet(&mut enc, &mut phase);
        let p1 = tone_packet(&mut enc, &mut phase);
        let p2 = tone_packet(&mut enc, &mut phase);
        j.push_at(at_ms(40.0), Some(2), Some(ts_of(2)), p2);
        j.push_at(at_ms(41.0), Some(0), Some(ts_of(0)), p0);
        j.push_at(at_ms(42.0), Some(1), Some(ts_of(1)), p1);

        assert_eq!(j.next_seq, Some(0), "playout should start at the lowest sequence");
        for expected in 1..=3u64 {
            assert_eq!(j.pop_frame(&mut out), Playout::Data);
            assert_eq!(j.next_seq, Some(expected));
        }
    }

    #[test]
    fn conceals_a_hole_without_deepening_the_buffer() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        // 0,1,2 then a gap at 3, with 4 and 5 present.
        prime(&mut j, &mut enc, &mut phase, 0, 3);
        prime(&mut j, &mut enc, &mut phase, 4, 2);

        for _ in 0..3 {
            assert_eq!(j.pop_frame(&mut out), Playout::Data);
        }

        // Frame 3 is missing but 4 is buffered: it must be filled (FEC/PLC) and
        // stepped over rather than stalling the stream — and since more depth
        // would not have brought it back, the target must not move.
        let before = j.target_frames;
        assert_eq!(j.pop_frame(&mut out), Playout::Data, "lost frame should be concealed");
        assert_eq!(j.next_seq, Some(4), "playout must advance past the hole");
        assert_eq!(j.target_frames, before, "loss alone must not deepen the buffer");
    }

    #[test]
    fn a_packet_that_arrives_after_its_slot_deepens_the_buffer() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        prime(&mut j, &mut enc, &mut phase, 0, 3);
        let late = tone_packet(&mut enc, &mut phase);
        prime(&mut j, &mut enc, &mut phase, 4, 2);
        for _ in 0..4 {
            j.pop_frame(&mut out); // plays 0,1,2 and conceals 3
        }
        let before = j.target_frames;
        j.push_at(at_ms(120.0), Some(3), Some(ts_of(3)), late);
        assert_eq!(j.target_frames, before + 1, "a late packet means the buffer was too shallow");
    }

    #[test]
    fn emits_silence_rather_than_inventing_audio_when_the_sender_stops() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        prime(&mut j, &mut enc, &mut phase, 0, 3);
        for _ in 0..3 {
            assert_eq!(j.pop_frame(&mut out), Playout::Data);
        }

        // Nothing newer buffered. First tick ramps the tail out, then it must go
        // quiet and re-prime instead of concealing indefinitely.
        j.pop_frame(&mut out);
        assert_eq!(j.pop_frame(&mut out), Playout::Silence);
        assert!(!j.primed, "a starved buffer must refill before resuming");
        assert!(j.starved);
    }

    #[test]
    fn a_dtx_pause_does_not_deepen_the_buffer_but_a_stall_does() {
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        // Both buffers are drained to starvation identically.
        let drain = |j: &mut PeerJitter, enc: &mut Encoder, phase: &mut f32, out: &mut [f32]| {
            prime(j, enc, phase, 0, 3);
            for _ in 0..4 {
                j.pop_frame(out);
            }
            assert!(j.starved);
        };

        // Sender kept transmitting: timestamps advance one frame per sequence
        // step, but the packet showed up 200ms late. The gap was the network's,
        // so the buffer should grow.
        let mut stalled = PeerJitter::new().unwrap();
        drain(&mut stalled, &mut enc, &mut phase, &mut out);
        let before = stalled.target_frames;
        stalled.push_at(at_ms(260.0), Some(3), Some(ts_of(3)), tone_packet(&mut enc, &mut phase));
        assert!(stalled.target_frames > before, "a network stall should deepen the buffer");

        // Sender was in DTX: sequence contiguous, timestamp (and arrival) a full
        // second later.
        let mut quiet = PeerJitter::new().unwrap();
        drain(&mut quiet, &mut enc, &mut phase, &mut out);
        let before = quiet.target_frames;
        quiet.push_at(
            at_ms(60.0 + 1000.0),
            Some(3),
            Some(ts_of(3) + 48_000),
            tone_packet(&mut enc, &mut phase),
        );
        assert_eq!(quiet.target_frames, before, "a silent talker is not a jitter problem");
    }

    #[test]
    fn walks_latency_back_down_when_a_burst_leaves_the_buffer_overfull() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        let burst = (INITIAL_TARGET_FRAMES + OVERFULL_SLACK + 6) as u16;
        prime(&mut j, &mut enc, &mut phase, 0, burst);
        let deep = j.packets.len();

        for _ in 0..6 {
            j.pop_frame(&mut out);
        }
        // Each overfull tick drops one extra frame, so depth falls faster than
        // playout alone would manage.
        assert!(
            j.packets.len() < deep - 6,
            "overfull buffer should shed frames, not sit at high latency forever"
        );
    }

    #[test]
    fn falls_back_to_arrival_order_without_sequence_numbers() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        for _ in 0..3 {
            let p = tone_packet(&mut enc, &mut phase);
            j.push(None, None, p);
        }
        assert_eq!(j.pop_frame(&mut out), Playout::Data);
        assert_eq!(j.pop_frame(&mut out), Playout::Data);
    }

    #[test]
    fn steady_random_loss_without_jitter_keeps_the_buffer_shallow() {
        // 1% random loss on an otherwise perfect link, for a minute. The old
        // rule grew on every loss and ratcheted to 300ms; loss is concealed
        // by FEC/PLC whatever the depth, so it must not cost latency.
        let mut rng = Lcg(7);
        let targets = simulate(3000, |_| rng.next_f64() < 0.01, |_| 30.0);
        let max = targets.iter().copied().max().unwrap();
        assert!(max <= 3, "depth grew to {max} frames under loss alone");
    }

    #[test]
    fn real_jitter_grows_the_buffer_within_the_default_cap() {
        // Up to 80ms of random delay per packet (reordering included).
        let mut rng = Lcg(11);
        let targets = simulate(1500, |_| false, |_| 30.0 + rng.next_f64() * 80.0);
        let last = *targets.last().unwrap();
        assert!(last >= 4, "80ms of jitter needs more than the initial depth, got {last}");
        let max = targets.iter().copied().max().unwrap();
        assert!(max <= DEFAULT_CAP_FRAMES, "depth {max} exceeded the default cap");
    }

    #[test]
    fn recovers_once_the_jitter_subsides() {
        let mut rng = Lcg(13);
        let targets = simulate(
            3000,
            |_| false,
            |k| if k < 1500 { 30.0 + rng.next_f64() * 80.0 } else { 110.0 },
        );
        let during = targets[1400];
        let after = *targets.last().unwrap();
        assert!(during >= 4, "jitter phase should have deepened the buffer, got {during}");
        assert!(after <= 3, "depth should come back down once the link is calm, got {after}");
    }

    #[test]
    fn extreme_jitter_never_exceeds_the_hard_cap() {
        let mut rng = Lcg(17);
        let targets = simulate(1500, |_| false, |_| 30.0 + rng.next_f64() * 600.0);
        let max = targets.iter().copied().max().unwrap();
        assert!(max <= MAX_TARGET_FRAMES, "depth {max} exceeded the hard cap");
        assert!(max > DEFAULT_CAP_FRAMES, "jitter this large should be allowed past the default cap");
    }
}
