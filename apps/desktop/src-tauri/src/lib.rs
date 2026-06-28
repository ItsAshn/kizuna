#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod capture;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod env;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod voice;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::collections::HashMap;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::Mutex;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::{CaptureSession, MonitorInfo, SessionType};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::focus::WindowInfo;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use capture::detection::AppEntry;
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
static VOICE_DECODERS: Mutex<Option<HashMap<String, opus2::Decoder>>> = Mutex::new(None);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static AUDIO_OUTPUT: Mutex<Option<AudioOutput>> = Mutex::new(None);

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
        .map(AppEntry::from)
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_inject_opus(_app: tauri::AppHandle, peer_id: String, opus_data: Vec<u8>) -> Result<(), String> {
    let mut guard = VOICE_DECODERS.lock().map_err(|e| format!("Lock error: {e}"))?;
    let decoders = guard.get_or_insert_with(HashMap::new);
    if !decoders.contains_key(&peer_id) {
        let d = opus2::Decoder::new(48000, opus2::Channels::Mono)
            .map_err(|e| format!("Opus decoder: {e}"))?;
        decoders.insert(peer_id.clone(), d);
    }
    let decoder = decoders.get_mut(&peer_id).expect("decoder just inserted");

    // 60ms is Opus's maximum frame size; keep the buffer this large so any frame
    // duration decodes safely. Actual length is taken from the decoded count below.
    let frame_size = 48000 * 60 / 1000;
    let mut pcm = vec![0.0f32; frame_size];
    let samples = match decoder.decode_float(&opus_data, &mut pcm, false) {
        Ok(n) => n,
        Err(e) => {
            // Packet-loss concealment: synthesize one 20ms frame from decoder
            // state rather than dropping audio (a hard gap/click). Gap-driven FEC
            // recovery needs RTP sequence numbers — handled by the Phase 3 jitter
            // buffer; here we conceal isolated decode failures.
            eprintln!("[voice_inject_opus] decode failed ({e}); concealing one frame");
            let conceal = 960.min(pcm.len());
            decoder.decode_float(&[], &mut pcm[..conceal], false).unwrap_or(0)
        }
    };
    pcm.truncate(samples);

    for s in &mut pcm {
        *s = s.clamp(-1.0, 1.0);
    }

    drop(guard);

    // Push to native audio output (replaces voice:remote_audio event)
    let out_guard = AUDIO_OUTPUT.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref output) = *out_guard {
        output.push_pcm(&peer_id, pcm);
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
        output.remove_peer(&peer_id);
    }
    if let Ok(mut decoders) = VOICE_DECODERS.lock() {
        if let Some(map) = decoders.as_mut() {
            map.remove(&peer_id);
        }
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn voice_screen_share_start(app: tauri::AppHandle, monitor_index: usize, fps: u32) -> Result<(), String> {
    {
        let guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
        if guard.is_some() {
            return Err("Screen capture already active".into());
        }
    }
    let session = match get_session_type() {
        #[cfg(target_os = "linux")]
        SessionType::Wayland => capture::wayland::start_capture(app, monitor_index, fps).await?,
        #[cfg(target_os = "macos")]
        SessionType::MacOS => capture::macos::start_capture(app.clone(), monitor_index, fps)?,
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::start_capture(app.clone(), monitor_index, fps)?,
        _ => capture::windows::start_capture(app, monitor_index, fps)?,
    };
    let mut guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = Some(session);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn voice_screen_share_stop() -> Result<(), String> {
    let mut guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active screen capture".into())
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
                    voice_set_output_volume,
                    voice_set_output_device,
                    voice_remove_peer,
                    voice_screen_share_start,
                    voice_screen_share_stop,
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
