mod capture;
mod env;
mod voice;

use std::sync::{Arc, Mutex};

use capture::audio::AudioCaptureSession;
use capture::audio::AudioDeviceInfo;
use capture::{CaptureSession, MonitorInfo, SessionType};
use voice::VoiceSession;

static CAPTURE_SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);
static AUDIO_SESSION: Mutex<Option<AudioCaptureSession>> = Mutex::new(None);
static SESSION_TYPE: Mutex<Option<SessionType>> = Mutex::new(None);
static VOICE_SESSION: Mutex<Option<Arc<VoiceSession>>> = Mutex::new(None);

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
    capture::audio::list_input_devices()
}

#[tauri::command]
fn list_audio_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    capture::audio::list_output_devices()
}

#[tauri::command]
fn start_audio_capture(
    app: tauri::AppHandle,
    device_name: Option<String>,
    sample_rate: u32,
    channels: u16,
) -> Result<(), String> {
    let mut session_guard =
        AUDIO_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if session_guard.is_some() {
        return Err("An audio capture session is already active".into());
    }

    let session = capture::audio::start_capture(
        app,
        device_name,
        sample_rate,
        channels,
    )?;

    *session_guard = Some(session);
    Ok(())
}

#[tauri::command]
fn stop_audio_capture() -> Result<(), String> {
    let mut session_guard =
        AUDIO_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = session_guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active audio capture session".into())
    }
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
    let mut guard = VOICE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(old) = guard.take() {
        drop(old);
    }
    let session = VoiceSession::new(app, server_url, auth_token, user_id, username);
    *guard = Some(Arc::new(session));
    Ok(())
}

#[tauri::command]
async fn voice_join(channel_id: String) -> Result<(), String> {
    let session = {
        let guard = VOICE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
        guard.clone()
    };
    match session {
        Some(s) => {
            s.join(channel_id).await;
            Ok(())
        }
        None => Err("Voice not initialized. Call voice_init first.".into()),
    }
}

#[tauri::command]
async fn voice_leave() -> Result<(), String> {
    let session = {
        let guard = VOICE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
        guard.clone()
    };
    match session {
        Some(s) => {
            s.leave().await;
            Ok(())
        }
        None => Err("Voice not initialized.".into()),
    }
}

#[tauri::command]
async fn voice_set_muted(muted: bool) -> Result<(), String> {
    let session = {
        let guard = VOICE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
        guard.clone()
    };
    match session {
        Some(s) => {
            s.set_muted(muted).await;
            Ok(())
        }
        None => Err("Voice not initialized.".into()),
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
            start_audio_capture,
            stop_audio_capture,
            get_environment,
            voice_init,
            voice_join,
            voice_leave,
            voice_set_muted,
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
