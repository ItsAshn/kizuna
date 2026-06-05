use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use gstreamer_audio as gst_audio;
use gstreamer_video as gst_video;

fn main() {
    gst::init().expect("Failed to initialize GStreamer");

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: gstreamer-test <command>");
        eprintln!("Commands:");
        eprintln!("  audio-pipewire    Test microphone capture via pipewiresrc");
        eprintln!("  audio-pulse       Test microphone capture via pulsesrc");
        eprintln!("  screen-x11        Test screen capture via ximagesrc");
        eprintln!("  screen-wayland    Test screen capture via pipewiresrc (requires portal)");
        eprintln!("  list-devices      List available audio devices");
        return;
    }

    match args[1].as_str() {
        "audio-pipewire" => test_audio_pipewire(),
        "audio-pulse" => test_audio_pulse(),
        "screen-x11" => test_screen_x11(),
        "screen-wayland" => test_screen_wayland(),
        "list-devices" => list_audio_devices(),
        _ => eprintln!("Unknown command: {}", args[1]),
    }
}

fn test_audio_pipewire() {
    println!("=== Testing microphone capture via pipewiresrc ===\n");

    let pipeline_str = "pipewiresrc client-name=kizuna-gst-test do-timestamp=true stream-properties=\"p,media.class=Audio/Source\" ! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=1 ! appsink name=sink sync=false";

    let pipeline = match gst::parse::launch(pipeline_str) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FAIL: Failed to create pipeline: {}", e);
            return;
        }
    };

    let sink_element: gst::Element = pipeline
        .downcast_ref::<gst::Bin>()
        .and_then(|bin| bin.by_name("sink"))
        .expect("Failed to find appsink element");
    let appsink = sink_element
        .downcast::<gst_app::AppSink>()
        .expect("Failed to cast to AppSink");

    appsink.set_caps(Some(
        &gst_audio::AudioInfo::builder(
            gst_audio::AUDIO_FORMAT_F32,
            48000u32,
            1u32,
        )
        .build()
        .unwrap()
        .to_caps()
        .unwrap(),
    ));
    appsink.set_drop(false);
    appsink.set_max_buffers(10);

    let sample_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let sample_count_clone = sample_count.clone();

    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;

                let count = sample_count_clone.fetch_add(1, Ordering::Relaxed) + 1;
                let samples: &[f32] = bytemuck::cast_slice(&map[..]);

                if count <= 5 || count % 50 == 0 {
                    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
                    let rms = (samples.iter().map(|s| s * s).sum::<f32>()
                        / samples.len() as f32)
                        .sqrt();
                    println!(
                        "[pipewiresrc] frame #{:>6} | {:>5} samples | peak: {:.4} | RMS: {:.4}",
                        count,
                        samples.len(),
                        peak,
                        rms
                    );
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    let bus = pipeline.bus().unwrap();

    let error_flag = Arc::new(AtomicBool::new(false));
    let error_flag_clone = error_flag.clone();

    let running = Arc::new(AtomicBool::new(true));
    let running_flag = running.clone();

    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                gst::MessageView::Error(err) => {
                    eprintln!(
                        "FAIL: GStreamer error from {}: {}",
                        err.src()
                            .map(|s| s.name().to_string())
                            .unwrap_or_default(),
                        err.error()
                    );
                    if let Some(debug) = err.debug() {
                        eprintln!("  Debug: {}", debug);
                    }
                    error_flag_clone.store(true, Ordering::Relaxed);
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                gst::MessageView::Warning(warning) => {
                    eprintln!("WARN: {}", warning.error());
                }
                gst::MessageView::Eos(_) => {
                    eprintln!("Pipeline EOS");
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
    });

    if pipeline.set_state(gst::State::Playing).is_err() {
        eprintln!("FAIL: Could not set pipeline to Playing state");
        return;
    }

    println!("Recording for 5 seconds (speak into your mic)...\n");
    std::thread::sleep(Duration::from_secs(5));

    running.store(false, Ordering::Relaxed);
    let _ = pipeline.send_event(gst::event::Eos::new());

    std::thread::sleep(Duration::from_millis(500));
    let _ = pipeline.set_state(gst::State::Null);

    let count = sample_count.load(Ordering::Relaxed);
    let had_error = error_flag.load(Ordering::Relaxed);

    println!("\n=== pipewiresrc audio test complete ===");
    println!("Samples received: {}", count);
    if count > 0 && !had_error {
        println!("RESULT: PASS - pipewiresrc audio capture works");
    } else if had_error {
        println!("RESULT: FAIL - GStreamer error occurred");
    } else {
        println!("RESULT: FAIL - No audio samples received");
    }
}

fn test_audio_pulse() {
    println!("=== Testing microphone capture via pulsesrc ===\n");

    let pipeline_str = "pulsesrc client-name=kizuna-gst-test do-timestamp=true ! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=1 ! appsink name=sink sync=false";

    let pipeline = match gst::parse::launch(pipeline_str) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FAIL: Failed to create pulsesrc pipeline: {}", e);
            return;
        }
    };

    let sink_element: gst::Element = pipeline
        .downcast_ref::<gst::Bin>()
        .and_then(|bin| bin.by_name("sink"))
        .expect("Failed to find appsink element");
    let appsink = sink_element
        .downcast::<gst_app::AppSink>()
        .expect("Failed to cast to AppSink");

    appsink.set_caps(Some(
        &gst_audio::AudioInfo::builder(
            gst_audio::AUDIO_FORMAT_F32,
            48000u32,
            1u32,
        )
        .build()
        .unwrap()
        .to_caps()
        .unwrap(),
    ));

    let sample_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let sample_count_clone = sample_count.clone();

    let error_flag = Arc::new(AtomicBool::new(false));
    let error_flag_clone = error_flag.clone();

    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                let count = sample_count_clone.fetch_add(1, Ordering::Relaxed) + 1;
                let samples: &[f32] = bytemuck::cast_slice(&map[..]);

                if count <= 3 || count % 50 == 0 {
                    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
                    let rms = (samples.iter().map(|s| s * s).sum::<f32>()
                        / samples.len() as f32)
                        .sqrt();
                    println!(
                        "[pulsesrc] frame #{:>6} | {:>5} samples | peak: {:.4} | RMS: {:.4}",
                        count, samples.len(), peak, rms
                    );
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    let bus = pipeline.bus().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let running_flag = running.clone();

    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                gst::MessageView::Error(err) => {
                    eprintln!(
                        "FAIL: GStreamer error from {}: {}",
                        err.src()
                            .map(|s| s.name().to_string())
                            .unwrap_or_default(),
                        err.error()
                    );
                    error_flag_clone.store(true, Ordering::Relaxed);
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                gst::MessageView::Eos(_) => {
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
    });

    if pipeline.set_state(gst::State::Playing).is_err() {
        eprintln!("FAIL: Could not set pipeline to Playing state");
        return;
    }

    println!("Recording for 5 seconds (speak into your mic)...\n");
    std::thread::sleep(Duration::from_secs(5));

    running.store(false, Ordering::Relaxed);
    let _ = pipeline.send_event(gst::event::Eos::new());
    std::thread::sleep(Duration::from_millis(500));
    let _ = pipeline.set_state(gst::State::Null);

    let count = sample_count.load(Ordering::Relaxed);
    let had_error = error_flag.load(Ordering::Relaxed);

    println!("\n=== pulsesrc audio test complete ===");
    println!("Samples received: {}", count);
    if count > 0 && !had_error {
        println!("RESULT: PASS - pulsesrc audio capture works");
    } else {
        println!("RESULT: FAIL");
    }
}

fn test_screen_x11() {
    println!("=== Testing screen capture via ximagesrc ===\n");

    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session == "wayland" {
        println!("WARN: Running on Wayland. ximagesrc captures XWayland windows only.");
        println!("Use 'screen-wayland' instead for native Wayland capture.\n");
    }

    let pipeline_str =
        "ximagesrc use-damage=false do-timestamp=true ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink sync=false";

    let pipeline = match gst::parse::launch(pipeline_str) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FAIL: Failed to create ximagesrc pipeline: {}", e);
            return;
        }
    };

    let sink_element: gst::Element = pipeline
        .downcast_ref::<gst::Bin>()
        .and_then(|bin| bin.by_name("sink"))
        .expect("Failed to find appsink element");
    let appsink = sink_element
        .downcast::<gst_app::AppSink>()
        .expect("Failed to cast to AppSink");

    let frame_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let frame_count_clone = frame_count.clone();

    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;

                if let Some(caps) = sample.caps() {
                    let info = gst_video::VideoInfo::from_caps(caps).unwrap();
                    let count = frame_count_clone.fetch_add(1, Ordering::Relaxed) + 1;

                    if count <= 3 || count % 30 == 0 {
                        println!(
                            "[ximagesrc] frame #{:>6} | {}x{} | {} bytes",
                            count,
                            info.width(),
                            info.height(),
                            map.len()
                        );
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    let bus = pipeline.bus().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let running_flag = running.clone();
    let error_flag = Arc::new(AtomicBool::new(false));
    let error_flag_clone = error_flag.clone();

    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                gst::MessageView::Error(err) => {
                    eprintln!(
                        "FAIL: GStreamer error from {}: {}",
                        err.src()
                            .map(|s| s.name().to_string())
                            .unwrap_or_default(),
                        err.error()
                    );
                    error_flag_clone.store(true, Ordering::Relaxed);
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                gst::MessageView::Eos(_) => {
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
    });

    if pipeline.set_state(gst::State::Playing).is_err() {
        eprintln!("FAIL: Could not set pipeline to Playing state");
        return;
    }

    println!("Capturing for 5 seconds...\n");
    std::thread::sleep(Duration::from_secs(5));

    running.store(false, Ordering::Relaxed);
    let _ = pipeline.send_event(gst::event::Eos::new());
    std::thread::sleep(Duration::from_millis(500));
    let _ = pipeline.set_state(gst::State::Null);

    let count = frame_count.load(Ordering::Relaxed);
    let had_error = error_flag.load(Ordering::Relaxed);

    println!("\n=== ximagesrc screen test complete ===");
    println!("Frames received: {}", count);
    if count > 0 && !had_error {
        println!("RESULT: PASS - ximagesrc screen capture works");
    } else {
        println!("RESULT: FAIL");
    }
}

fn test_screen_wayland() {
    println!("=== Testing screen capture via pipewiresrc (Wayland portal) ===\n");

    let result: Result<(OwnedFd, u32), String> = tauri::async_runtime::block_on(async {
        use ashpd::desktop::screencast::{
            CursorMode, Screencast, SelectSourcesOptions, SourceType,
        };

        let screencast = Screencast::new()
            .await
            .map_err(|e| format!("Portal unavailable: {e}"))?;

        let session = screencast
            .create_session(Default::default())
            .await
            .map_err(|e| format!("Failed to create session: {e}"))?;

        println!("Select a screen/window in the portal dialog...");

        screencast
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_cursor_mode(CursorMode::Embedded)
                    .set_sources(SourceType::Monitor | SourceType::Window)
                    .set_multiple(false),
            )
            .await
            .map_err(|e| format!("Source selection failed: {e}"))?;

        let start_request = screencast
            .start(&session, None, Default::default())
            .await
            .map_err(|e| format!("Failed to start: {e}"))?;

        let streams = start_request
            .response()
            .map_err(|e| format!("No response: {e}"))?;

        let stream_list = streams.streams();
        if stream_list.is_empty() {
            return Err("No streams returned".into());
        }

        let node_id = stream_list[0].pipe_wire_node_id();
        println!("PipeWire node ID: {}", node_id);

        let fd = screencast
            .open_pipe_wire_remote(&session, Default::default())
            .await
            .map_err(|e| format!("Failed to open PW remote: {e}"))?;

        Ok((fd, node_id))
    });

    let (fd, node_id) = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAIL: Portal interaction failed: {}", e);
            return;
        }
    };

    let fd_raw = fd.as_raw_fd();

    let pipeline_str = format!(
        "pipewiresrc fd={} path={} do-timestamp=true stream-properties=\"p,media.class=Video\" ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink sync=false",
        fd_raw, node_id
    );

    let pipeline = match gst::parse::launch(&pipeline_str) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FAIL: Failed to create pipewiresrc pipeline: {}", e);
            return;
        }
    };

    let sink_element: gst::Element = pipeline
        .downcast_ref::<gst::Bin>()
        .and_then(|bin| bin.by_name("sink"))
        .expect("Failed to find appsink element");
    let appsink = sink_element
        .downcast::<gst_app::AppSink>()
        .expect("Failed to cast to AppSink");

    let frame_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let frame_count_clone = frame_count.clone();

    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;

                if let Some(caps) = sample.caps() {
                    let info = gst_video::VideoInfo::from_caps(caps).unwrap();
                    let count = frame_count_clone.fetch_add(1, Ordering::Relaxed) + 1;

                    if count <= 3 || count % 30 == 0 {
                        println!(
                            "[pipewiresrc video] frame #{:>6} | {}x{} | {} bytes",
                            count,
                            info.width(),
                            info.height(),
                            map.len()
                        );
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    let bus = pipeline.bus().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let running_flag = running.clone();
    let error_flag = Arc::new(AtomicBool::new(false));
    let error_flag_clone = error_flag.clone();
    let _fd_guard = fd;

    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                gst::MessageView::Error(err) => {
                    eprintln!(
                        "FAIL: GStreamer error from {}: {}",
                        err.src()
                            .map(|s| s.name().to_string())
                            .unwrap_or_default(),
                        err.error()
                    );
                    error_flag_clone.store(true, Ordering::Relaxed);
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                gst::MessageView::Eos(_) => {
                    running_flag.store(false, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
    });

    if pipeline.set_state(gst::State::Playing).is_err() {
        eprintln!("FAIL: Could not set pipeline to Playing state");
        return;
    }

    println!("\nCapturing for 10 seconds...\n");
    std::thread::sleep(Duration::from_secs(10));

    running.store(false, Ordering::Relaxed);
    let _ = pipeline.send_event(gst::event::Eos::new());
    std::thread::sleep(Duration::from_millis(500));
    let _ = pipeline.set_state(gst::State::Null);

    let count = frame_count.load(Ordering::Relaxed);
    let had_error = error_flag.load(Ordering::Relaxed);

    println!("\n=== pipewiresrc Wayland screen test complete ===");
    println!("Frames received: {}", count);
    if count > 0 && !had_error {
        println!("RESULT: PASS - pipewiresrc Wayland screen capture works");
    } else {
        println!("RESULT: FAIL");
    }
}

fn list_audio_devices() {
    println!("=== Audio Device Enumeration ===\n");

    let host = cpal::default_host();

    println!("Input devices:");
    match host.input_devices() {
        Ok(mut devices) => {
            let mut i = 1;
            while let Some(device) = devices.next() {
                let name = device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "Unknown".into());
                println!("  {}. {}", i, name);
                if let Ok(mut configs) = device.supported_input_configs() {
                    while let Some(cfg) = configs.next() {
                        println!(
                            "     - {}ch, {}Hz, {:?}",
                            cfg.channels(),
                            cfg.min_sample_rate(),
                            cfg.sample_format()
                        );
                    }
                }
                i += 1;
            }
        }
        Err(e) => {
            eprintln!("  (Failed to enumerate input devices: {})", e);
        }
    }

    println!("\nOutput devices:");
    match host.output_devices() {
        Ok(mut devices) => {
            let mut i = 1;
            while let Some(device) = devices.next() {
                let name = device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "Unknown".into());
                println!("  {}. {}", i, name);
                i += 1;
            }
        }
        Err(e) => {
            eprintln!("  (Failed to enumerate output devices: {})", e);
        }
    }
}
