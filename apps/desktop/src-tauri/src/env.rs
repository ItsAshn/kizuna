use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct EnvDiagnostic {
    pub session_type: String,
    pub compositor: String,
    pub pipewire_ok: bool,
    pub pipewire_pulse_ok: bool,
    pub portal_ok: bool,
    pub portal_backend: String,
    pub issues: Vec<EnvIssue>,
}

#[derive(Debug, Serialize, Clone)]
pub struct EnvIssue {
    pub severity: String,
    pub component: String,
    pub message: String,
    pub fix_command: Option<String>,
}

fn runtime_dir() -> String {
    std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/run/user/1000".into())
}

fn detect_portal_backend(compositor: &str) -> String {
    let portal_dir = "/usr/share/xdg-desktop-portal/portals";
    if let Ok(entries) = std::fs::read_dir(portal_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".portal") {
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    if content.contains(&format!("UseIn={}", compositor))
                        || content.contains(&format!("UseIn={};", compositor))
                    {
                        return name.replace(".portal", "");
                    }
                }
            }
        }
    }
    "unknown".into()
}

#[tauri::command]
pub async fn check_environment() -> Result<EnvDiagnostic, String> {
    let session_type =
        std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into());
    let is_wayland =
        session_type == "wayland" || std::env::var("WAYLAND_DISPLAY").is_ok();

    let compositor = if is_wayland {
        std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "unknown".into())
    } else {
        "X11".into()
    };

    let rd = runtime_dir();
    let pipewire_ok = std::path::Path::new(&format!("{}/pipewire-0", rd)).exists();
    let pipewire_pulse_ok =
        std::path::Path::new(&format!("{}/pulse/native", rd)).exists();

    let (portal_ok, portal_backend) = if is_wayland {
        let backend = detect_portal_backend(&compositor);
        let ok = ashpd::desktop::screencast::Screencast::new().await.is_ok();
        (ok, backend)
    } else {
        (false, "none".into())
    };

    let mut issues = Vec::new();

    if is_wayland {
        if !pipewire_ok {
            issues.push(EnvIssue {
                severity: "error".into(),
                component: "pipewire".into(),
                message: "PipeWire is not running. Audio and screen sharing require PipeWire on Wayland.".into(),
                fix_command: Some("systemctl --user enable --now pipewire pipewire-pulse".into()),
            });
        }
        if !pipewire_pulse_ok {
            issues.push(EnvIssue {
                severity: "error".into(),
                component: "pipewire-pulse".into(),
                message: "PipeWire-PulseAudio bridge is not running. Microphone access requires it.".into(),
                fix_command: Some(into_distro_command("pipewire-pulse")),
            });
        }
        if !portal_ok {
            let distro_cmd = into_distro_command("xdg-desktop-portal");
            issues.push(EnvIssue {
                severity: "error".into(),
                component: "xdg-desktop-portal".into(),
                message: "XDG Desktop Portal is not available. Screen sharing requires it on Wayland.".into(),
                fix_command: Some(distro_cmd),
            });
        }
        if portal_backend == "unknown" && portal_ok {
            let backend_pkg = match compositor.as_str() {
                "Hyprland" => "xdg-desktop-portal-hyprland",
                "sway" | "Sway" => "xdg-desktop-portal-wlr",
                "GNOME" | "gnome" => "xdg-desktop-portal-gnome",
                "KDE" | "plasma" => "xdg-desktop-portal-kde",
                _ => "xdg-desktop-portal-wlr",
            };
            issues.push(EnvIssue {
                severity: "warning".into(),
                component: "portal-backend".into(),
                message: format!(
                    "No portal backend detected for {}. Screen sharing requires a portal backend ({}).",
                    compositor, backend_pkg
                ),
                fix_command: Some(into_distro_command(backend_pkg)),
            });
        }
    }

    Ok(EnvDiagnostic {
        session_type,
        compositor,
        pipewire_ok,
        pipewire_pulse_ok,
        portal_ok,
        portal_backend,
        issues,
    })
}

fn into_distro_command(pkg: &str) -> String {
    let (install_cmd, enable_cmd) = detect_distro_commands(pkg);
    format!("{} && {}", install_cmd, enable_cmd)
}

fn detect_distro_commands(pkg: &str) -> (String, String) {
    if std::path::Path::new("/etc/arch-release").exists() {
        let svc = if pkg.contains("pipewire") { pkg } else { "pipewire-pulse" };
        (
            format!("sudo pacman -S --needed {}", pkg),
            format!(
                "systemctl --user enable --now {} {}.socket",
                svc, svc
            ),
        )
    } else if std::path::Path::new("/etc/fedora-release").exists() {
        (format!("sudo dnf install -y {}", pkg), "systemctl --user enable --now pipewire-pulse pipewire-pulse.socket".into())
    } else {
        (format!("sudo apt install -y {}", pkg), "systemctl --user enable --now pipewire-pulse pipewire-pulse.socket".into())
    }
}
