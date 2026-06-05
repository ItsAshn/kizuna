use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, EncodableLayout, ExtendedColorType, ImageEncoder};
use pipewire as pw;
use tauri::Emitter;

use super::{CaptureSession, MonitorInfo, ScreenFramePayload};

const MAX_DIMENSION: u32 = 1920;
const JPEG_QUALITY: u8 = 75;
const RECONNECT_DELAY_MS: u64 = 1000;
const MAX_RECONNECT_ATTEMPTS: u32 = 3;

pub async fn list_sources() -> Result<Vec<MonitorInfo>, String> {
    Ok(vec![MonitorInfo {
        index: 0,
        name: "Share via system dialog".into(),
        width: 0,
        height: 0,
    }])
}

pub async fn start_capture(
    app: tauri::AppHandle,
    _source_index: usize,
    _fps: u32,
) -> Result<CaptureSession, String> {
    use ashpd::desktop::screencast::{
        CursorMode, Screencast, SelectSourcesOptions, SourceType,
    };

    let screencast = Screencast::new()
        .await
        .map_err(|e| format!("Portal unavailable: {e}"))?;

    let session = screencast
        .create_session(Default::default())
        .await
        .map_err(|e| format!("Failed to create screencast session: {e}"))?;

    screencast
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Embedded)
                .set_sources(SourceType::Monitor | SourceType::Window)
                .set_multiple(false),
        )
        .await
        .map_err(|e| format!("Source selection failed or cancelled: {e}"))?;

    let start_request = screencast
        .start(&session, None, Default::default())
        .await
        .map_err(|e| format!("Failed to start screencast: {e}"))?;

    let streams = start_request
        .response()
        .map_err(|e| format!("No screencast response: {e}"))?;

    let stream_list = streams.streams();
    if stream_list.is_empty() {
        return Err("No streams returned from portal".into());
    }

    let node_id = stream_list[0].pipe_wire_node_id();

    let fd = screencast
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|e| format!("Failed to open PipeWire remote: {e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();

    let handle = thread::spawn(move || {
        run_pipewire_capture(app, fd, node_id, cancel_clone);
    });

    Ok(CaptureSession {
        cancel,
        handle: Some(handle),
    })
}

fn run_pipewire_capture(
    app: tauri::AppHandle,
    fd: OwnedFd,
    node_id: u32,
    cancel: Arc<AtomicBool>,
) {
    let raw_fd = fd.as_raw_fd();
    let mut attempt = 0u32;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        if attempt > 0 {
            if attempt > MAX_RECONNECT_ATTEMPTS {
                eprintln!(
                    "[ScreenCapture] max reconnect attempts ({}) reached, stopping",
                    MAX_RECONNECT_ATTEMPTS
                );
                break;
            }
            eprintln!(
                "[ScreenCapture] reconnecting (attempt {}/{})...",
                attempt, MAX_RECONNECT_ATTEMPTS
            );
            thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS * attempt as u64));
        }

        let dup_fd = match dup_fd_safe(raw_fd) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[ScreenCapture] Failed to dup fd: {e}");
                break;
            }
        };

        match run_single_pipewire_loop(&app, dup_fd, node_id, &cancel) {
            Ok(false) => {
                attempt += 1;
                continue;
            }
            Ok(true) => {
                break;
            }
            Err(e) => {
                eprintln!("[ScreenCapture] PipeWire error: {}", e);
                attempt += 1;
                continue;
            }
        }
    }

    drop(fd);
}

fn dup_fd_safe(fd: i32) -> Result<OwnedFd, String> {
    use std::os::unix::io::FromRawFd;
    let new_fd = unsafe { libc::dup(fd) };
    if new_fd < 0 {
        Err(format!(
            "dup({}) failed: {}",
            fd,
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
    }
}

fn run_single_pipewire_loop(
    app: &tauri::AppHandle,
    fd: OwnedFd,
    node_id: u32,
    cancel: &Arc<AtomicBool>,
) -> Result<bool, String> {
    pw::init();

    let mainloop = pw::main_loop::MainLoopBox::new(None)
        .map_err(|e| format!("Failed to create PipeWire mainloop: {e}"))?;

    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| format!("Failed to create PipeWire context: {e}"))?;

    let core = context
        .connect_fd(fd, None)
        .map_err(|e| format!("Failed to connect PipeWire core: {e}"))?;

    use pw::properties::properties;

    let props = pw::properties::PropertiesBox::try_from(properties! {
        *pw::keys::MEDIA_TYPE => "Video",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Screen",
    })
    .map_err(|e| format!("Failed to build PipeWire properties: {e}"))?;

    let stream = pw::stream::StreamBox::new(&core, "kizuna-screen-capture", props)
        .map_err(|e| format!("Failed to create PipeWire stream: {e}"))?;

    let app_ref = app.clone();
    let cancel_thread = cancel.clone();

    let _listener = stream
        .add_local_listener_with_user_data((cancel_thread, app_ref))
        .process(move |_stream, (cancel, app)| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let Some(mut buffer) = _stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if let Some(data) = datas.first_mut() {
                let data_size = data.chunk().size() as usize;
                let stride = data.chunk().stride() as u32;
                if let Some(raw) = data.data() {
                    if data_size > 0 && raw.len() >= data_size {
                        if let Ok(payload) = encode_frame(&raw[..data_size], stride) {
                            let _ = app.emit("screen:frame", payload);
                        }
                    }
                }
            }
        })
        .register();

    stream
        .set_active(true)
        .map_err(|e| format!("Failed to activate stream: {e}"))?;

    use pw::spa::utils::Direction;
    stream
        .connect(
            Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT,
            &mut [],
        )
        .map_err(|e| format!("Failed to connect stream: {e}"))?;

    mainloop.run();

    Ok(cancel.load(Ordering::Relaxed))
}

fn encode_frame(raw: &[u8], stride: u32) -> Result<ScreenFramePayload, String> {
    if raw.len() < 4 {
        return Err("Frame too small".into());
    }

    let height = (raw.len() / stride as usize) as u32;
    let width = if stride >= 4 { stride / 4 } else { stride };

    if width == 0 || height == 0 {
        return Err("Invalid frame dimensions".into());
    }

    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        let src_base = y as usize * stride as usize;
        let dst_base = y as usize * (width as usize * 4);
        for x in 0..width {
            let src = src_base + x as usize * 4;
            let dst = dst_base + x as usize * 4;
            if src + 3 < raw.len() && dst + 3 < rgba.len() {
                rgba[dst] = raw[src + 2];
                rgba[dst + 1] = raw[src + 1];
                rgba[dst + 2] = raw[src];
                rgba[dst + 3] = 255;
            }
        }
    }

    let mut img = DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, rgba)
            .ok_or("Failed to create image from raw data")?,
    );

    let (w, h) = (img.width(), img.height());
    if w > MAX_DIMENSION || h > MAX_DIMENSION {
        let ratio = MAX_DIMENSION as f64 / w.max(h) as f64;
        let new_w = (w as f64 * ratio) as u32;
        let new_h = (h as f64 * ratio) as u32;
        img = img.resize(new_w, new_h, FilterType::Lanczos3);
    }

    let rgb = img.to_rgb8();
    let final_w = rgb.width();
    let final_h = rgb.height();

    let mut jpeg_bytes = Vec::new();
    {
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, JPEG_QUALITY);
        encoder
            .write_image(rgb.as_bytes(), final_w, final_h, ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encode failed: {e}"))?;
    }

    use base64::{engine::general_purpose, Engine as _};
    let jpeg_base64 = general_purpose::STANDARD.encode(&jpeg_bytes);

    Ok(ScreenFramePayload {
        jpeg_base64,
        width: final_w,
        height: final_h,
    })
}
