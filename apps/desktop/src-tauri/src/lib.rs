mod capture;

use std::sync::Mutex;

static CAPTURE_SESSION: Mutex<Option<capture::CaptureSession>> = Mutex::new(None);

#[tauri::command]
fn list_monitors() -> Result<Vec<capture::MonitorInfo>, String> {
    capture::list_monitors()
}

#[tauri::command]
fn start_screen_capture(app: tauri::AppHandle, monitor_index: usize, fps: u32) -> Result<(), String> {
    let mut session_guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if session_guard.is_some() {
        return Err("A capture session is already active".into());
    }
    let session = capture::start_capture(app, monitor_index, fps)?;
    *session_guard = Some(session);
    Ok(())
}

#[tauri::command]
fn stop_screen_capture() -> Result<(), String> {
    let mut session_guard = CAPTURE_SESSION.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut session) = session_guard.take() {
        session.stop();
        Ok(())
    } else {
        Err("No active capture session".into())
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn run() {
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
