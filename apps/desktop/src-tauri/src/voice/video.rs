//! Native VP8 encoding for screenshare and camera.
//!
//! The webview path (canvas → `captureStream()` → mediasoup-client) needs
//! `RTCPeerConnection`, which WebKitGTK does not expose: most distributions
//! build it with `ENABLE_WEB_RTC=OFF`, and even where it is compiled in the
//! setting defaults to off. Rather than depend on the webview, frames are
//! encoded here and written straight to the WebRTC video tracks that
//! `voice::transport` adds to the send peer connection (one per source).
//!
//! GStreamer does the encoding: it is already an installed dependency of
//! WebKitGTK on Linux, so this adds nothing to what users must have.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::capture::{RawFrame, VideoSource};

/// A keyframe every two seconds bounds how long a viewer who joins mid-share
/// stares at a blank tile if their PLI is lost.
const KEYFRAME_SECONDS: u32 = 2;

/// Encoded frames waiting for the RTP writer. About a second at 30 fps; if the
/// writer falls this far behind, frames are dropped and a keyframe is forced
/// so receivers resynchronise instead of decoding garbage.
const ENCODED_QUEUE: usize = 32;

/// Coalesces bursts of PLI/FIR (one per viewer, plus retries) into a single
/// forced keyframe.
const KEYFRAME_MIN_INTERVAL: Duration = Duration::from_millis(250);

/// Encoder settings for one outgoing video.
#[derive(Clone, Copy, Debug)]
pub struct VideoEncodeConfig {
    pub fps: u32,
    pub start_bitrate_bps: u32,
    pub min_bitrate_bps: u32,
    pub max_bitrate_bps: u32,
    /// Long-edge cap. Encode cost scales with pixel count.
    pub max_dimension: u32,
    /// Screen content: skip unchanged blocks, which is most of a desktop.
    pub screen_content: bool,
}

impl VideoEncodeConfig {
    pub fn for_source(source: VideoSource, fps: u32) -> Self {
        match source {
            VideoSource::Screen => Self {
                fps,
                start_bitrate_bps: super::SCREEN_SHARE_BITRATE_BPS,
                min_bitrate_bps: super::VIDEO_MIN_BITRATE_BPS,
                max_bitrate_bps: super::SCREEN_SHARE_MAX_BITRATE_BPS,
                max_dimension: 1920,
                screen_content: true,
            },
            VideoSource::Camera => Self {
                fps,
                start_bitrate_bps: super::CAMERA_BITRATE_BPS,
                min_bitrate_bps: super::VIDEO_MIN_BITRATE_BPS,
                max_bitrate_bps: super::CAMERA_MAX_BITRATE_BPS,
                max_dimension: 640,
                screen_content: false,
            },
        }
    }
}

pub struct VideoSendSession {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    cancel: Arc<AtomicBool>,
    feeder: Option<thread::JoinHandle<()>>,
    writer: Option<tokio::task::JoinHandle<()>>,
    frames_encoded: Arc<AtomicU64>,
    keyframes_encoded: Arc<AtomicU64>,
    keyframes: KeyframeRequester,
    bitrate: BitrateHandle,
    stopped: bool,
}

impl VideoSendSession {
    /// Builds the encode pipeline and starts pumping `frame_rx` into the track.
    /// Frame dimensions are discovered from the first frame and renegotiated if
    /// they change (a Wayland portal source can resize mid-session).
    pub fn start(
        track: Arc<TrackLocalStaticSample>,
        frame_rx: Receiver<RawFrame>,
        cfg: VideoEncodeConfig,
    ) -> Result<Self, String> {
        gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;

        let fps = cfg.fps.max(1);
        let pipeline = gst::Pipeline::new();

        let appsrc = gst_app::AppSrc::builder()
            .is_live(true)
            .do_timestamp(true)
            .format(gst::Format::Time)
            .build();
        // Bounded and leaky: when the encoder falls behind, the oldest raw
        // frame is dropped instead of queueing multi-megabyte buffers (and
        // seconds of latency) without limit. Both properties need GStreamer
        // 1.20; older versions keep the unbounded default.
        if appsrc.has_property("max-buffers") {
            appsrc.set_property("max-buffers", 2u64);
        }
        if appsrc.has_property("leaky-type") {
            appsrc.set_property_from_str("leaky-type", "downstream");
        }

        let convert = make_element("videoconvert")?;
        let scale = make_element("videoscale")?;
        let capsfilter = make_element("capsfilter")?;
        let encoder = make_element("vp8enc")?;

        let start_bitrate = clamp_bitrate(cfg.start_bitrate_bps, &cfg);
        encoder.set_property("deadline", 1i64); // realtime
        encoder.set_property("cpu-used", 8i32);
        encoder.set_property("threads", 4i32);
        encoder.set_property("lag-in-frames", 0i32);
        encoder.set_property("target-bitrate", start_bitrate as i32);
        encoder.set_property("keyframe-max-dist", (fps * KEYFRAME_SECONDS) as i32);
        if cfg.screen_content {
            // Recommended by the vp8enc docs for screen/window sharing: skips
            // encoding blocks that have not changed, which is most of a desktop.
            encoder.set_property("static-threshold", 100i32);
        }
        // A small client buffer keeps the rate controller from banking bits and
        // spending them in a burst, which shows up as latency on a live share.
        encoder.set_property("buffer-size", 1000i32);
        encoder.set_property_from_str("end-usage", "cbr");
        encoder.set_property_from_str("error-resilient", "default");

        let appsink = gst_app::AppSink::builder()
            .caps(&gst::Caps::builder("video/x-vp8").build())
            .sync(false)
            .max_buffers(4)
            .drop(true)
            .build();

        let elements = [
            appsrc.upcast_ref::<gst::Element>(),
            &convert,
            &scale,
            &capsfilter,
            &encoder,
            appsink.upcast_ref::<gst::Element>(),
        ];
        pipeline
            .add_many(elements)
            .map_err(|e| format!("Failed to assemble encode pipeline: {e}"))?;
        gst::Element::link_many(elements)
            .map_err(|e| format!("Failed to link encode pipeline: {e}"))?;

        let keyframes = KeyframeRequester::new(appsink.clone().upcast());
        let (encoded_tx, mut encoded_rx) =
            tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(ENCODED_QUEUE);
        let frames_encoded = Arc::new(AtomicU64::new(0));
        let keyframes_encoded = Arc::new(AtomicU64::new(0));

        {
            let counter = frames_encoded.clone();
            let key_counter = keyframes_encoded.clone();
            let keyframes = keyframes.clone();
            appsink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                        let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                        let duration = buffer
                            .duration()
                            .map(|d| Duration::from_nanos(d.nseconds()))
                            .unwrap_or_default();
                        counter.fetch_add(1, Ordering::Relaxed);
                        if !buffer.flags().contains(gst::BufferFlags::DELTA_UNIT) {
                            key_counter.fetch_add(1, Ordering::Relaxed);
                        }
                        match encoded_tx.try_send((map.as_slice().to_vec(), duration)) {
                            Ok(()) => {}
                            // The writer is behind. The frames after this one
                            // reference it, so a keyframe is the only way back.
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                keyframes.request();
                            }
                            // The session is shutting down.
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {}
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("Failed to start encode pipeline: {e}"))?;

        let cancel = Arc::new(AtomicBool::new(false));

        let feeder = {
            let cancel = cancel.clone();
            let appsrc = appsrc.clone();
            let capsfilter = capsfilter.clone();
            let max_dimension = cfg.max_dimension;
            thread::Builder::new()
                .name("video-feeder".into())
                .spawn(move || {
                    run_feeder(appsrc, capsfilter, frame_rx, cancel, fps, max_dimension);
                })
                .map_err(|e| format!("Failed to spawn video feeder: {e}"))?
        };

        let writer = {
            let cancel = cancel.clone();
            let default_duration = Duration::from_secs_f64(1.0 / fps as f64);
            tokio::spawn(async move {
                while let Some((data, duration)) = encoded_rx.recv().await {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let sample = Sample {
                        data: data.into(),
                        timestamp: SystemTime::now(),
                        duration: if duration.is_zero() {
                            default_duration
                        } else {
                            duration
                        },
                        ..Default::default()
                    };
                    if let Err(e) = track.write_sample(&sample).await {
                        eprintln!("[VideoEncode] write_sample failed: {e}");
                        break;
                    }
                }
            })
        };

        eprintln!(
            "[VideoEncode] pipeline started: vp8 {}kbps @ {fps}fps (max {}kbps)",
            start_bitrate / 1000,
            cfg.max_bitrate_bps / 1000,
        );

        let bitrate = BitrateHandle {
            encoder,
            current: Arc::new(AtomicU32::new(start_bitrate)),
            min: cfg.min_bitrate_bps,
            max: cfg.max_bitrate_bps,
        };

        Ok(Self {
            pipeline,
            appsrc,
            cancel,
            feeder: Some(feeder),
            writer: Some(writer),
            frames_encoded,
            keyframes_encoded,
            keyframes,
            bitrate,
            stopped: false,
        })
    }

    /// Handle for asking the encoder to emit a keyframe immediately. Held by
    /// the RTCP reader so a viewer's PLI gets a picture out without waiting for
    /// the periodic keyframe.
    pub fn keyframe_requester(&self) -> KeyframeRequester {
        self.keyframes.clone()
    }

    /// Handle for changing the encoder's target bitrate while it runs.
    pub fn bitrate_handle(&self) -> BitrateHandle {
        self.bitrate.clone()
    }

    #[cfg(test)]
    pub fn frames_encoded(&self) -> u64 {
        self.frames_encoded.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn keyframes_encoded(&self) -> u64 {
        self.keyframes_encoded.load(Ordering::Relaxed)
    }

    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        self.cancel.store(true, Ordering::Relaxed);
        let _ = self.appsrc.end_of_stream();
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Some(handle) = self.feeder.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.writer.take() {
            handle.abort();
        }
        eprintln!(
            "[VideoEncode] pipeline stopped after {} encoded frames ({} keyframes)",
            self.frames_encoded.load(Ordering::Relaxed),
            self.keyframes_encoded.load(Ordering::Relaxed),
        );
    }
}

impl Drop for VideoSendSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Forces the encoder to emit a keyframe.
///
/// The request is a `GstForceKeyUnit` *upstream* event sent from the appsink,
/// so it travels back up to vp8enc. (Pushing it out of the appsrc's src pad,
/// as this used to, sends it downstream where the encoder ignores it: PLIs
/// were never honoured and viewers waited for the periodic keyframe.)
#[derive(Clone)]
pub struct KeyframeRequester {
    sink: gst::Element,
    last: Arc<Mutex<Option<Instant>>>,
}

impl KeyframeRequester {
    fn new(sink: gst::Element) -> Self {
        Self {
            sink,
            last: Arc::new(Mutex::new(None)),
        }
    }

    pub fn request(&self) {
        if let Ok(mut last) = self.last.lock() {
            let now = Instant::now();
            if last.is_some_and(|t| now.duration_since(t) < KEYFRAME_MIN_INTERVAL) {
                return;
            }
            *last = Some(now);
        }
        let event = gstreamer_video::UpstreamForceKeyUnitEvent::builder()
            .all_headers(true)
            .build();
        if !self.sink.send_event(event) {
            // Not fatal: the periodic keyframe still recovers the stream.
            eprintln!("[VideoEncode] force keyframe request was not handled");
        }
    }
}

/// Live control of the encoder's target bitrate, within the session's bounds.
#[derive(Clone)]
pub struct BitrateHandle {
    encoder: gst::Element,
    current: Arc<AtomicU32>,
    min: u32,
    max: u32,
}

impl BitrateHandle {
    pub fn get(&self) -> u32 {
        self.current.load(Ordering::Relaxed)
    }

    /// Sets the target, clamped to the session's range. Returns what was set.
    pub fn set(&self, bps: u32) -> u32 {
        let bps = bps.clamp(self.min, self.max);
        if self.current.swap(bps, Ordering::Relaxed) != bps {
            self.encoder.set_property("target-bitrate", bps as i32);
        }
        bps
    }

    /// Feeds one receiver report's `fraction_lost` (0-255) into the loss-based
    /// controller.
    pub fn on_loss_report(&self, fraction_lost: u8) -> u32 {
        let next = adapt_bitrate(self.get(), fraction_lost, self.min, self.max);
        self.set(next)
    }
}

/// Loss-based rate control, as in the loss half of Google congestion control:
/// back off in proportion to loss above 10%, hold between 2% and 10%, and
/// probe upward by 8% when the path is clean. webrtc-rs has no bandwidth
/// estimator, so this is what keeps a share watchable on a lossy link.
pub fn adapt_bitrate(current: u32, fraction_lost: u8, min: u32, max: u32) -> u32 {
    let loss = fraction_lost as f64 / 256.0;
    let next = if loss > 0.10 {
        current as f64 * (1.0 - 0.5 * loss)
    } else if loss < 0.02 {
        current as f64 * 1.08
    } else {
        current as f64
    };
    (next.round() as u32).clamp(min, max)
}

fn clamp_bitrate(bps: u32, cfg: &VideoEncodeConfig) -> u32 {
    bps.clamp(cfg.min_bitrate_bps, cfg.max_bitrate_bps)
}

pub(crate) fn make_element(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name).build().map_err(|_| {
        format!(
            "GStreamer element '{name}' is missing. Install the GStreamer base and good plugin sets \
             (gst-plugins-base, gst-plugins-good) for screen sharing and video."
        )
    })
}

/// Pushes captured frames into the pipeline, renegotiating caps whenever the
/// source resolution or pixel layout changes.
fn run_feeder(
    appsrc: gst_app::AppSrc,
    capsfilter: gst::Element,
    frame_rx: Receiver<RawFrame>,
    cancel: Arc<AtomicBool>,
    fps: u32,
    max_dimension: u32,
) {
    let mut current: Option<(u32, u32, &'static str)> = None;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let frame = match frame_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => frame,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };

        let expected =
            frame.width as usize * frame.height as usize * frame.format.bytes_per_pixel();
        if frame.width == 0 || frame.height == 0 || frame.data.len() < expected {
            continue;
        }

        let format = frame.format.gst_name();
        if current != Some((frame.width, frame.height, format)) {
            let caps = gst::Caps::builder("video/x-raw")
                .field("format", format)
                .field("width", frame.width as i32)
                .field("height", frame.height as i32)
                .field("framerate", gst::Fraction::new(fps as i32, 1))
                .build();
            appsrc.set_caps(Some(&caps));

            let (out_w, out_h) = scaled_dimensions(frame.width, frame.height, max_dimension);
            capsfilter.set_property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "I420")
                    .field("width", out_w as i32)
                    .field("height", out_h as i32)
                    .build(),
            );

            eprintln!(
                "[VideoEncode] source {}x{} {format} -> encoding {out_w}x{out_h}",
                frame.width, frame.height
            );
            current = Some((frame.width, frame.height, format));
        }

        let mut data = frame.data;
        data.truncate(expected);
        let buffer = gst::Buffer::from_mut_slice(data);
        if appsrc.push_buffer(buffer).is_err() {
            break;
        }
    }

    let _ = appsrc.end_of_stream();
}

/// Caps the long edge at `max_dimension`, preserving aspect ratio and keeping
/// both dimensions even for chroma subsampling.
pub(crate) fn scaled_dimensions(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    let long_edge = width.max(height);
    if long_edge <= max_dimension {
        return ((width & !1).max(2), (height & !1).max(2));
    }
    let ratio = max_dimension as f64 / long_edge as f64;
    let w = ((width as f64 * ratio).round() as u32).max(2) & !1;
    let h = ((height as f64 * ratio).round() as u32).max(2) & !1;
    (w, h)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::capture::PixelFormat;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

    pub(crate) fn frame(width: u32, height: u32, tint: u8) -> RawFrame {
        RawFrame {
            width,
            height,
            format: PixelFormat::Bgra,
            data: vec![tint; (width * height * 4) as usize],
        }
    }

    pub(crate) fn vp8_track() -> Arc<TrackLocalStaticSample> {
        Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                clock_rate: 90000,
                ..Default::default()
            },
            "video".to_string(),
            "kizuna-test".to_string(),
        ))
    }

    pub(crate) fn gst_available() -> bool {
        gst::init().is_ok()
            && ["vp8enc", "vp8dec", "jpegenc", "videoconvert", "videoscale"]
                .iter()
                .all(|e| gst::ElementFactory::find(e).is_some())
    }

    fn test_config(fps: u32) -> VideoEncodeConfig {
        VideoEncodeConfig {
            fps,
            start_bitrate_bps: 1_000_000,
            min_bitrate_bps: 300_000,
            max_bitrate_bps: 4_000_000,
            max_dimension: 1920,
            screen_content: true,
        }
    }

    #[test]
    fn scaled_dimensions_caps_long_edge_and_stays_even() {
        assert_eq!(scaled_dimensions(1280, 720, 1920), (1280, 720));
        assert_eq!(scaled_dimensions(3840, 2160, 1920), (1920, 1080));
        // 2560x1600 scales to 1920x1200; both stay even.
        assert_eq!(scaled_dimensions(2560, 1600, 1920), (1920, 1200));
        // Extreme aspect ratios must not collapse a dimension to zero.
        let (w, h) = scaled_dimensions(5120, 100, 1920);
        assert_eq!(w, 1920);
        assert!(h >= 2 && h % 2 == 0);
        // Odd sizes below the cap are evened out.
        assert_eq!(scaled_dimensions(641, 481, 1920), (640, 480));
        // Camera cap.
        assert_eq!(scaled_dimensions(1280, 720, 640), (640, 360));
    }

    #[test]
    fn loss_controller_backs_off_holds_and_probes() {
        let (min, max) = (300_000, 4_000_000);
        // 25% loss: cut by 12.5%.
        assert_eq!(adapt_bitrate(2_000_000, 64, min, max), 1_750_000);
        // 5% loss: hold.
        assert_eq!(adapt_bitrate(2_000_000, 13, min, max), 2_000_000);
        // Clean: probe up 8%.
        assert_eq!(adapt_bitrate(2_000_000, 0, min, max), 2_160_000);
        // Clamped at both ends.
        assert_eq!(adapt_bitrate(3_900_000, 0, min, max), max);
        assert_eq!(adapt_bitrate(310_000, 255, min, max), min);
    }

    /// Exercises the real pipeline: catches a renamed vp8enc property, a
    /// missing plugin, or caps that fail to negotiate — including the
    /// renegotiation that happens when the capture source changes size.
    #[tokio::test(flavor = "multi_thread")]
    async fn pipeline_encodes_and_survives_a_resolution_change() {
        if !gst_available() {
            eprintln!("skipping: GStreamer VP8 plugins not available");
            return;
        }

        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let mut session =
            VideoSendSession::start(vp8_track(), frame_rx, test_config(15)).expect("pipeline");

        for i in 0..10 {
            frame_tx.send(frame(640, 480, i * 20)).expect("feeder alive");
        }
        for i in 0..5 {
            frame_tx.send(frame(320, 240, i * 40)).expect("feeder alive");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;

        let bus = session.pipeline.bus().expect("pipeline has a bus");
        let errors: Vec<_> = bus
            .iter_timed(gst::ClockTime::ZERO)
            .filter_map(|msg| match msg.view() {
                gst::MessageView::Error(e) => Some(e.error().to_string()),
                _ => None,
            })
            .collect();
        assert!(errors.is_empty(), "pipeline reported errors: {errors:?}");
        assert_eq!(session.pipeline.current_state(), gst::State::Playing);
        assert!(session.frames_encoded() > 0, "no VP8 frames came out of the encoder");

        session.stop();
    }

    /// A PLI must produce a keyframe now, not at the next periodic one. The
    /// keyframe interval here is 60 frames, so a second keyframe within the
    /// next 20 can only be the forced one.
    #[tokio::test(flavor = "multi_thread")]
    async fn forced_keyframe_yields_a_non_delta_buffer() {
        if !gst_available() {
            eprintln!("skipping: GStreamer VP8 plugins not available");
            return;
        }

        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let mut session =
            VideoSendSession::start(vp8_track(), frame_rx, test_config(30)).expect("pipeline");

        let push = |n: u32, start: u32| {
            for i in 0..n {
                frame_tx
                    .send(frame(320, 240, ((start + i) * 7) as u8))
                    .expect("feeder alive");
                std::thread::sleep(Duration::from_millis(20));
            }
        };

        push(10, 0);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let before = session.keyframes_encoded();
        let encoded_before = session.frames_encoded();
        assert_eq!(before, 1, "only the initial keyframe so far");
        assert!(encoded_before >= 5, "encoder produced {encoded_before} frames");

        session.keyframe_requester().request();
        push(20, 10);
        tokio::time::sleep(Duration::from_millis(300)).await;

        assert!(
            session.keyframes_encoded() > before,
            "forced keyframe never appeared ({} frames encoded)",
            session.frames_encoded()
        );
        session.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bitrate_can_change_while_encoding() {
        if !gst_available() {
            eprintln!("skipping: GStreamer VP8 plugins not available");
            return;
        }
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let mut session =
            VideoSendSession::start(vp8_track(), frame_rx, test_config(15)).expect("pipeline");
        frame_tx.send(frame(320, 240, 1)).expect("feeder alive");
        let handle = session.bitrate_handle();
        assert_eq!(handle.set(10_000_000), 4_000_000);
        assert_eq!(handle.on_loss_report(128), 3_000_000);
        frame_tx.send(frame(320, 240, 2)).expect("feeder alive");
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.stop();
    }
}
