use serde::Serialize;

use super::SessionType;

#[derive(Clone, Debug, Serialize)]
pub struct WindowInfo {
    pub title: String,
    pub process_name: String,
}

pub fn get_active_window_info(session_type: SessionType) -> Option<WindowInfo> {
    match session_type {
        SessionType::Windows => {
            #[cfg(target_os = "windows")]
            return windows_active_window();
            #[cfg(not(target_os = "windows"))]
            return None;
        }
        SessionType::MacOS => {
            #[cfg(target_os = "macos")]
            return macos_active_window();
            #[cfg(not(target_os = "macos"))]
            return None;
        }
        SessionType::Wayland => {
            #[cfg(target_os = "linux")]
            return wayland_active_window();
            #[cfg(not(target_os = "linux"))]
            return None;
        }
        SessionType::X11 => {
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            return x11_active_window();
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            return None;
        }
    }
}

// ── Windows implementation ──────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_active_window() -> Option<WindowInfo> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::System::ProcessStatus::K32GetModuleBaseNameW;
    use windows::Win32::System::Threading::OpenProcess;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0 == std::ptr::null_mut() {
            return None;
        }

        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let process_name = if pid != 0 {
            let handle: HANDLE = OpenProcess(
                windows::Win32::System::Threading::PROCESS_QUERY_INFORMATION
                    | windows::Win32::System::Threading::PROCESS_VM_READ,
                false,
                pid,
            )
            .unwrap_or(HANDLE::default());
            if handle.0 != std::ptr::null_mut() {
                let mut name_buf = [0u16; 260];
                let name_len = K32GetModuleBaseNameW(handle, None, &mut name_buf);
                let _ = CloseHandle(handle);
                if name_len > 0 {
                    String::from_utf16_lossy(&name_buf[..name_len as usize])
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        if title.is_empty() && process_name.is_empty() {
            return None;
        }
        Some(WindowInfo {
            title,
            process_name,
        })
    }
}

// ── macOS implementation ────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let title = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())?;

    let process_name = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get short name of first application process whose frontmost is true",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Some(WindowInfo {
        title,
        process_name,
    })
}

// ── X11 implementation ───────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn x11_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let title = Command::new("xdotool")
        .args(["getactivewindow", "getwindowname"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())?;

    let process_name = Command::new("xdotool")
        .args(["getactivewindow", "getwindowpid"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .and_then(|pid| {
            std::fs::read_to_string(format!("/proc/{}/comm", pid))
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();

    Some(WindowInfo {
        title,
        process_name,
    })
}

// ── Wayland implementation (subprocess-based hybrid) ─────────

#[cfg(target_os = "linux")]
fn wayland_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();

    // GNOME: try gdbus
    if desktop.contains("GNOME") {
        if let Some(info) = gnome_active_window() {
            return Some(info);
        }
        return None;
    }

    // Hyprland: use its native IPC (always available, no extra tools)
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() || desktop.contains("Hyprland") {
        if let Some(info) = hyprland_active_window() {
            return Some(info);
        }
    }

    // wlroots-based (Hyprland, Sway, river): try wlrctl
    if let Some(info) = wlrctl_active_window() {
        return Some(info);
    }

    // KDE Plasma (Wayland): try kdotool or xdotool via XWayland bridge
    // Many apps still run under XWayland, so xdotool may work
    if let Some(info) = kde_wayland_active_window() {
        return Some(info);
    }

    // Final fallback: try xdotool for XWayland apps
    x11_active_window()
}

#[cfg(target_os = "linux")]
fn gnome_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let title = gdbus_eval("global.display.focus_window?.get_title() ?? ''")?;

    let app_id = gdbus_eval("global.display.focus_window?.get_wm_class() ?? ''")
        .unwrap_or_default();

    Some(WindowInfo {
        title,
        process_name: app_id,
    })
}

#[cfg(target_os = "linux")]
fn gdbus_eval(js: &str) -> Option<String> {
    use std::process::Command;

    let output = Command::new("gdbus")
        .args([
            "call", "--session",
            "--dest", "org.gnome.Shell",
            "--object-path", "/org/gnome/Shell",
            "--method", "org.gnome.Shell.Eval",
            js,
        ])
        .output()
        .ok()?;

    let s = String::from_utf8_lossy(&output.stdout).to_string();
    if s.contains("(true,") {
        let start = s.find('\'')? + 1;
        let end = s.rfind('\'')?;
        let val = &s[start..end];
        if val.is_empty() {
            None
        } else {
            Some(val.to_string())
        }
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn hyprland_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let output = Command::new("hyprctl")
        .args(["activewindow", "-j"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let title = json.get("title")?.as_str().unwrap_or_default().to_string();
    if title.is_empty() {
        return None;
    }
    let class = json
        .get("class")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();

    Some(WindowInfo {
        title,
        process_name: class,
    })
}

#[cfg(target_os = "linux")]
fn wlrctl_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let output = Command::new("wlrctl")
        .args(["toplevel", "list"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .filter(|s| !s.is_empty())?;

    for line in output.lines() {
        if line.contains("active: true") || line.contains("activated: true") {
            let title = line
                .split("title: ")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .map(|s| s.trim_matches('"').to_string())
                .unwrap_or_default();

            let app_id = line
                .split("app_id: ")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .map(|s| s.trim_matches('"').to_string())
                .unwrap_or_default();

            if !title.is_empty() {
                return Some(WindowInfo {
                    title,
                    process_name: app_id,
                });
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn kde_wayland_active_window() -> Option<WindowInfo> {
    use std::process::Command;

    let output = Command::new("kdotool")
        .args(["getactivewindow", "getwindowname"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(title) = output {
        return Some(WindowInfo {
            title,
            process_name: String::new(),
        });
    }

    None
}
