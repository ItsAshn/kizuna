use serde::Serialize;

/// Icon data returned to the frontend, ready to use as an `<img>` src.
#[derive(Clone, Debug, Serialize)]
pub struct IconData {
    /// base64-encoded PNG data URI (`data:image/png;base64,...`)
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Try to get the icon of the currently active window.
///
/// Uses `x-win-rs` where available (Windows, macOS, GNOME/Linux).
/// Falls back gracefully when x-win is absent or the platform is
/// unsupported (Hyprland, Sway, etc.) — returns `None` with no error.
pub fn get_active_app_icon() -> Option<IconData> {
    #[cfg(feature = "x-win")]
    {
        let window = x_win::get_active_window().ok()?;
        if window.id == 0 || window.title.is_empty() {
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
    #[cfg(not(feature = "x-win"))]
    {
        None
    }
}

/// Try to get a list of all visible apps (with display names) from x-win.
///
/// Falls back to the native `focus::list_windows()` when x-win is unavailable
/// or returns no results.
#[cfg(feature = "x-win")]
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

#[cfg(not(feature = "x-win"))]
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
