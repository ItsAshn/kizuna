#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod capture;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod env;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod voice;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::Mutex;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::{CaptureSession, MonitorInfo, SessionType};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::focus::WindowInfo;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::detection::AppEntry;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::app_info::ActiveWindowDetails;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use voice::device::AudioDeviceInfo;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use voice::output::AudioOutput;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use voice::rnnoise::NoiseSuppressionMode;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use voice::VoiceController;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
static CAPTURE_SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static CAMERA_SESSION: Mutex<Option<capture::camera::CameraSession>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static SESSION_TYPE: Mutex<Option<SessionType>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static VOICE_CONTROLLER: Mutex<Option<VoiceController>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static AUDIO_OUTPUT: Mutex<Option<AudioOutput>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static MIC_TEST: Mutex<Option<voice::mictest::MicTestSession>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static BACKGROUND_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn get_session_type() -> SessionType {
    let mut guard = SESSION_TYPE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(capture::detect_session_type());
    }
    guard.unwrap()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    match get_session_type() {
        #[cfg(target_os = "linux")]
        SessionType::Wayland => {
            tauri::async_runtime::block_on(capture::wayland::list_sources())
        }
        #[cfg(target_os = "macos")]
        SessionType::MacOS => capture::macos::list_monitors(),
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::list_monitors(),
        _ => capture::windows::list_monitors(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn get_active_window_info() -> Result<Option<WindowInfo>, String> {
    Ok(capture::focus::get_active_window_info(get_session_type()))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn get_active_window_details() -> Result<Option<ActiveWindowDetails>, String> {
    let session = get_session_type();
    let info = capture::focus::get_active_window_info(session);
    Ok(info.map(|i| capture::app_info::resolve_active_window_details(&i)))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn get_now_playing() -> Result<Option<capture::nowplaying::NowPlaying>, String> {
    Ok(capture::nowplaying::get_now_playing())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn list_windows() -> Result<Vec<AppEntry>, String> {
    let session = get_session_type();

    if let Some(entries) = capture::detection::list_apps_xwin() {
        return Ok(entries);
    }

    Ok(capture::focus::list_windows(session)
        .into_iter()
        .map(|w| {
            let details = capture::app_info::resolve_active_window_details(&w);
            AppEntry {
                title: details.title,
                process_name: details.process_name,
                display_name: details.display_name,
            }
        })
        .collect())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn get_app_icon(process_name: String) -> Result<Option<capture::detection::IconData>, String> {
    Ok(capture::detection::get_app_icon(&process_name))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn start_screen_capture(
    app: tauri::AppHandle,
    monitor_index: usize,
    fps: u32,
) -> Result<(), String> {
    let mut session_guard =
        CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if session_guard.is_some() {
        return Err("A capture session is already active".into());
    }

    let session = match get_session_type() {
        #[cfg(target_os = "linux")]
        SessionType::Wayland => tauri::async_runtime::block_on(
            capture::wayland::start_capture(app, monitor_index, fps),
        )?,
        #[cfg(target_os = "macos")]
        SessionType::MacOS => capture::macos::start_capture(app, monitor_index, fps)?,
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::start_capture(app, monitor_index, fps)?,
        _ => capture::windows::start_capture(app, monitor_index, fps)?,
    };

    *session_guard = Some(session);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn stop_screen_capture() -> Result<(), String> {
    let mut session_guard =
        CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = session_guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active capture session".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn list_audio_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    voice::device::list_input_devices()
}

/// Start the settings-panel microphone level meter. Emits `mic:level` with an
/// RMS float until `stop_audio_capture` is called.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn start_audio_capture(
    app: tauri::AppHandle,
    device_name: Option<String>,
    sample_rate: Option<u32>,
) -> Result<(), String> {
    let mut guard = MIC_TEST.lock().map_err(|e| format!("Lock error: {e}"))?;
    // Dropping any prior session releases its device first — two captures of the
    // same microphone is exactly the contention that makes a mic look broken.
    *guard = None;
    let session =
        voice::mictest::MicTestSession::start(app, device_name, sample_rate.unwrap_or(48_000))?;
    *guard = Some(session);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn stop_audio_capture() -> Result<(), String> {
    let mut guard = MIC_TEST.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = None;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn list_audio_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    voice::device::list_output_devices()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn set_background_enabled(enabled: bool) {
    BACKGROUND_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn get_environment() -> Result<env::EnvDiagnostic, String> {
    env::check_environment().await
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_init(
    app: tauri::AppHandle,
    server_url: String,
    user_id: String,
    username: String,
) -> Result<(), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if guard.is_some() {
        eprintln!("[Voice] voice_init: already initialized, skipping");
        return Ok(());
    }
    let controller = VoiceController::new(app, user_id.clone(), username.clone());
    *guard = Some(controller);
    eprintln!("[Voice] voice_init: OK (url={server_url} user={username})");
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_begin(
    channel_id: String,
    ice_servers: Vec<serde_json::Value>,
    send_params: serde_json::Value,
    recv_params: serde_json::Value,
    voice_bitrate_kbps: u64,
) -> Result<(serde_json::Value, serde_json::Value, serde_json::Value, serde_json::Value), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    let controller = guard.as_mut().ok_or("Voice not initialized")?;
    tauri::async_runtime::block_on(controller.begin_join(&channel_id, ice_servers, send_params, recv_params, voice_bitrate_kbps))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_finish_join(
    voice_bitrate_kbps: u64,
    gate_enabled: bool,
    gate_threshold_db: f32,
    suppression_enabled: bool,
    suppression_strength: f32,
    auto_gain_enabled: bool,
    device_name: Option<String>,
    output_device_id: Option<String>,
) -> Result<(), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    let controller = guard.as_mut().ok_or("Voice not initialized")?;
    tauri::async_runtime::block_on(controller.finish_join(
        voice_bitrate_kbps,
        gate_enabled,
        gate_threshold_db,
        suppression_enabled,
        suppression_strength,
        auto_gain_enabled,
        device_name,
    ))?;

    // Initialize native audio output
    let mut out_guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if out_guard.is_some() {
        let prev = out_guard.take();
        drop(prev);
    }
    match AudioOutput::new(output_device_id, 1.0) {
        Ok(ao) => {
            eprintln!("[Voice] AudioOutput initialized");
            *out_guard = Some(ao);
        }
        Err(e) => {
            eprintln!("[Voice] AudioOutput init failed (non-fatal): {e}");
        }
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_gate(threshold_db: f32) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_gate_threshold(threshold_db));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_noise_suppression(enabled: bool) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_noise_suppression(enabled));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_suppression_mode(mode: String) -> Result<(), String> {
    let ns_mode = match mode.as_str() {
        "off" => NoiseSuppressionMode::Off,
        "spectral" => NoiseSuppressionMode::Spectral,
        "rnnoise" => NoiseSuppressionMode::Rnnoise,
        _ => return Err(format!("Unknown suppression mode: {mode}")),
    };
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_suppression_mode(ns_mode));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_suppression_strength(strength: f32) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_suppression_strength(strength));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

/// Toggle native acoustic echo cancellation (AEC3).
///
/// Unlike the browser path's `echoCancellation` constraint, this does not reopen
/// the microphone on the OS communications device, so it never pauses other
/// applications' audio.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_echo_cancellation(enabled: bool) -> Result<(), String> {
    voice::aec::set_enabled(enabled);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_gate_enabled(enabled: bool) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_gate_enabled(enabled));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

/// Microphone input gain, 0.0-2.0. Applied as a preamp trim ahead of the rest of
/// the capture chain.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_input_volume(volume: f32) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_input_gain(volume));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_peer_volume(peer_id: String, volume: f32) -> Result<(), String> {
    let guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *guard {
        output.set_peer_volume(&peer_id, volume);
        Ok(())
    } else {
        Err("Audio output not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_auto_gain(enabled: bool) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_auto_gain(enabled));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_flush_peers() -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.flush_peers());
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

/// Hand a received Opus packet to the peer's jitter buffer, which decodes it at
/// playout time (see voice/jitter.rs).
///
/// The packet arrives as a raw IPC body rather than a JSON array: at 50 packets
/// per second per peer, `Array.from(new Uint8Array(...))` was inflating every
/// payload roughly fivefold and putting a JSON parse in the audio path.
///
/// Framing (`x-framing` header):
///   2 — `[seq: u16 BE][timestamp: u32 BE][opus...]`
///   1 — bare Opus payload, from a server that predates sequence forwarding
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_inject_opus(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };

    let peer_id = header("x-peer-id").ok_or("missing x-peer-id header")?;
    let framing: u8 = header("x-framing")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("voice_inject_opus expects a raw body".into()),
    };

    let (seq, ts, opus) = if framing >= 2 {
        if body.len() < 6 {
            return Err("framed packet shorter than its header".into());
        }
        let seq = u16::from_be_bytes([body[0], body[1]]);
        let ts = u32::from_be_bytes([body[2], body[3], body[4], body[5]]);
        (Some(seq), Some(ts), &body[6..])
    } else {
        (None, None, body)
    };

    if opus.is_empty() {
        return Ok(());
    }

    let out_guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *out_guard {
        output.push_packet(&peer_id, seq, ts, opus.to_vec());
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_add_peer(peer_id: String, ssrc: u32) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.add_remote_peer(&peer_id, ssrc));
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_leave() -> Result<(), String> {
    // A screenshare cannot outlive the call it was being sent on: leaving with
    // one running would otherwise leave the capture thread (and the portal's
    // "screen is being shared" indicator) alive with nowhere to send frames.
    if let Ok(mut capture) = CAPTURE_SESSION.lock() {
        if let Some(mut session) = capture.take() {
            session.stop();
        }
    }

    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut controller) = *guard {
        controller.leave();
    }

    // Drop audio output
    let mut out_guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    let _ = out_guard.take();

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_drain_signals() -> Result<Vec<(String, serde_json::Value)>, String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut controller) = *guard {
        Ok(tauri::async_runtime::block_on(controller.drain_signals()))
    } else {
        Ok(vec![])
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_muted(muted: bool) -> Result<(), String> {
    let guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref controller) = *guard {
        tauri::async_runtime::block_on(controller.set_muted(muted));
        eprintln!("[Voice] voice_set_muted: muted={muted}");
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_update_bitrate(voice_bitrate_kbps: u64) -> Result<(), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut controller) = *guard {
        controller.update_bitrate(voice_bitrate_kbps);
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_output_volume(volume: f32) -> Result<(), String> {
    let guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *guard {
        output.set_volume(volume);
        Ok(())
    } else {
        Err("Audio output not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_set_output_device(device_id: String) -> Result<(), String> {
    let guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *guard {
        output.set_output_device(Some(device_id));
        Ok(())
    } else {
        Err("Audio output not initialized".into())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_remove_peer(peer_id: String) -> Result<(), String> {
    let guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *guard {
        // Drops the peer's jitter buffer, and its Opus decoder with it.
        output.remove_peer(&peer_id);
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn camera_list_devices() -> Result<Vec<capture::camera::CameraDevice>, String> {
    capture::camera::list_cameras()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn camera_start(
    app: tauri::AppHandle,
    camera_index: usize,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), String> {
    let mut session_guard =
        CAMERA_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if session_guard.is_some() {
        return Err("A camera session is already active".into());
    }

    let session = capture::camera::start_camera(
        app,
        camera_index,
        width,
        height,
        fps,
    )?;

    *session_guard = Some(session);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn camera_stop() -> Result<(), String> {
    let mut session_guard =
        CAMERA_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = session_guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active camera session".into())
    }
}

/// Starts screensharing over the native WebRTC send transport.
///
/// On Linux the webview has no WebRTC stack of its own (see voice/video.rs), so
/// captured frames are VP8-encoded here and written to the call's video track.
/// The encoder is attached *before* capture starts so the first frames are not
/// wasted on the webview JPEG path.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn voice_screen_share_start(
    app: tauri::AppHandle,
    monitor_index: usize,
    fps: u32,
    #[allow(unused_variables)] bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    {
        let guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
        if guard.is_some() {
            return Err("Screen capture already active".into());
        }
    }

    #[cfg(target_os = "linux")]
    {
        let bitrate_bps = bitrate_kbps
            .map(|kbps| kbps * 1000)
            .unwrap_or(voice::SCREEN_SHARE_BITRATE_BPS);
        let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
        let controller = guard.as_mut().ok_or("Voice is not connected")?;
        controller.start_screen_share(fps.max(1), bitrate_bps)?;
    }

    let session = match get_session_type() {
        #[cfg(target_os = "linux")]
        SessionType::Wayland => capture::wayland::start_capture(app, monitor_index, fps).await,
        #[cfg(target_os = "macos")]
        SessionType::MacOS => capture::macos::start_capture(app.clone(), monitor_index, fps),
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::start_capture(app.clone(), monitor_index, fps),
        _ => capture::windows::start_capture(app, monitor_index, fps),
    };

    let session = match session {
        Ok(session) => session,
        Err(e) => {
            // Portal dialog cancelled or capture failed: don't leave the
            // encoder running against a sink that will never be fed.
            #[cfg(target_os = "linux")]
            stop_native_screen_encode();
            return Err(e);
        }
    };

    let mut guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = Some(session);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_screen_share_stop() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    stop_native_screen_encode();

    let mut guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active screen capture".into())
    }
}

#[cfg(target_os = "linux")]
fn stop_native_screen_encode() {
    if let Ok(mut guard) = VOICE_CONTROLLER.lock() {
        if let Some(controller) = guard.as_mut() {
            controller.stop_screen_share();
        }
    }
}

/// Bring the main window back after close-to-tray hid it.
///
/// On macOS `window.hide()` orders the window out but leaves the app running,
/// so the app itself has to be unhidden before showing the window again —
/// otherwise `show()` lands on a window whose application is still hidden and
/// nothing appears on screen.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    #[cfg(target_os = "macos")]
    let _ = app.show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(any(target_os = "android", target_os = "ios"), tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = get_session_type();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler({
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                tauri::generate_handler![
                    greet,
                    list_monitors,
                    get_active_window_info,
                    get_active_window_details,
                    get_now_playing,
                    list_windows,
                    get_app_icon,
                    start_screen_capture,
                    stop_screen_capture,
                    camera_list_devices,
                    camera_start,
                    camera_stop,
                    list_audio_input_devices,
                    list_audio_output_devices,
                    start_audio_capture,
                    stop_audio_capture,
                    get_environment,
                    voice_init,
                    voice_begin,
                    voice_finish_join,
                    voice_add_peer,
                    voice_flush_peers,
                    voice_inject_opus,
                    voice_leave,
                    voice_drain_signals,
                    voice_set_muted,
                    voice_update_bitrate,
                    voice_set_gate,
                    voice_set_noise_suppression,
                    voice_set_suppression_mode,
                    voice_set_suppression_strength,
                    voice_set_auto_gain,
                    voice_set_gate_enabled,
                    voice_set_input_volume,
                    voice_set_peer_volume,
                    voice_set_echo_cancellation,
                    voice_set_output_volume,
                    voice_set_output_device,
                    voice_remove_peer,
                    voice_screen_share_start,
                    voice_screen_share_stop,
                    set_background_enabled,
                ]
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                tauri::generate_handler![greet]
            }
        })
        .setup(|_app| {
            #[cfg(all(debug_assertions, not(any(target_os = "android", target_os = "ios"))))]
            {
                use tauri::Manager;
                let window = _app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // WebKitGTK keeps `enable-webrtc` (and `enable-media-stream`, which
            // it depends on) off by default and wry never turns them on, so
            // RTCPeerConnection is undefined in the webview. Screenshare no
            // longer needs it (see voice/video.rs), but camera and any other
            // webview-side WebRTC do. Note this only helps where the distro
            // built WebKitGTK with ENABLE_WEB_RTC=ON — Arch, among others, does
            // not, which is why screenshare stopped relying on the webview.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{SettingsExt, WebViewExt};

                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_webrtc(true);
                        }
                    });
                }
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;

                let show_item = MenuItem::with_id(_app, "show", "Open Kizuna", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(_app, "quit", "Quit", true, None::<&str>)?;
                let tray_menu = Menu::with_items(_app, &[&show_item, &quit_item])?;

                TrayIconBuilder::new()
                    .icon(_app.default_window_icon().unwrap().clone())
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => restore_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            restore_main_window(tray.app_handle());
                        }
                    })
                    .build(_app)?;
            }

            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                if BACKGROUND_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {
            // Clicking the Dock icon fires `Reopen`. Close-to-tray hid the
            // window, so AppKit finds no visible window to raise and does
            // nothing on its own — we have to restore it here.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                restore_main_window(_app_handle);
            }
        });
}
