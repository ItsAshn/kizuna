use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::Emitter;

#[cfg(target_os = "linux")]
use std::process::Command;

#[allow(unused)]
macro_rules! alog {
    ($($arg:tt)*) => {
        eprintln!("[AudioCapture] {}", format!($($arg)*))
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

pub struct AudioCaptureSession {
    cancel: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    stream_sample_rate: u32,
    stream_channels: u16,
}

impl AudioCaptureSession {
    pub fn stop(&mut self) {
        alog!("stop() called");
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            alog!("joining capture thread...");
            let _ = handle.join();
            alog!("capture thread joined");
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.stream_sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.stream_channels
    }
}

impl Drop for AudioCaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    #[cfg(target_os = "linux")]
    if let Ok(devices) = try_list_pipewire_devices(true) {
        if !devices.is_empty() {
            alog!("list_input_devices: using PipeWire, found {} device(s)", devices.len());
            return Ok(devices);
        }
    }

    let host = cpal::default_host();
    let host_id = host.id();
    alog!("list_input_devices: host={:?}", host_id);
    let default_device_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();
    alog!("list_input_devices: default_device_id={}", default_device_id);

    let mut devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?;

    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result = Vec::new();
    while let Some(device) = devices.next() {
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
        let is_default = device_id == default_device_id;

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
            Err(_) => {
                continue;
            }
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

pub fn start_capture(
    app: tauri::AppHandle,
    device_id: Option<String>,
    target_sample_rate: u32,
    channels: u16,
) -> Result<AudioCaptureSession, String> {
    alog!("start_capture: device_id={:?} targetSr={}Hz channels={}", device_id, target_sample_rate, channels);
    let host = cpal::default_host();
    alog!("start_capture: cpal host={:?}", host.id());

    let device = if let Some(ref id_str) = device_id {
        alog!("start_capture: searching for device '{}'", id_str);
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
            .find(|d| {
                d.id()
                    .map(|i| i.to_string() == *id_str)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Input device '{}' not found", id_str))?
    } else {
        alog!("start_capture: using default input device");
        host.default_input_device()
            .ok_or("No input device found. Connect a microphone.")?
    };

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown".into());
    let default_cfg = device.default_input_config().map_err(|e| format!("Cannot get default input config: {e}"))?;
    let sample_format = default_cfg.sample_format();
    let default_sr = default_cfg.sample_rate();
    let default_ch = default_cfg.channels();
    alog!(
        "start_capture: device='{}' defaultFormat={:?} defaultSr={}Hz defaultCh={}",
        device_name, sample_format, default_sr, default_ch
    );

    let config = cpal::StreamConfig {
        channels,
        sample_rate: target_sample_rate,
        buffer_size: cpal::BufferSize::Fixed(960),
    };
    alog!(
        "start_capture: stream config: {}Hz {}ch buffer=Default targetFormat={:?}",
        target_sample_rate, channels, sample_format
    );

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();
    let callback_count = Arc::new(AtomicU64::new(0));
    let callback_count_clone = callback_count.clone();

    let handle: thread::JoinHandle<()> = thread::spawn(move || {
        let start = Instant::now();
        alog!("capture thread: started, trying to build stream...");
        let err_fn = |err| alog!("stream error callback: {}", err);

        let stream_result = {
            let cb_cancel = cancel_clone.clone();
            let cb_app = app.clone();
            let cb_count = callback_count_clone.clone();

            match sample_format {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config,
                    {
                        let cc = cb_cancel.clone();
                        let a = cb_app.clone();
                        let ct = cb_count.clone();
                        move |data: &[f32], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
                            }
                            let n = ct.fetch_add(1, Ordering::Relaxed);
                            if n == 0 {
                                alog!("capture thread: FIRST audio callback | bufferLen={}", data.len());
                            } else if n % 500 == 0 {
                                let elapsed = start.elapsed().as_secs_f64();
                                alog!("capture thread: callback #{}, elapsed={:.1}s rate={:.1}/s bufferLen={}", n, elapsed, n as f64 / elapsed, data.len());
                            }
                            let payload = AudioDataPayload {
                                samples_f32: data.to_vec(),
                                sample_rate: target_sample_rate,
                                channels,
                            };
                            let _ = a.emit("audio:data", payload);
                        }
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &config,
                    {
                        let cc = cb_cancel.clone();
                        let a = cb_app.clone();
                        let ct = cb_count.clone();
                        move |data: &[i16], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
                            }
                            let n = ct.fetch_add(1, Ordering::Relaxed);
                            if n == 0 {
                                alog!("capture thread: FIRST audio callback (I16) | bufferLen={}", data.len());
                            } else if n % 500 == 0 {
                                let elapsed = start.elapsed().as_secs_f64();
                                alog!("capture thread: callback #{}, elapsed={:.1}s rate={:.1}/s bufferLen={}", n, elapsed, n as f64 / elapsed, data.len());
                            }
                            let payload = AudioDataPayload {
                                samples_f32: data
                                    .iter()
                                    .map(|&s| s as f32 / 32768.0)
                                    .collect(),
                                sample_rate: target_sample_rate,
                                channels,
                            };
                            let _ = a.emit("audio:data", payload);
                        }
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U16 => device.build_input_stream(
                    &config,
                    {
                        let cc = cb_cancel.clone();
                        let a = cb_app.clone();
                        let ct = cb_count.clone();
                        move |data: &[u16], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
                            }
                            let n = ct.fetch_add(1, Ordering::Relaxed);
                            if n == 0 {
                                alog!("capture thread: FIRST audio callback (U16) | bufferLen={}", data.len());
                            } else if n % 500 == 0 {
                                let elapsed = start.elapsed().as_secs_f64();
                                alog!("capture thread: callback #{}, elapsed={:.1}s rate={:.1}/s bufferLen={}", n, elapsed, n as f64 / elapsed, data.len());
                            }
                            let payload = AudioDataPayload {
                                samples_f32: data
                                    .iter()
                                    .map(|&s| (s as f32 - 32768.0) / 32768.0)
                                    .collect(),
                                sample_rate: target_sample_rate,
                                channels,
                            };
                            let _ = a.emit("audio:data", payload);
                        }
                    },
                    err_fn,
                    None,
                ),
                _ => {
                    alog!("capture thread: UNSUPPORTED sample format {:?}", sample_format);
                    return;
                }
            }
        };

        let stream = match stream_result {
            Ok(s) => {
                alog!("capture thread: stream built OK");
                s
            }
            Err(e) => {
                alog!("capture thread: FAILED to build stream: {}", e);
                return;
            }
        };

        match stream.play() {
            Ok(()) => alog!("capture thread: stream.play() OK - audio capture running"),
            Err(e) => {
                alog!("capture thread: FAILED to start stream playback: {}", e);
                return;
            }
        };

        while !cancel_clone.load(Ordering::Relaxed) {
            thread::sleep(std::time::Duration::from_millis(100));
        }

        let elapsed = start.elapsed();
        let total = callback_count.load(Ordering::Relaxed);
        alog!(
            "capture thread: stopped after {:.1}s, {} callbacks total",
            elapsed.as_secs_f64(),
            total
        );
        drop(stream);
        alog!("capture thread: stream dropped, thread exiting");
    });

    alog!("start_capture: returning AudioCaptureSession OK");
    Ok(AudioCaptureSession {
        cancel,
        handle: Some(handle),
        stream_sample_rate: target_sample_rate,
        stream_channels: channels,
    })
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
            .args(["list", "sources", "short"])
            .output()
    } else {
        Command::new("pactl")
            .args(["list", "sinks", "short"])
            .output()
    }
    .map_err(|e| format!("Failed to run pactl: {e}"))?;

    if !output.status.success() {
        return Err("pactl command failed".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // pactl format: <id>\t<name>\t<module>\t<sample_format> <channels>ch <rate>Hz
        // Example: 56  alsa_input.usb-Elgato...mono-fallback  PipeWire  s24le 1ch 48000Hz
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }

        // Skip monitor sources (output monitors)
        let name = parts[1].trim();
        if is_input && name.contains(".monitor") {
            continue;
        }
        if name.contains("monitor") || name.is_empty() {
            continue;
        }

        // Extract channel count and sample rate from the last column
        let mut channels: u16 = 2;
        let mut sample_rate: u32 = 48000;

        if let Some(last) = parts.last() {
            let info = last.trim();
            if let Some(ch_pos) = info.find("ch") {
                if let Ok(ch) = info[..ch_pos].trim().parse::<u16>() {
                    channels = ch;
                }
            }
            if let Some(hz_pos) = info.find("Hz") {
                let rate_str = &info[..hz_pos];
                if let Some(space_pos) = rate_str.rfind(' ') {
                    if let Ok(rate) = rate_str[space_pos + 1..].trim().parse::<u32>() {
                        sample_rate = rate;
                    }
                }
            }
        }

        devices.push(AudioDeviceInfo {
            name: name.to_string(),
            device_id: name.to_string(),
            is_default: false,
            max_channels: channels,
            default_sample_rate: sample_rate,
        });

    }

    if !devices.is_empty() {
        // Mark the first device as default (pactl lists default first)
        devices[0].is_default = true;
    }

    Ok(devices)
}
