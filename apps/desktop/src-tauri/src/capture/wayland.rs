use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, EncodableLayout, ExtendedColorType, ImageEncoder};
use pipewire as pw;
use pw::spa;
use tauri::Emitter;

use super::{CaptureSession, MonitorInfo, PixelFormat, ScreenFramePayload};

const MAX_DIMENSION: u32 = 1920;
const JPEG_QUALITY: u8 = 75;
const RECONNECT_DELAY_MS: u64 = 1000;
const MAX_RECONNECT_ATTEMPTS: u32 = 3;
const DEFAULT_FPS: u32 = 30;

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
    fps: u32,
) -> Result<CaptureSession, String> {
    use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};

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
    let fps = if fps > 0 { fps } else { DEFAULT_FPS };

    let handle = thread::spawn(move || {
        run_pipewire_capture(app, fd, node_id, fps, cancel_clone);
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
    fps: u32,
    cancel: Arc<AtomicBool>,
) {
    let raw_fd = fd.as_raw_fd();
    let mut attempt = 0u32;
    let mut last_error = String::from("the stream ended");

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        if attempt > 0 {
            if attempt > MAX_RECONNECT_ATTEMPTS {
                super::emit_capture_error(&app, format!("Screen capture stopped: {last_error}"));
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
                super::emit_capture_error(&app, format!("Screen capture stopped: {e}"));
                break;
            }
        };

        match run_single_pipewire_loop(&app, dup_fd, node_id, fps, &cancel) {
            Ok(false) => {
                attempt += 1;
                continue;
            }
            Ok(true) => {
                break;
            }
            Err(e) => {
                eprintln!("[ScreenCapture] PipeWire error: {}", e);
                last_error = e;
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

/// What the compositor agreed to send, from the stream's `Format` param.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Negotiated {
    pub format: PixelFormat,
    pub width: u32,
    pub height: u32,
}

/// The pixel layouts we accept, all 32-bit packed. The alpha byte (if any) is
/// ignored, so BGRA/RGBA are as good as their x variants.
pub(crate) fn pixel_format_from_spa(format: spa::param::video::VideoFormat) -> Option<PixelFormat> {
    use spa::param::video::VideoFormat as F;
    match format {
        F::BGRx | F::BGRA => Some(PixelFormat::Bgra),
        F::RGBx | F::RGBA => Some(PixelFormat::Rgba),
        _ => None,
    }
}

struct StreamState {
    cancel: Arc<AtomicBool>,
    app: tauri::AppHandle,
    negotiated: Option<Negotiated>,
    min_interval: Duration,
    last_frame: Option<Instant>,
}

/// The `EnumFormat` we offer: the packed 32-bit layouts we can feed to the
/// encoder without conversion, any size, and frame rates up to what was asked
/// for. Offering nothing (as before) left the format to the compositor, and
/// the frame was then read as BGRA of a width guessed from the stride.
fn format_params(fps: u32) -> Result<Vec<u8>, String> {
    use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
    use spa::param::video::VideoFormat;
    use spa::param::ParamType;
    use spa::utils::{Fraction, Rectangle, SpaTypes};

    let obj = spa::pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        spa::pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        spa::pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        spa::pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRx,
            VideoFormat::RGBx,
            VideoFormat::BGRA,
            VideoFormat::RGBA
        ),
        spa::pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 1920,
                height: 1080
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        spa::pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: fps, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: fps, denom: 1 }
        ),
    );
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map(|(cursor, _)| cursor.into_inner())
    .map_err(|e| format!("Failed to build PipeWire format params: {e:?}"))
}

fn run_single_pipewire_loop(
    app: &tauri::AppHandle,
    fd: OwnedFd,
    node_id: u32,
    fps: u32,
    cancel: &Arc<AtomicBool>,
) -> Result<bool, String> {
    pw::init();

    let mainloop = pw::main_loop::MainLoopRc::new(None)
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

    let state = StreamState {
        cancel: cancel.clone(),
        app: app.clone(),
        negotiated: None,
        // Compositors often ignore the framerate range and send on every
        // damage, so the cap is enforced here too.
        min_interval: Duration::from_secs_f64(1.0 / fps.max(1) as f64),
        last_frame: None,
    };

    let _listener = stream
        .add_local_listener_with_user_data(state)
        .param_changed(|_, state, id, param| {
            let Some(param) = param else {
                return;
            };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            let mut info = spa::param::video::VideoInfoRaw::default();
            if info.parse(param).is_err() {
                return;
            }
            let size = info.size();
            state.negotiated = pixel_format_from_spa(info.format()).map(|format| Negotiated {
                format,
                width: size.width,
                height: size.height,
            });
            eprintln!(
                "[ScreenCapture] negotiated {:?} {}x{} @ {}/{} -> {:?}",
                info.format(),
                size.width,
                size.height,
                info.framerate().num,
                info.framerate().denom,
                state.negotiated.map(|n| n.format)
            );
        })
        .process(|stream, state| {
            if state.cancel.load(Ordering::Relaxed) {
                return;
            }
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(negotiated) = state.negotiated else {
                return;
            };
            let now = Instant::now();
            if state
                .last_frame
                .is_some_and(|t| now.duration_since(t) < state.min_interval)
            {
                return;
            }
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };
            let chunk = data.chunk();
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;
            let stride = match chunk.stride() {
                s if s > 0 => s as usize,
                _ => negotiated.width as usize * 4,
            };
            let Some(raw) = data.data() else {
                return;
            };
            if size == 0 || offset + size > raw.len() {
                return;
            }
            let raw = &raw[offset..offset + size];
            state.last_frame = Some(now);

            // With a native encoder attached the frame goes out as raw
            // pixels; JPEG + base64 + IPC is only for the webview path.
            if super::video_sink_active() {
                if let Some(frame) = pack_frame(raw, stride, negotiated) {
                    super::publish_raw_frame(frame);
                }
            } else if let Ok(payload) = encode_frame(raw, stride, negotiated) {
                let _ = state.app.emit("screen:frame", payload);
            }
        })
        .register();

    // `mainloop.run()` blocks until something quits it, and nothing else does:
    // without this the capture thread outlives `stop()` and joining it hangs.
    // A timer rather than the frame callback, because a still screen produces
    // no frames at all — PipeWire only sends on damage.
    let quit_loop = mainloop.downgrade();
    let quit_cancel = cancel.clone();
    let quit_timer = mainloop.loop_().add_timer(move |_| {
        if quit_cancel.load(Ordering::Relaxed) {
            if let Some(mainloop) = quit_loop.upgrade() {
                mainloop.quit();
            }
        }
    });
    quit_timer
        .update_timer(
            Some(Duration::from_millis(100)),
            Some(Duration::from_millis(100)),
        )
        .into_result()
        .map_err(|e| format!("Failed to arm capture shutdown timer: {e}"))?;

    // No `set_active(true)` here: before `connect` the stream has no node and
    // PipeWire answers -EIO. Connecting without `StreamFlags::INACTIVE` makes
    // the stream active anyway.
    let format_bytes = format_params(fps)?;
    let format_pod = spa::pod::Pod::from_bytes(&format_bytes)
        .ok_or("Failed to read back PipeWire format params")?;
    let mut params = [format_pod];

    use pw::spa::utils::Direction;
    stream
        .connect(
            Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| format!("Failed to connect stream: {e}"))?;

    mainloop.run();

    Ok(cancel.load(Ordering::Relaxed))
}

/// Copies a PipeWire buffer into a tightly packed frame of the negotiated
/// layout and size for the native encoder. Only row padding is removed —
/// colour conversion and scaling are left to the encoder pipeline, which does
/// both with SIMD.
pub(crate) fn pack_frame(raw: &[u8], stride: usize, n: Negotiated) -> Option<super::RawFrame> {
    // VP8 chroma subsampling needs even dimensions; cropping a line or column
    // is invisible and avoids the encoder rejecting the frame outright.
    let width = (n.width as usize) & !1;
    let rows_present = raw.len().checked_div(stride).unwrap_or(0);
    let height = (n.height as usize).min(rows_present) & !1;
    let tight_row = width * 4;
    if width == 0 || height == 0 || stride < tight_row {
        return None;
    }

    let mut data = vec![0u8; tight_row * height];
    for y in 0..height {
        let src = y * stride;
        let dst = y * tight_row;
        data[dst..dst + tight_row].copy_from_slice(&raw[src..src + tight_row]);
    }

    Some(super::RawFrame {
        width: width as u32,
        height: height as u32,
        format: n.format,
        data,
    })
}

fn encode_frame(raw: &[u8], stride: usize, n: Negotiated) -> Result<ScreenFramePayload, String> {
    let frame = pack_frame(raw, stride, n).ok_or("Invalid frame dimensions")?;
    let (width, height) = (frame.width, frame.height);

    let mut rgba = frame.data;
    if frame.format == PixelFormat::Bgra {
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
    }
    for px in rgba.chunks_exact_mut(4) {
        px[3] = 255;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_negotiated_formats() {
        use spa::param::video::VideoFormat as F;
        assert_eq!(pixel_format_from_spa(F::BGRx), Some(PixelFormat::Bgra));
        assert_eq!(pixel_format_from_spa(F::BGRA), Some(PixelFormat::Bgra));
        assert_eq!(pixel_format_from_spa(F::RGBx), Some(PixelFormat::Rgba));
        assert_eq!(pixel_format_from_spa(F::RGBA), Some(PixelFormat::Rgba));
        assert_eq!(pixel_format_from_spa(F::I420), None);
    }

    #[test]
    fn packs_using_the_negotiated_size_not_the_stride() {
        // 3x3 RGBx with 16-byte rows (4 bytes of padding per row).
        let n = Negotiated {
            format: PixelFormat::Rgba,
            width: 3,
            height: 3,
        };
        let stride = 16;
        let raw: Vec<u8> = (0..(stride * 3) as u8).collect();
        let f = pack_frame(&raw, stride, n).expect("frame");
        // Cropped to even 2x2, padding dropped, format kept.
        assert_eq!((f.width, f.height), (2, 2));
        assert_eq!(f.format, PixelFormat::Rgba);
        assert_eq!(&f.data[0..8], &raw[0..8]);
        assert_eq!(&f.data[8..16], &raw[16..24]);
    }

    #[test]
    fn rejects_short_buffers() {
        let n = Negotiated {
            format: PixelFormat::Bgra,
            width: 1920,
            height: 1080,
        };
        assert!(pack_frame(&[0u8; 100], 7680, n).is_none());
        // Stride smaller than a row of the negotiated width.
        assert!(pack_frame(&[0u8; 1000], 4, n).is_none());
    }

    #[test]
    fn format_params_serialize() {
        let bytes = format_params(30).expect("pod");
        assert!(spa::pod::Pod::from_bytes(&bytes).is_some());
    }
}
