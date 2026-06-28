use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

use super::focus::WindowInfo;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AppCategory {
    Game,
    App,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActiveWindowDetails {
    pub title: String,
    pub process_name: String,
    pub display_name: String,
    pub category: AppCategory,
    pub icon: Option<String>,
}

/// Cache of resolved details keyed by normalized process name.
static RESOLVED_CACHE: Mutex<Option<HashMap<String, ResolvedInfo>>> = Mutex::new(None);

#[derive(Clone)]
struct ResolvedInfo {
    display_name: String,
    category: AppCategory,
    icon: Option<String>,
}

/// Processes that should never be shown as user activity.
const SYSTEM_PROCESSES: &[&str] = &[
    // Password managers
    "keepassxc", "keepass", "bitwarden", "1password",
    // Lock screens
    "hyprlock", "swaylock", "i3lock", "gtklock",
    "kscreenlocker", "gnome-screensaver",
    // Desktop shells
    "plasmashell", "gnome-shell", "kded5",
    // This app
    "kizuna", "kizuna-desktop",
];

/// Normalize a process name for matching: lowercase, strip .exe.
fn normalize_proc(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .strip_suffix(".exe")
        .unwrap_or(name.trim())
        .to_string()
}

pub fn resolve_active_window_details(info: &WindowInfo) -> ActiveWindowDetails {
    let key = normalize_proc(&info.process_name);

    if SYSTEM_PROCESSES.contains(&key.as_str()) {
        return ActiveWindowDetails {
            display_name: humanize_name(&key),
            category: AppCategory::App,
            icon: None,
            title: info.title.clone(),
            process_name: info.process_name.clone(),
        };
    }

    if let Ok(guard) = RESOLVED_CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if let Some(cached) = cache.get(&key) {
                return ActiveWindowDetails {
                    display_name: cached.display_name.clone(),
                    category: cached.category.clone(),
                    icon: cached.icon.clone(),
                    title: info.title.clone(),
                    process_name: info.process_name.clone(),
                };
            }
        }
    }

    let resolved = resolve_info(&key);

    if let Ok(mut guard) = RESOLVED_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.insert(key.clone(), resolved.clone());
    }

    ActiveWindowDetails {
        display_name: resolved.display_name,
        category: resolved.category,
        icon: resolved.icon,
        title: info.title.clone(),
        process_name: info.process_name.clone(),
    }
}

fn resolve_info(key: &str) -> ResolvedInfo {
    // Try system-specific resolution first
    #[cfg(target_os = "linux")]
    if let Some(resolved) = resolve_info_linux(key) {
        return resolved;
    }

    ResolvedInfo {
        display_name: humanize_name(key),
        category: AppCategory::App,
        icon: None,
    }
}

fn humanize_name(key: &str) -> String {
    key.split(|c: char| c == '-' || c == '_' || c == '.')
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().to_string() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Linux: XDG desktop file resolution ──────────────────────────

#[cfg(target_os = "linux")]
struct DesktopFile {
    name: String,
    icon: String,
    categories: Vec<String>,
}

#[cfg(target_os = "linux")]
fn resolve_info_linux(key: &str) -> Option<ResolvedInfo> {
    let desktop_file = find_desktop_file(key)?;

    let display_name = desktop_file.name;
    let category = if desktop_file
        .categories
        .iter()
        .any(|c| c == "Game" || c == "Games")
    {
        AppCategory::Game
    } else {
        AppCategory::App
    };
    let icon = resolve_icon_file(&desktop_file.icon);

    Some(ResolvedInfo {
        display_name,
        category,
        icon,
    })
}

#[cfg(target_os = "linux")]
fn find_desktop_file(class: &str) -> Option<DesktopFile> {
    let class_lower = class.to_lowercase();

    let mut dirs: Vec<String> = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        dirs.push(format!("{}/.local/share/applications", home));
    }

    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':') {
        dirs.push(dir.to_string());
    }

    // Strip common prefixes for matching
    let stripped = class_lower
        .strip_prefix("org.")
        .or_else(|| class_lower.strip_prefix("net."))
        .or_else(|| class_lower.strip_prefix("com."))
        .map(|s| s.to_string())
        .unwrap_or_default();

    for search_dir in &dirs {
        let dir_path = std::path::Path::new(search_dir);
        if !dir_path.exists() {
            continue;
        }

        // 1. Exact match: {class}.desktop or {class_lower}.desktop
        for name in [&class_lower, class] {
            let path = dir_path.join(format!("{}.desktop", name));
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Some(df) = parse_desktop_file(&content) {
                    return Some(df);
                }
            }
        }

        // 2. Stripped prefix match (org.foo.Bar → Bar.desktop)
        if !stripped.is_empty() {
            let path = dir_path.join(format!("{}.desktop", stripped));
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Some(df) = parse_desktop_file(&content) {
                    return Some(df);
                }
            }
        }

        // 3. Scan all desktop files for matching Exec base name
        if let Ok(entries) = std::fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let fname_str = fname.to_string_lossy();
                if !fname_str.ends_with(".desktop") {
                    continue;
                }

                let base = fname_str.strip_suffix(".desktop").unwrap_or(&fname_str);
                if base == class_lower || base == class || base == stripped {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        if let Some(df) = parse_desktop_file(&content) {
                            return Some(df);
                        }
                    }
                }
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn parse_desktop_file(content: &str) -> Option<DesktopFile> {
    let mut name: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut categories: Vec<String> = Vec::new();
    let mut in_desktop_entry = false;

    for line in content.lines() {
        let line = line.trim();

        if line.starts_with('[') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }

        if !in_desktop_entry {
            continue;
        }

        if let Some(val) = line.strip_prefix("Name=") {
            if name.is_none() {
                name = Some(val.to_string());
            }
        } else if let Some(val) = line.strip_prefix("Icon=") {
            icon = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("Categories=") {
            categories = val
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    name.map(|n| DesktopFile {
        name: n,
        icon: icon.unwrap_or_default(),
        categories,
    })
}

#[cfg(target_os = "linux")]
fn resolve_icon_file(icon_name: &str) -> Option<String> {
    if icon_name.is_empty() {
        return None;
    }

    let icon_path = std::path::Path::new(icon_name);
    if icon_path.is_absolute() && icon_path.exists() {
        return read_icon_to_base64(icon_path);
    }

    let icon_dirs = get_icon_dirs();
    let sizes = ["256x256", "128x128", "64x64", "48x48", "32x32"];
    let subdirs = ["apps", "categories"];

    for icon_dir in &icon_dirs {
        // PNG search at fixed sizes
        for size in &sizes {
            for subdir in &subdirs {
                let path = format!("{}/{}/{}/{}.png", icon_dir, size, subdir, icon_name);
                let p = std::path::Path::new(&path);
                if p.exists() {
                    if let Some(data) = read_icon_to_base64(p) {
                        return Some(data);
                    }
                }
            }
        }

        // SVG (scalable)
        for subdir in &subdirs {
            let path = format!("{}/scalable/{}/{}.svg", icon_dir, subdir, icon_name);
            let p = std::path::Path::new(&path);
            if p.exists() {
                if let Some(data) = read_icon_to_base64(p) {
                    return Some(data);
                }
            }
        }
    }

    // Fallback: /usr/share/pixmaps
    let pixmap = format!("/usr/share/pixmaps/{}.png", icon_name);
    let p = std::path::Path::new(&pixmap);
    if p.exists() {
        return read_icon_to_base64(p);
    }

    let pixmap_svg = format!("/usr/share/pixmaps/{}.svg", icon_name);
    let p = std::path::Path::new(&pixmap_svg);
    if p.exists() {
        return read_icon_to_base64(p);
    }

    None
}

#[cfg(target_os = "linux")]
fn get_icon_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        // Try to detect current GTK icon theme
        let theme_settings = &[
            format!("{}/.config/gtk-3.0/settings.ini", home),
            format!("{}/.config/gtk-4.0/settings.ini", home),
        ];

        let mut theme = "hicolor".to_string();
        for settings_path in theme_settings {
            if let Ok(content) = std::fs::read_to_string(settings_path) {
                for line in content.lines() {
                    let line = line.trim();
                    if let Some(t) = line.strip_prefix("gtk-icon-theme-name=") {
                        let t = t.trim();
                        if !t.is_empty() {
                            theme = t.to_string();
                        }
                    }
                }
            }
        }

        // User-local icons for the detected theme and hicolor
        dirs.push(format!("{}/.local/share/icons/{}", home, theme));
        dirs.push(format!("{}/.local/share/icons/hicolor", home));
        dirs.push(format!("{}/.icons/{}", home, theme));
    }

    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for data_dir in data_dirs.split(':') {
        dirs.push(format!("{}/icons/hicolor", data_dir));
        dirs.push(format!("{}/icons/Adwaita", data_dir));
        dirs.push(format!("{}/icons/gnome", data_dir));
        dirs.push(format!("{}/icons/breeze", data_dir));
    }

    dirs
}

#[cfg(target_os = "linux")]
fn read_icon_to_base64(path: &std::path::Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let ext = path.extension()?.to_str()?;
    let mime = match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "xpm" => "image/x-xpixmap",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
    Some(format!("data:{};base64,{}", mime, encoded))
}
