use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::Emitter;

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
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
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
    let host = cpal::default_host();
    let default_device_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();

    let mut devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?;

    let mut result = Vec::new();
    while let Some(device) = devices.next() {
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Unknown device".into());
        let device_id = device
            .id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| name.clone());
        let is_default = device_id == default_device_id;

        let default_config = device.default_input_config().ok();
        let max_channels = default_config.as_ref().map(|c| c.channels()).unwrap_or(1);
        let default_sample_rate =
            default_config.map(|c| c.sample_rate()).unwrap_or(48000);

        result.push(AudioDeviceInfo {
            name,
            device_id,
            is_default,
            max_channels,
            default_sample_rate,
        });
    }

    Ok(result)
}

pub fn list_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_device_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();

    let mut devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {e}"))?;

    let mut result = Vec::new();
    while let Some(device) = devices.next() {
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Unknown device".into());

        let device_id = device
            .id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| name.clone());
        let is_default = device_id == default_device_id;

        let default_config = device.default_output_config().ok();
        let max_channels = default_config.as_ref().map(|c| c.channels()).unwrap_or(2);
        let default_sample_rate =
            default_config.map(|c| c.sample_rate()).unwrap_or(48000);

        result.push(AudioDeviceInfo {
            name,
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
    let host = cpal::default_host();

    let device = if let Some(ref id_str) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {e}"))?
            .find(|d| {
                d.id()
                    .map(|i| i.to_string() == *id_str)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Input device '{}' not found", id_str))?
    } else {
        host.default_input_device()
            .ok_or("No input device found. Connect a microphone.")?
    };

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown".into());
    eprintln!(
        "[AudioCapture] Using device: {} (target: {}Hz, {}ch)",
        device_name, target_sample_rate, channels
    );

    let config = cpal::StreamConfig {
        channels,
        sample_rate: target_sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();
    let sample_format = device
        .default_input_config()
        .map(|c| c.sample_format())
        .unwrap_or(cpal::SampleFormat::F32);

    let handle: thread::JoinHandle<()> = thread::spawn(move || {
        let err_fn = |err| eprintln!("[AudioCapture] stream error: {}", err);

        let stream_result = {
            let cb_cancel = cancel_clone.clone();
            let cb_app = app.clone();

            match sample_format {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config,
                    {
                        let cc = cb_cancel.clone();
                        let a = cb_app.clone();
                        move |data: &[f32], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
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
                        move |data: &[i16], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
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
                        move |data: &[u16], _info| {
                            if cc.load(Ordering::Relaxed) {
                                return;
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
                    eprintln!(
                        "[AudioCapture] Unsupported sample format: {:?}",
                        sample_format
                    );
                    return;
                }
            }
        };

        let stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[AudioCapture] Failed to build stream: {}", e);
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[AudioCapture] Failed to start stream: {}", e);
            return;
        }

        while !cancel_clone.load(Ordering::Relaxed) {
            thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(stream);
    });

    Ok(AudioCaptureSession {
        cancel,
        handle: Some(handle),
        stream_sample_rate: target_sample_rate,
        stream_channels: channels,
    })
}
