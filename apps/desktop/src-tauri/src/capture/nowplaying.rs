use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
}

/// Read the currently playing media via MPRIS (`playerctl`).
///
/// Returns `None` when `playerctl` is missing, errors, reports no active
/// player, or has no track title — callers degrade gracefully.
#[cfg(target_os = "linux")]
pub fn get_now_playing() -> Option<NowPlaying> {
    use std::process::Command;

    // U+001F (unit separator) is extremely unlikely to appear in metadata,
    // so it makes a robust field delimiter.
    const SEP: char = '\u{1f}';
    let format = format!(
        "{{{{status}}}}{sep}{{{{title}}}}{sep}{{{{artist}}}}{sep}{{{{album}}}}",
        sep = SEP
    );

    // playerctl needs access to the D-Bus session bus. On some Wayland
    // compositors (Hyprland, Sway) the Tauri process may not inherit
    // DBUS_SESSION_BUS_ADDRESS. Try to discover and inject it.
    let dbus_addr = ensure_dbus_session_address();

    let mut cmd = Command::new("playerctl");
    cmd.args(["metadata", "--format", &format]);

    if let Some(ref addr) = dbus_addr {
        cmd.env("DBUS_SESSION_BUS_ADDRESS", addr);
    }

    let output = cmd.output().ok()?;

    if !output.status.success() {
        // playerctl might have failed because no player was selected.
        // Try with --all-players to pick up any active player (e.g. when
        // the D-Bus session is reachable but playerctl defaults to the
        // wrong player).
        let mut cmd2 = Command::new("playerctl");
        cmd2.args(["--all-players", "metadata", "--format", &format]);
        if let Some(ref addr) = dbus_addr {
            cmd2.env("DBUS_SESSION_BUS_ADDRESS", addr);
        }
        let output2 = cmd2.output().ok()?;
        if !output2.status.success() {
            return None;
        }
        // Use the first non-empty line (last player wins with --all-players)
        let raw = String::from_utf8_lossy(&output2.stdout);
        let line = raw.lines().find(|l| !l.trim().is_empty())?;
        return parse_now_playing_line(line, SEP);
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }

    parse_now_playing_line(line, SEP)
}

#[cfg(target_os = "linux")]
fn parse_now_playing_line(line: &str, sep: char) -> Option<NowPlaying> {
    let mut parts = line.split(sep);
    let status = parts.next().unwrap_or_default().trim().to_string();
    let title = parts.next().unwrap_or_default().trim().to_string();
    let artist = parts.next().unwrap_or_default().trim().to_string();
    let album = parts.next().unwrap_or_default().trim().to_string();

    if status.is_empty() || title.is_empty() {
        return None;
    }

    Some(NowPlaying {
        title,
        artist,
        album,
        status,
    })
}

/// Discover the D-Bus session bus address if it is not already set in the
/// environment. Returns `None` when the address is already set and no
/// override is needed, or `Some(addr)` with the discovered address.
#[cfg(target_os = "linux")]
fn ensure_dbus_session_address() -> Option<String> {
    if std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok() {
        return None;
    }

    // Common socket-based session bus paths (systemd-logind / elogind)
    let uid = unsafe { libc::getuid() };
    let socket_path = format!("/run/user/{}/bus", uid);
    if std::path::Path::new(&socket_path).exists() {
        let addr = format!("unix:path={}", socket_path);
        eprintln!(
            "[nowplaying] discovered D-Bus session at {}",
            socket_path
        );
        return Some(addr);
    }

    // Fallback: read from the legacy XDG_RUNTIME_DIR / dbus-session file
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        let bus_path = format!("{}/bus", runtime);
        if std::path::Path::new(&bus_path).exists() {
            let addr = format!("unix:path={}", bus_path);
            eprintln!(
                "[nowplaying] discovered D-Bus session via XDG_RUNTIME_DIR: {}",
                bus_path
            );
            return Some(addr);
        }
    }

    // Try dbus-launch to query the address
    if let Ok(output) = std::process::Command::new("dbus-launch")
        .arg("--autolaunch")
        .arg("--sh-syntax")
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.starts_with("DBUS_SESSION_BUS_ADDRESS=") {
                return Some(
                    line.trim_start_matches("DBUS_SESSION_BUS_ADDRESS=")
                        .trim_matches('\'')
                        .trim_matches('"')
                        .trim_end_matches(';')
                        .to_string(),
                );
            }
        }
    }

    None
}

#[cfg(not(target_os = "linux"))]
pub fn get_now_playing() -> Option<NowPlaying> {
    None
}
