use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// Icon data returned to the frontend, ready to use as an `<img>` src.
#[derive(Clone, Debug, Serialize)]
pub struct IconData {
    /// base64-encoded PNG data URI (`data:image/png;base64,...`)
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Process-keyed icon cache. Reading an executable's icon is expensive, and an
/// app's icon never changes while it is running, so we resolve it at most once
/// per process. Negative results (`None`) are cached too, so apps x-win can't
/// resolve aren't re-queried on every window switch.
static ICON_CACHE: Mutex<Option<HashMap<String, Option<IconData>>>> = Mutex::new(None);

/// Normalize a process name for comparison: lowercase, trimmed, `.exe` stripped.
fn normalize_proc(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .strip_suffix(".exe")
        .map(|s| s.to_string())
        .unwrap_or_else(|| name.trim().to_lowercase())
}

/// Try to get the icon for `process_name`, the process the caller has detected
/// as foreground.
///
/// Uses `x-win-rs` where available (Windows, macOS, GNOME/Linux). To avoid a
/// race where a different window becomes active between the caller's detection
/// and this call, we re-query the active window and only return its icon when it
/// still matches `process_name`. Falls back gracefully (returns `None`) when
/// x-win is unavailable or the platform is unsupported (Hyprland, Sway, etc.).
pub fn get_app_icon(process_name: &str) -> Option<IconData> {
    let key = normalize_proc(process_name);
    if key.is_empty() {
        return None;
    }

    // Serve from cache (including cached negatives) first.
    if let Ok(mut guard) = ICON_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
    }

    let resolved = resolve_app_icon(&key);

    if let Ok(mut guard) = ICON_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.insert(key, resolved.clone());
    }

    resolved
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_app_icon(key: &str) -> Option<IconData> {
    let window = x_win::get_active_window().ok()?;
    if window.id == 0 || window.title.is_empty() {
        return None;
    }
    // Only trust the icon when the active window still matches the process the
    // caller asked about — otherwise we'd cache the wrong app's icon.
    if normalize_proc(&window.info.exec_name) != key {
        return None;
    }
    let icon = x_win::get_window_icon(&window).ok()?;
    if icon.data.is_empty() {
        return None;
    }
    Some(IconData {
        data: icon.data,
        width: icon.width,
        height: icon.height,
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn resolve_app_icon(_key: &str) -> Option<IconData> {
    None
}

/// Try to get a list of all visible apps (with display names) from x-win.
///
/// Falls back to the native `focus::list_windows()` when x-win is unavailable
/// or returns no results.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn list_apps_xwin() -> Option<Vec<AppEntry>> {
    let windows = x_win::get_open_windows().ok()?;
    if windows.is_empty() {
        return None;
    }

    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let entries: Vec<AppEntry> = windows
        .into_iter()
        .filter(|w| {
            if w.title.is_empty() || w.info.name.is_empty() {
                return false;
            }
            let key = format!("{}|{}", w.info.exec_name, w.title);
            seen.insert(key)
        })
        .map(|w| AppEntry {
            title: w.title,
            process_name: w.info.exec_name,
            display_name: w.info.name,
        })
        .collect();

    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn list_apps_xwin() -> Option<Vec<AppEntry>> {
    None
}

/// A single app/window entry used in the `list_windows` command response.
#[derive(Clone, Debug, Serialize)]
pub struct AppEntry {
    pub title: String,
    pub process_name: String,
    pub display_name: String,
}

impl From<super::focus::WindowInfo> for AppEntry {
    fn from(w: super::focus::WindowInfo) -> Self {
        Self {
            display_name: w.process_name.clone(),
            title: w.title,
            process_name: w.process_name,
        }
    }
}
