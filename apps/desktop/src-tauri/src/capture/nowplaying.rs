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

    let output = Command::new("playerctl")
        .args(["metadata", "--format", &format])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }

    let mut parts = line.split(SEP);
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

#[cfg(not(target_os = "linux"))]
pub fn get_now_playing() -> Option<NowPlaying> {
    None
}
