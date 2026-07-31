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

use std::collections::BTreeMap;

use opus2::{Channels, Decoder};

/// 20ms at 48kHz — the frame size the encoder produces.
pub const FRAME_SAMPLES: usize = 960;
const SAMPLE_RATE: f32 = 48000.0;

/// Adaptive target depth bounds, in 20ms frames.
const MIN_TARGET_FRAMES: usize = 2;
const MAX_TARGET_FRAMES: usize = 15;
const INITIAL_TARGET_FRAMES: usize = 3;
/// Hard cap; beyond this the sender is far ahead of us and old audio is stale.
const MAX_BUFFER_FRAMES: usize = 40;
/// How far past target the buffer may sit before it walks latency back down.
const OVERFULL_SLACK: usize = 4;
/// Consecutive clean playouts before trying a shallower target (500 * 20ms = 10s).
const SHRINK_AFTER_CLEAN_FRAMES: u32 = 500;

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
    clean_frames: u32,

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
            clean_frames: 0,
            last_sample: 0.0,
        })
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

    /// Accept a packet. `seq`/`ts` are `None` when talking to a server old enough
    /// that it forwards bare Opus payloads; the buffer then degrades to arrival
    /// order, which disables reordering and FEC but keeps everything else.
    pub fn push(&mut self, seq: Option<u16>, ts: Option<u32>, payload: Vec<u8>) {
        let ext = match seq {
            Some(w) => self.extend_seq(w),
            None => {
                let s = self.synth_seq;
                self.synth_seq += 1;
                s
            }
        };

        // A packet we have already played past is useless.
        if self.next_seq.is_some_and(|n| ext < n) {
            return;
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

    fn grow_target(&mut self) {
        self.clean_frames = 0;
        if self.target_frames < MAX_TARGET_FRAMES {
            self.target_frames += 1;
        }
    }

    fn note_clean(&mut self) {
        self.clean_frames += 1;
        if self.clean_frames >= SHRINK_AFTER_CLEAN_FRAMES && self.target_frames > MIN_TARGET_FRAMES
        {
            self.target_frames -= 1;
            self.clean_frames = 0;
        }
    }

    /// Produce one 20ms frame into `out` (fully overwritten).
    pub fn pop_frame(&mut self, out: &mut [f32]) -> Playout {
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
            self.note_clean();
            return self.finish(out, n);
        }

        let have_newer = self.packets.keys().next().is_some_and(|&k| k > next);
        if have_newer {
            // Real loss: something newer arrived, so this frame is not merely late.
            self.grow_target();

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

    /// Fill a buffer with `count` sequential packets starting at `first_seq`.
    fn prime(j: &mut PeerJitter, enc: &mut Encoder, phase: &mut f32, first_seq: u16, count: u16) {
        for i in 0..count {
            let seq = first_seq.wrapping_add(i);
            let ts = (seq as u32).wrapping_mul(FRAME_SAMPLES as u32);
            j.push(Some(seq), Some(ts), tone_packet(enc, phase));
        }
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
        j.push(Some(2), Some(2 * 960), p2);
        j.push(Some(0), Some(0), p0);
        j.push(Some(1), Some(960), p1);

        assert_eq!(j.next_seq, Some(0), "playout should start at the lowest sequence");
        for expected in 1..=3u64 {
            assert_eq!(j.pop_frame(&mut out), Playout::Data);
            assert_eq!(j.next_seq, Some(expected));
        }
    }

    #[test]
    fn conceals_a_hole_when_newer_audio_is_already_buffered() {
        let mut j = PeerJitter::new().unwrap();
        let (mut enc, mut phase) = (encoder(), 0.0);
        let mut out = vec![0.0f32; FRAME_SAMPLES];

        // 0,1,2 then a gap at 3, with 4 and 5 present.
        prime(&mut j, &mut enc, &mut phase, 0, 3);
        prime(&mut j, &mut enc, &mut phase, 4, 2);

        for _ in 0..3 {
            assert_eq!(j.pop_frame(&mut out), Playout::Data);
        }

        // Frame 3 is missing but 4 is buffered: this is loss, so it must be
        // filled and stepped over rather than stalling the stream.
        let before = j.target_frames;
        assert_eq!(j.pop_frame(&mut out), Playout::Data, "lost frame should be concealed");
        assert_eq!(j.next_seq, Some(4), "playout must advance past the hole");
        assert!(j.target_frames > before, "real loss should deepen the buffer");
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
        // step, so the gap was ours and the buffer should grow.
        let mut stalled = PeerJitter::new().unwrap();
        drain(&mut stalled, &mut enc, &mut phase, &mut out);
        let before = stalled.target_frames;
        stalled.push(Some(3), Some(3 * 960), tone_packet(&mut enc, &mut phase));
        assert!(stalled.target_frames > before, "a network stall should deepen the buffer");

        // Sender was in DTX: sequence contiguous, timestamp jumped a full second.
        let mut quiet = PeerJitter::new().unwrap();
        drain(&mut quiet, &mut enc, &mut phase, &mut out);
        let before = quiet.target_frames;
        quiet.push(Some(3), Some(3 * 960 + 48_000), tone_packet(&mut enc, &mut phase));
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
}
