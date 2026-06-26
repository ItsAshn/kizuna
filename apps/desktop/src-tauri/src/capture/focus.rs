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

pub fn list_windows(session_type: SessionType) -> Vec<WindowInfo> {
    match session_type {
        SessionType::Windows => {
            #[cfg(target_os = "windows")]
            return list_windows_windows();
            #[cfg(not(target_os = "windows"))]
            return Vec::new();
        }
        SessionType::MacOS => {
            #[cfg(target_os = "macos")]
            return list_windows_macos();
            #[cfg(not(target_os = "macos"))]
            return Vec::new();
        }
        SessionType::Wayland => {
            #[cfg(target_os = "linux")]
            return list_windows_wayland();
            #[cfg(not(target_os = "linux"))]
            return Vec::new();
        }
        SessionType::X11 => {
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            return list_windows_x11();
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            return Vec::new();
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

#[cfg(target_os = "windows")]
fn list_windows_windows() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::sync::Mutex;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    static WINDOWS: Mutex<Vec<WindowInfo>> = Mutex::new(Vec::new());

    unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL::from(true);
        }
        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        if title_len == 0 {
            return BOOL::from(true);
        }
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return BOOL::from(true);
        }
        let mut guard = WINDOWS.lock().unwrap();
        guard.push(WindowInfo {
            title: trimmed.to_string(),
            process_name: String::new(),
        });
        BOOL::from(true)
    }

    {
        let mut guard = WINDOWS.lock().unwrap();
        guard.clear();
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    }

    let guard = WINDOWS.lock().unwrap();
    let mut seen: HashSet<String> = HashSet::new();
    guard
        .iter()
        .filter(|w| {
            let key = w.title.to_lowercase();
            seen.insert(key)
        })
        .cloned()
        .collect()
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

#[cfg(target_os = "macos")]
fn list_windows_macos() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::process::Command;

    let output = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get name of every application process whose visible is true",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // osascript returns comma-separated list like "App1, App2, App3"
    let mut seen: HashSet<String> = HashSet::new();
    output
        .split(", ")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter_map(|name| {
            let key = name.to_lowercase();
            if seen.insert(key) {
                Some(WindowInfo {
                    title: name.to_string(),
                    process_name: String::new(),
                })
            } else {
                None
            }
        })
        .collect()
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn list_windows_x11() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::process::Command;

    let output = match Command::new("wmctrl").arg("-l").output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let raw = String::from_utf8_lossy(&output.stdout);
    let mut seen: HashSet<String> = HashSet::new();
    let mut results: Vec<WindowInfo> = Vec::new();

    for line in raw.lines() {
        // wmctrl -l format: "0x02c00001  0 hostname Window Title"
        // Window ID is hex (first field), title is after hostname
        let parts: Vec<&str> = line.splitn(4, ' ').collect();
        if parts.len() < 4 {
            continue;
        }
        // parts[0] = window ID (hex), parts[1] = desktop, parts[2] = hostname
        // parts[3] = the rest is the title
        let title = parts[3].trim();
        if title.is_empty() {
            continue;
        }
        let key = title.to_lowercase();
        if seen.insert(key) {
            results.push(WindowInfo {
                title: title.to_string(),
                process_name: String::new(),
            });
        }
    }

    results
}

// ── Wayland implementation (subprocess-based hybrid) ─────────

#[cfg(target_os = "linux")]
fn wayland_active_window() -> Option<WindowInfo> {
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
fn list_windows_wayland() -> Vec<WindowInfo> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();

    // Hyprland: hyprctl clients -j gives a clean JSON list
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() || desktop.contains("Hyprland") {
        if !list_windows_hyprland().is_empty() {
            return list_windows_hyprland();
        }
    }

    // Sway / i3-compatible: swaymsg -t get_tree
    if !list_windows_sway().is_empty() {
        return list_windows_sway();
    }

    // wlroots generic: wlrctl toplevel list (all windows)
    if !list_windows_wlrctl().is_empty() {
        return list_windows_wlrctl();
    }

    Vec::new()
}

#[cfg(target_os = "linux")]
fn list_windows_hyprland() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::process::Command;

    let output = match Command::new("hyprctl").args(["clients", "-j"]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !output.status.success() {
        return Vec::new();
    }

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let clients = match json.as_array() {
        Some(arr) => arr,
        None => return Vec::new(),
    };

    let mut seen: HashSet<String> = HashSet::new();
    clients
        .iter()
        .filter_map(|c| {
            let mapped = c.get("mapped").and_then(|m| m.as_bool()).unwrap_or(false);
            if !mapped {
                return None;
            }
            let title = c.get("title")?.as_str().unwrap_or_default();
            if title.is_empty() {
                return None;
            }
            let class = c
                .get("class")
                .and_then(|cl| cl.as_str())
                .unwrap_or_default()
                .to_string();
            let key = format!("{}|{}", class.to_lowercase(), title.to_lowercase());
            if !seen.insert(key) {
                return None;
            }
            Some(WindowInfo {
                title: title.to_string(),
                process_name: class,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn list_windows_sway() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::process::Command;

    let output = match Command::new("swaymsg").args(["-t", "get_tree"]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !output.status.success() {
        return Vec::new();
    }

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut results: Vec<WindowInfo> = Vec::new();
    collect_sway_windows(&json, &mut seen, &mut results);
    results
}

#[cfg(target_os = "linux")]
fn collect_sway_windows(
    node: &serde_json::Value,
    seen: &mut std::collections::HashSet<String>,
    results: &mut Vec<WindowInfo>,
) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or_default();

    if node_type == "con" || node_type == "floating_con" {
        let name = node.get("name").and_then(|n| n.as_str()).unwrap_or_default();
        let app_id = node.get("app_id").and_then(|a| a.as_str()).unwrap_or_default();
        if !name.is_empty() {
            let key = format!("{}|{}", app_id.to_lowercase(), name.to_lowercase());
            if seen.insert(key) {
                results.push(WindowInfo {
                    title: name.to_string(),
                    process_name: app_id.to_string(),
                });
            }
        }
    }

    if let Some(nodes) = node.get("nodes").and_then(|n| n.as_array()) {
        for child in nodes {
            collect_sway_windows(child, seen, results);
        }
    }
    if let Some(nodes) = node.get("floating_nodes").and_then(|n| n.as_array()) {
        for child in nodes {
            collect_sway_windows(child, seen, results);
        }
    }
}

#[cfg(target_os = "linux")]
fn list_windows_wlrctl() -> Vec<WindowInfo> {
    use std::collections::HashSet;
    use std::process::Command;

    let output = match Command::new("wlrctl").args(["toplevel", "list"]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let raw = String::from_utf8_lossy(&output.stdout);
    let mut seen: HashSet<String> = HashSet::new();
    let mut results: Vec<WindowInfo> = Vec::new();

    for line in raw.lines() {
        // wlrctl output: " ... title: "Foo" app_id: "bar" ..."
        // Not every line is a window; we look for title/app_id pairs.
        let title = line
            .split("title: ")
            .nth(1)
            .and_then(|s| {
                let quoted = s.split('"').nth(1)?;
                Some(quoted.to_string())
            })
            .unwrap_or_default();

        let app_id = line
            .split("app_id: ")
            .nth(1)
            .and_then(|s| {
                let quoted = s.split('"').nth(1)?;
                Some(quoted.to_string())
            })
            .unwrap_or_default();

        if !title.is_empty() {
            let key = format!("{}|{}", app_id.to_lowercase(), title.to_lowercase());
            if seen.insert(key) {
                results.push(WindowInfo {
                    title,
                    process_name: app_id,
                });
            }
        }
    }

    results
}

#[cfg(target_os = "linux")]
fn gnome_active_window() -> Option<WindowInfo> {
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
