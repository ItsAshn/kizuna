//! Native VP8 encoding for screenshare.
//!
//! The webview path (canvas → `captureStream()` → mediasoup-client) needs
//! `RTCPeerConnection`, which WebKitGTK does not expose: most distributions
//! build it with `ENABLE_WEB_RTC=OFF`, and even where it is compiled in the
//! setting defaults to off. Rather than depend on the webview, screen frames
//! are encoded here and written straight to the WebRTC video track that
//! `voice::transport` already adds to the send peer connection.
//!
//! GStreamer does the encoding: it is already an installed dependency of
//! WebKitGTK on Linux, so this adds nothing to what users must have.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::capture::RawFrame;

/// Screens are commonly larger than anything a viewer will look at full size,
/// and encode cost scales with pixel count, so cap the long edge.
const MAX_DIMENSION: u32 = 1920;

/// A keyframe every two seconds bounds how long a viewer who joins mid-share
/// stares at a blank tile if their PLI is lost.
const KEYFRAME_SECONDS: u32 = 2;

pub struct VideoSendSession {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    cancel: Arc<AtomicBool>,
    feeder: Option<thread::JoinHandle<()>>,
    writer: Option<tokio::task::JoinHandle<()>>,
    frames_encoded: Arc<AtomicU64>,
}

impl VideoSendSession {
    /// Builds the encode pipeline and starts pumping `frame_rx` into the track.
    /// Frame dimensions are discovered from the first frame and renegotiated if
    /// they change (a Wayland portal source can resize mid-session).
    pub fn start(
        track: Arc<TrackLocalStaticSample>,
        frame_rx: Receiver<RawFrame>,
        bitrate_bps: u32,
        fps: u32,
    ) -> Result<Self, String> {
        gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;

        let fps = fps.max(1);
        let pipeline = gst::Pipeline::new();

        let appsrc = gst_app::AppSrc::builder()
            .is_live(true)
            .do_timestamp(true)
            .format(gst::Format::Time)
            .build();

        let convert = make_element("videoconvert")?;
        let scale = make_element("videoscale")?;
        let capsfilter = make_element("capsfilter")?;
        let encoder = make_element("vp8enc")?;

        encoder.set_property("deadline", 1i64); // realtime
        encoder.set_property("cpu-used", 8i32);
        encoder.set_property("threads", 4i32);
        encoder.set_property("lag-in-frames", 0i32);
        encoder.set_property("target-bitrate", bitrate_bps as i32);
        encoder.set_property("keyframe-max-dist", (fps * KEYFRAME_SECONDS) as i32);
        // Recommended by the vp8enc docs for screen/window sharing: skips
        // encoding blocks that have not changed, which is most of a desktop.
        encoder.set_property("static-threshold", 100i32);
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

        let (encoded_tx, mut encoded_rx) = tokio::sync::mpsc::unbounded_channel::<(Vec<u8>, Duration)>();
        let frames_encoded = Arc::new(AtomicU64::new(0));
        let counter = frames_encoded.clone();

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
                    // A dropped receiver means the session is shutting down.
                    let _ = encoded_tx.send((map.as_slice().to_vec(), duration));
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("Failed to start encode pipeline: {e}"))?;

        let cancel = Arc::new(AtomicBool::new(false));

        let feeder = {
            let cancel = cancel.clone();
            let appsrc = appsrc.clone();
            let capsfilter = capsfilter.clone();
            thread::spawn(move || {
                run_feeder(appsrc, capsfilter, frame_rx, cancel, fps);
            })
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
                        duration: if duration.is_zero() { default_duration } else { duration },
                        ..Default::default()
                    };
                    if let Err(e) = track.write_sample(&sample).await {
                        eprintln!("[ScreenEncode] write_sample failed: {e}");
                        break;
                    }
                }
            })
        };

        eprintln!(
            "[ScreenEncode] pipeline started: vp8 {}kbps @ {fps}fps",
            bitrate_bps / 1000
        );

        Ok(Self {
            pipeline,
            appsrc,
            cancel,
            feeder: Some(feeder),
            writer: Some(writer),
            frames_encoded,
        })
    }

    /// Handle for asking the encoder to emit a keyframe immediately. Held by
    /// the RTCP reader so a viewer's PLI gets a picture out without waiting for
    /// the periodic keyframe.
    pub fn keyframe_requester(&self) -> KeyframeRequester {
        KeyframeRequester {
            appsrc: self.appsrc.clone(),
        }
    }

    pub fn stop(&mut self) {
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
            "[ScreenEncode] pipeline stopped after {} encoded frames",
            self.frames_encoded.load(Ordering::Relaxed)
        );
    }
}

impl Drop for VideoSendSession {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
pub struct KeyframeRequester {
    appsrc: gst_app::AppSrc,
}

impl KeyframeRequester {
    pub fn request(&self) {
        let structure = gst::Structure::builder("GstForceKeyUnit")
            .field("all-headers", true)
            .build();
        let event = gst::event::CustomUpstream::new(structure);
        let handled = self
            .appsrc
            .static_pad("src")
            .map(|pad| pad.push_event(event))
            .unwrap_or(false);
        if !handled {
            // Not fatal: the periodic keyframe still recovers the stream.
            eprintln!("[ScreenEncode] force keyframe request was not handled");
        }
    }
}

fn make_element(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name).build().map_err(|_| {
        format!(
            "GStreamer element '{name}' is missing. Install the GStreamer base and good plugin sets \
             (gst-plugins-base, gst-plugins-good) to share your screen."
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

        let format = frame.format.gst_name();
        if current != Some((frame.width, frame.height, format)) {
            let caps = gst::Caps::builder("video/x-raw")
                .field("format", format)
                .field("width", frame.width as i32)
                .field("height", frame.height as i32)
                .field("framerate", gst::Fraction::new(fps as i32, 1))
                .build();
            appsrc.set_caps(Some(&caps));

            let (out_w, out_h) = scaled_dimensions(frame.width, frame.height);
            capsfilter.set_property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "I420")
                    .field("width", out_w as i32)
                    .field("height", out_h as i32)
                    .build(),
            );

            eprintln!(
                "[ScreenEncode] source {}x{} {format} -> encoding {out_w}x{out_h}",
                frame.width, frame.height
            );
            current = Some((frame.width, frame.height, format));
        }

        let buffer = gst::Buffer::from_mut_slice(frame.data);
        if appsrc.push_buffer(buffer).is_err() {
            break;
        }
    }

    let _ = appsrc.end_of_stream();
}

/// Caps the long edge at [`MAX_DIMENSION`], preserving aspect ratio and keeping
/// both dimensions even for chroma subsampling.
fn scaled_dimensions(width: u32, height: u32) -> (u32, u32) {
    let long_edge = width.max(height);
    if long_edge <= MAX_DIMENSION {
        return (width, height);
    }
    let ratio = MAX_DIMENSION as f64 / long_edge as f64;
    let w = ((width as f64 * ratio).round() as u32).max(2) & !1;
    let h = ((height as f64 * ratio).round() as u32).max(2) & !1;
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::PixelFormat;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

    fn frame(width: u32, height: u32, tint: u8) -> RawFrame {
        RawFrame {
            width,
            height,
            format: PixelFormat::Bgra,
            data: vec![tint; (width * height * 4) as usize],
        }
    }

    #[test]
    fn scaled_dimensions_caps_long_edge_and_stays_even() {
        assert_eq!(scaled_dimensions(1280, 720), (1280, 720));
        assert_eq!(scaled_dimensions(3840, 2160), (1920, 1080));
        // 2560x1600 scales to 1920x1200; both stay even.
        let (w, h) = scaled_dimensions(2560, 1600);
        assert_eq!((w, h), (1920, 1200));
        // Extreme aspect ratios must not collapse a dimension to zero.
        let (w, h) = scaled_dimensions(5120, 100);
        assert_eq!(w, 1920);
        assert!(h >= 2 && h % 2 == 0);
    }

    /// Exercises the real pipeline: catches a renamed vp8enc property, a
    /// missing plugin, or caps that fail to negotiate — including the
    /// renegotiation that happens when the capture source changes size.
    #[tokio::test]
    async fn pipeline_encodes_and_survives_a_resolution_change() {
        if gst::init().is_err() || gst::ElementFactory::find("vp8enc").is_none() {
            eprintln!("skipping: GStreamer vp8enc not available");
            return;
        }

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                clock_rate: 90000,
                ..Default::default()
            },
            "video".to_string(),
            "kizuna-test".to_string(),
        ));

        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(2);
        let mut session = VideoSendSession::start(track, frame_rx, 1_000_000, 15)
            .expect("pipeline should build");

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
        assert!(
            session.frames_encoded.load(Ordering::Relaxed) > 0,
            "no VP8 frames came out of the encoder",
        );

        session.stop();
    }
}
