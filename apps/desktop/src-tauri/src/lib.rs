mod capture;
mod env;
mod voice;

use std::sync::Mutex;

use capture::{CaptureSession, MonitorInfo, SessionType};
use voice::device::AudioDeviceInfo;
use voice::rnnoise::NoiseSuppressionMode;
use voice::VoiceController;

static CAPTURE_SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);
static SESSION_TYPE: Mutex<Option<SessionType>> = Mutex::new(None);
static VOICE_CONTROLLER: Mutex<Option<VoiceController>> = Mutex::new(None);
static VOICE_DECODER: Mutex<Option<opus2::Decoder>> = Mutex::new(None);

fn get_session_type() -> SessionType {
    let mut guard = SESSION_TYPE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(capture::detect_session_type());
    }
    guard.unwrap()
}

#[tauri::command]
fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    match get_session_type() {
        #[cfg(target_os = "linux")]
        SessionType::Wayland => {
            tauri::async_runtime::block_on(capture::wayland::list_sources())
        }
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::list_monitors(),
        _ => capture::windows::list_monitors(),
    }
}

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
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::start_capture(app, monitor_index, fps)?,
        _ => capture::windows::start_capture(app, monitor_index, fps)?,
    };

    *session_guard = Some(session);
    Ok(())
}

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

#[tauri::command]
fn list_audio_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    voice::device::list_input_devices()
}

#[tauri::command]
fn list_audio_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    voice::device::list_output_devices()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
async fn get_environment() -> Result<env::EnvDiagnostic, String> {
    env::check_environment().await
}

#[tauri::command]
fn voice_init(
    app: tauri::AppHandle,
    server_url: String,
    auth_token: String,
    user_id: String,
    username: String,
) -> Result<(), String> {
    let _ = auth_token; // stored in TS session, not needed here
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

#[tauri::command]
fn voice_begin(
    channel_id: String,
    ice_servers: Vec<serde_json::Value>,
    send_params: serde_json::Value,
    recv_params: serde_json::Value,
    voice_bitrate_kbps: u64,
) -> Result<(serde_json::Value, serde_json::Value, serde_json::Value), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    let controller = guard.as_mut().ok_or("Voice not initialized")?;
    tauri::async_runtime::block_on(controller.begin_join(&channel_id, ice_servers, send_params, recv_params, voice_bitrate_kbps))
}

#[tauri::command]
fn voice_finish_join(
    voice_bitrate_kbps: u64,
    gate_enabled: bool,
    gate_threshold_db: f32,
    suppression_enabled: bool,
    suppression_strength: f32,
    auto_gain_enabled: bool,
    device_name: Option<String>,
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
    ))
}

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

#[tauri::command]
fn voice_inject_opus(app: tauri::AppHandle, peer_id: String, opus_data: Vec<u8>) -> Result<(), String> {
    use tauri::Emitter;
    let mut guard = VOICE_DECODER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if guard.is_none() {
        *guard = Some(
            opus2::Decoder::new(48000, opus2::Channels::Mono)
                .map_err(|e| format!("Opus decoder: {e}"))?,
        );
    }
    let decoder = guard.as_mut().unwrap();

    let frame_size = 48000 * 60 / 1000;
    let mut pcm = vec![0.0f32; frame_size];
    let samples = decoder
        .decode_float(&opus_data, &mut pcm, false)
        .map_err(|e| format!("Opus decode: {e}"))?;
    pcm.truncate(samples);
    pcm.shrink_to_fit();

    // Clamp samples to [-1, 1] to prevent any overflow/distortion from corrupt packets
    for s in &mut pcm {
        *s = s.clamp(-1.0, 1.0);
    }

    let _ = app.emit(
        "voice:remote_audio",
        serde_json::json!({
            "peerId": peer_id,
            "samples": pcm,
            "sampleRate": 48000,
        }),
    );
    Ok(())
}

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

#[tauri::command]
fn voice_leave() -> Result<(), String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut controller) = *guard {
        controller.leave();
        Ok(())
    } else {
        Err("Voice not initialized".into())
    }
}

#[tauri::command]
fn voice_drain_signals() -> Result<Vec<(String, serde_json::Value)>, String> {
    let mut guard = VOICE_CONTROLLER.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut controller) = *guard {
        Ok(tauri::async_runtime::block_on(controller.drain_signals()))
    } else {
        Ok(vec![])
    }
}

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
        #[cfg(not(target_os = "windows"))]
        SessionType::X11 => capture::x11::start_capture(app.clone(), monitor_index, fps)?,
        _ => capture::windows::start_capture(app, monitor_index, fps)?,
    };
    let mut guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = Some(session);
    Ok(())
}

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

pub fn run() {
    let _ = get_session_type();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            list_monitors,
            start_screen_capture,
            stop_screen_capture,
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
            voice_screen_share_start,
            voice_screen_share_stop,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
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
