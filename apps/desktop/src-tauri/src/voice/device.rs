use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[cfg(target_os = "linux")]
use std::process::Command;

#[allow(unused)]
macro_rules! alog {
    ($($arg:tt)*) => {
        eprintln!("[AudioDevice] {}", format!($($arg)*))
    };
}

#[derive(Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub device_id: String,
    pub is_default: bool,
    pub max_channels: u16,
    pub default_sample_rate: u32,
}

#[derive(Clone, Serialize)]
pub struct AudioDataPayload {
    pub samples_f32: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

pub fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let host_id = host.id();
    alog!("list_input_devices: host={:?}", host_id);

    let mut result: Vec<AudioDeviceInfo> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    #[cfg(target_os = "linux")]
    if let Ok(pw_devices) = try_list_pipewire_devices(true) {
        for d in pw_devices {
            if seen_ids.insert(d.device_id.clone()) {
                alog!("list_input_devices: PW device: name='{}' id={}", d.name, d.device_id);
                result.push(d);
            }
        }
    }

    let default_input_device_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();
    alog!("list_input_devices: default_device_id={}", default_input_device_id);

    let cpal_devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?;

    for device in cpal_devices {
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Unknown device".into());

        let device_id = match device.id() {
            Ok(id) => id.to_string(),
            Err(_) => {
                alog!("  SKIP device with unreadable id: name='{}'", name);
                continue;
            }
        };
        let is_default = device_id == default_input_device_id;

        let trim_name = name.trim().to_string();
        if !seen_ids.insert(device_id.clone()) {
            alog!("  SKIP duplicate id: name='{}' id={}", trim_name, device_id);
            continue;
        }

        if is_virtual_device_name(&trim_name, false) {
            alog!("  SKIP virtual: name='{}' id={}", trim_name, device_id);
            continue;
        }

        let default_config = device.default_input_config().ok();
        let Some(ref config) = default_config else {
            alog!("  SKIP unavailable: name='{}' id={}", trim_name, device_id);
            continue;
        };
        if config.channels() == 0 {
            alog!("  SKIP zero-channel: name='{}' id={}", trim_name, device_id);
            continue;
        }
        let max_channels = config.channels();
        let default_sample_rate = config.sample_rate();

        alog!(
            "  device: name='{}' id={} default={} maxCh={} defSr={}Hz",
            trim_name, device_id, is_default, max_channels, default_sample_rate
        );

        result.push(AudioDeviceInfo {
            name: trim_name,
            device_id,
            is_default,
            max_channels,
            default_sample_rate,
        });
    }

    alog!("list_input_devices: found {} device(s)", result.len());
    Ok(result)
}

pub fn list_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    #[cfg(target_os = "linux")]
    if let Ok(devices) = try_list_pipewire_devices(false) {
        if !devices.is_empty() {
            return Ok(devices);
        }
    }

    let host = cpal::default_host();
    let default_device_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();

    let mut devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {e}"))?;

    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result = Vec::new();
    while let Some(device) = devices.next() {
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Unknown device".into());

        let device_id = match device.id() {
            Ok(id) => id.to_string(),
            Err(_) => continue,
        };
        let is_default = device_id == default_device_id;

        let trim_name = name.trim().to_string();
        if !seen_ids.insert(device_id.clone()) {
            continue;
        }

        if is_virtual_device_name(&trim_name, true) {
            continue;
        }

        let default_config = device.default_output_config().ok();
        let Some(ref config) = default_config else {
            continue;
        };
        if config.channels() == 0 {
            continue;
        }
        let max_channels = config.channels();
        let default_sample_rate = config.sample_rate();

        result.push(AudioDeviceInfo {
            name: trim_name,
            device_id,
            is_default,
            max_channels,
            default_sample_rate,
        });
    }

    Ok(result)
}

fn is_virtual_device_name(name: &str, is_output: bool) -> bool {
    let lower = name.to_lowercase();
    if lower.contains("discard")
        || lower.contains("rate converter")
        || lower.contains("plugin for")
        || lower.contains("jack audio")
        || lower.contains("open sound")
        || lower.contains("speex")
        || lower.contains("upmix")
        || lower.contains("downmix")
    {
        return true;
    }
    if is_output && lower.contains("input") {
        return true;
    }
    if !is_output && lower.contains("output") && !lower.contains("wave") && !lower.contains("usb") {
        return true;
    }
    false
}

#[cfg(target_os = "linux")]
fn try_list_pipewire_devices(is_input: bool) -> Result<Vec<AudioDeviceInfo>, String> {
    let output = if is_input {
        Command::new("pactl")
            .args(["list", "sources"])
            .output()
    } else {
        Command::new("pactl")
            .args(["list", "sinks"])
            .output()
    }
    .map_err(|e| format!("Failed to run pactl: {e}"))?;

    if !output.status.success() {
        return Err("pactl command failed".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_desc: Option<String> = None;
    let mut current_channels: u16 = 2;
    let mut current_sample_rate: u32 = 48000;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let Some(name) = current_name.take() {
                if !name.contains(".monitor") {
                    let display_name = current_desc.take().unwrap_or_else(|| name.clone());
                    devices.push(AudioDeviceInfo {
                        name: display_name,
                        device_id: name,
                        is_default: false,
                        max_channels: current_channels,
                        default_sample_rate: current_sample_rate,
                    });
                }
            }
            current_desc = None;
            current_channels = 2;
            current_sample_rate = 48000;
            continue;
        }

        if let Some(name_val) = line.strip_prefix("Name: ") {
            current_name = Some(name_val.trim().to_string());
        } else if let Some(desc_val) = line.strip_prefix("Description: ") {
            current_desc = Some(desc_val.trim().to_string());
        } else if let Some(ch_str) = line.strip_prefix("Sample Specification: ") {
            let spec = ch_str.trim();
            if let Some(ch_pos) = spec.find("ch") {
                let ch_part = spec[..ch_pos].trim();
                if let Some(last_space) = ch_part.rfind(' ') {
                    if let Ok(ch) = ch_part[last_space + 1..].parse::<u16>() {
                        current_channels = ch;
                    }
                } else if let Ok(ch) = ch_part.parse::<u16>() {
                    current_channels = ch;
                }
            }
            if let Some(hz_pos) = spec.find("Hz") {
                let rate_str = &spec[..hz_pos];
                if let Some(space_pos) = rate_str.rfind(' ') {
                    if let Ok(rate) = rate_str[space_pos + 1..].trim().parse::<u32>() {
                        current_sample_rate = rate;
                    }
                }
            }
        }
    }

    if let Some(name) = current_name.take() {
        if !name.contains(".monitor") {
            let display_name = current_desc.unwrap_or_else(|| name.clone());
            devices.push(AudioDeviceInfo {
                name: display_name,
                device_id: name,
                is_default: false,
                max_channels: current_channels,
                default_sample_rate: current_sample_rate,
            });
        }
    }

    if !devices.is_empty() {
        devices[0].is_default = true;
    }

    Ok(devices)
}
