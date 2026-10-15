#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::{DynamicImage, EncodableLayout, ExtendedColorType, ImageEncoder};
    use tauri::Emitter;
    use windows::core::Interface;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
        IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT,
        DXGI_OUTDUPL_FRAME_INFO,
    };

    use super::super::{CaptureSession, MonitorInfo, PixelFormat, RawFrame, ScreenFramePayload};

    const MAX_DIMENSION: u32 = 1920;
    const JPEG_QUALITY: u8 = 75;
    const MAX_CONSECUTIVE_ERRORS: u32 = 10;

    /// One desktop output and the adapter that drives it. Monitor indices
    /// shown to the user and used for capture both come from this one
    /// enumeration, across every adapter. (The list used to come from
    /// EnumDisplayDevices while capture only looked at adapter 0, so on a
    /// multi-GPU machine the picked monitor and the captured one differed.)
    struct DesktopOutput {
        adapter: IDXGIAdapter1,
        output: IDXGIOutput1,
        name: String,
        width: u32,
        height: u32,
    }

    fn enumerate_outputs() -> Result<Vec<DesktopOutput>, String> {
        let factory: IDXGIFactory1 =
            unsafe { CreateDXGIFactory1() }.map_err(|e| format!("CreateDXGIFactory1 failed: {e}"))?;
        let mut outputs = Vec::new();
        let mut adapter_index = 0u32;
        loop {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(adapter) => adapter,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(format!("EnumAdapters1 failed: {e}")),
            };
            adapter_index += 1;

            let mut output_index = 0u32;
            loop {
                let output = match unsafe { adapter.EnumOutputs(output_index) } {
                    Ok(output) => output,
                    // DXGI_ERROR_NOT_FOUND ends this adapter's outputs; any
                    // other failure skips the adapter rather than the list.
                    Err(_) => break,
                };
                output_index += 1;

                let Ok(desc) = (unsafe { output.GetDesc() }) else {
                    continue;
                };
                if !desc.AttachedToDesktop.as_bool() {
                    continue;
                }
                let Ok(output1) = output.cast::<IDXGIOutput1>() else {
                    continue;
                };
                let device_name = String::from_utf16_lossy(&desc.DeviceName)
                    .trim_end_matches('\0')
                    .to_string();
                let r = desc.DesktopCoordinates;
                outputs.push(DesktopOutput {
                    adapter: adapter.clone(),
                    output: output1,
                    name: device_name,
                    width: (r.right - r.left).max(0) as u32,
                    height: (r.bottom - r.top).max(0) as u32,
                });
            }
        }
        Ok(outputs)
    }

    pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
        let outputs = enumerate_outputs()?;
        if outputs.is_empty() {
            return Err("No displays found to capture".into());
        }
        Ok(outputs
            .iter()
            .enumerate()
            .map(|(index, o)| MonitorInfo {
                index,
                name: if o.name.is_empty() {
                    format!("Display {}", index + 1)
                } else {
                    format!("Display {} ({})", index + 1, o.name.trim_start_matches(r"\\.\"))
                },
                width: o.width,
                height: o.height,
            })
            .collect())
    }

    pub fn start_capture(
        app: tauri::AppHandle,
        monitor_index: usize,
        fps: u32,
    ) -> Result<CaptureSession, String> {
        let fps = if fps > 0 { fps } else { 30 };
        let period = Duration::from_secs_f64(1.0 / fps as f64);
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        let target = enumerate_outputs()?
            .into_iter()
            .nth(monitor_index)
            .ok_or_else(|| format!("Monitor index {monitor_index} not found"))?;
        let mut duplicator = Duplicator::new(target)?;

        let handle = thread::spawn(move || {
            let mut consecutive_errors: u32 = 0;
            let timeout_ms = (period.as_millis() as u32).clamp(1, 100);

            loop {
                if cancel_clone.load(Ordering::Relaxed) {
                    break;
                }
                let start = Instant::now();

                match duplicator.next_frame(timeout_ms) {
                    Ok(Some(frame)) => {
                        consecutive_errors = 0;
                        // A native encoder, when attached, takes raw pixels;
                        // otherwise the webview gets JPEG.
                        if super::super::video_sink_active() {
                            super::super::publish_raw_frame(frame);
                        } else {
                            match encode_jpeg(frame) {
                                Ok(payload) => {
                                    let _ = app.emit("screen:frame", payload);
                                }
                                Err(e) => eprintln!("[ScreenCapture] JPEG encode failed: {e}"),
                            }
                        }
                    }
                    // Nothing changed on screen since the last frame: not an
                    // error. (It used to count as one, so a still desktop
                    // stopped the capture after a second.)
                    Ok(None) => {
                        consecutive_errors = 0;
                    }
                    Err(CaptureError::AccessLost) => {
                        // Mode change, lock screen, UAC prompt, full-screen
                        // app: the duplication has to be recreated.
                        eprintln!("[ScreenCapture] DXGI access lost, recreating duplication");
                        if let Err(e) = duplicator.recreate() {
                            consecutive_errors += 1;
                            eprintln!("[ScreenCapture] recreate failed ({consecutive_errors}): {e}");
                            thread::sleep(Duration::from_millis(250));
                        }
                    }
                    Err(CaptureError::Other(e)) => {
                        consecutive_errors += 1;
                        eprintln!(
                            "[ScreenCapture] DXGI frame error ({consecutive_errors} consecutive): {e}"
                        );
                    }
                }

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    eprintln!("[ScreenCapture] DXGI: too many consecutive errors, stopping");
                    break;
                }

                let elapsed = start.elapsed();
                if elapsed < period {
                    thread::sleep(period - elapsed);
                }
            }
        });

        Ok(CaptureSession {
            cancel,
            handle: Some(handle),
        })
    }

    enum CaptureError {
        AccessLost,
        Other(String),
    }

    /// Releases the acquired frame however the capture of it ends.
    struct AcquiredFrame<'a> {
        duplication: &'a IDXGIOutputDuplication,
    }

    impl Drop for AcquiredFrame<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = self.duplication.ReleaseFrame();
            }
        }
    }

    /// Unmaps the staging texture however the copy out of it ends.
    struct MappedTexture<'a> {
        context: &'a ID3D11DeviceContext,
        texture: &'a ID3D11Texture2D,
    }

    impl Drop for MappedTexture<'_> {
        fn drop(&mut self) {
            unsafe {
                self.context.Unmap(self.texture, 0);
            }
        }
    }

    struct Duplicator {
        target: DesktopOutput,
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        duplication: IDXGIOutputDuplication,
        staging: Option<(ID3D11Texture2D, u32, u32)>,
        have_frame: bool,
    }

    impl Duplicator {
        fn new(target: DesktopOutput) -> Result<Self, String> {
            let (device, context) = create_device(&target.adapter)?;
            let duplication = unsafe { target.output.DuplicateOutput(&device) }
                .map_err(|e| format!("DuplicateOutput failed: {e}"))?;
            Ok(Self {
                target,
                device,
                context,
                duplication,
                staging: None,
                have_frame: false,
            })
        }

        fn recreate(&mut self) -> Result<(), String> {
            let duplication = unsafe { self.target.output.DuplicateOutput(&self.device) }
                .map_err(|e| format!("DuplicateOutput failed: {e}"))?;
            self.duplication = duplication;
            self.staging = None;
            self.have_frame = false;
            Ok(())
        }

        /// The next desktop image, or `None` when nothing new was presented
        /// within `timeout_ms`.
        fn next_frame(&mut self, timeout_ms: u32) -> Result<Option<RawFrame>, CaptureError> {
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match unsafe {
                self.duplication
                    .AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource)
            } {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err(CaptureError::AccessLost)
                }
                Err(e) => return Err(CaptureError::Other(format!("AcquireNextFrame failed: {e}"))),
            }
            let duplication = self.duplication.clone();
            let _release = AcquiredFrame {
                duplication: &duplication,
            };

            // Only the pointer moved: the image is unchanged.
            if frame_info.LastPresentTime == 0 && self.have_frame {
                return Ok(None);
            }

            let resource = resource
                .ok_or_else(|| CaptureError::Other("No desktop resource acquired".into()))?;
            let texture: ID3D11Texture2D = resource
                .cast()
                .map_err(|e| CaptureError::Other(format!("Cast to ID3D11Texture2D failed: {e}")))?;

            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            let (width, height) = (desc.Width, desc.Height);

            let staging = self.staging_texture(desc)?;
            unsafe { self.context.CopyResource(&staging, &texture) };

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context
                    .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .map_err(|e| CaptureError::Other(format!("Map failed: {e}")))?;
            }
            let _unmap = MappedTexture {
                context: &self.context,
                texture: &staging,
            };

            let row_pitch = mapped.RowPitch as usize;
            let data = unsafe {
                std::slice::from_raw_parts(mapped.pData as *const u8, row_pitch * height as usize)
            };
            let frame = pack_bgra(data, row_pitch, width, height)
                .ok_or_else(|| CaptureError::Other("Invalid frame dimensions".into()))?;
            self.have_frame = true;
            Ok(Some(frame))
        }

        /// A CPU-readable copy target matching the desktop texture, reused
        /// until the desktop size changes.
        fn staging_texture(
            &mut self,
            desc: D3D11_TEXTURE2D_DESC,
        ) -> Result<ID3D11Texture2D, CaptureError> {
            if let Some((tex, w, h)) = &self.staging {
                if *w == desc.Width && *h == desc.Height {
                    return Ok(tex.clone());
                }
            }
            let mut staging_desc = desc;
            staging_desc.BindFlags = 0;
            staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            staging_desc.Usage = D3D11_USAGE_STAGING;
            staging_desc.MiscFlags = 0;
            staging_desc.MipLevels = 1;
            staging_desc.ArraySize = 1;

            let mut texture: Option<ID3D11Texture2D> = None;
            unsafe {
                self.device
                    .CreateTexture2D(&staging_desc, None, Some(&mut texture))
                    .map_err(|e| CaptureError::Other(format!("CreateTexture2D failed: {e}")))?;
            }
            let texture =
                texture.ok_or_else(|| CaptureError::Other("CreateTexture2D returned null".into()))?;
            self.staging = Some((texture.clone(), desc.Width, desc.Height));
            Ok(texture)
        }
    }

    /// A device on the adapter that drives the output: DuplicateOutput fails
    /// for a device created on any other adapter.
    fn create_device(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(
                adapter,
                // An explicit adapter requires the UNKNOWN driver type.
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
        }
        let device = device.ok_or("Failed to create D3D11 device")?;
        let context = context.ok_or("Failed to create D3D11 context")?;
        Ok((device, context))
    }

    /// Tightly packed BGRA with even dimensions (VP8 chroma subsampling).
    fn pack_bgra(data: &[u8], row_pitch: usize, width: u32, height: u32) -> Option<RawFrame> {
        let w = (width & !1) as usize;
        let h = (height & !1) as usize;
        let tight = w * 4;
        if w == 0 || h == 0 || row_pitch < tight || data.len() < row_pitch * (h - 1) + tight {
            return None;
        }
        let mut out = vec![0u8; tight * h];
        for y in 0..h {
            out[y * tight..(y + 1) * tight]
                .copy_from_slice(&data[y * row_pitch..y * row_pitch + tight]);
        }
        Some(RawFrame {
            width: w as u32,
            height: h as u32,
            format: PixelFormat::Bgra,
            data: out,
        })
    }

    fn encode_jpeg(frame: RawFrame) -> Result<ScreenFramePayload, String> {
        let (width, height) = (frame.width, frame.height);
        let mut rgba = frame.data;
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
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
            img = img.resize(new_w, new_h, FilterType::Triangle);
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
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::super::{CaptureSession, MonitorInfo};

    pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
        Err("Screen capture is not supported on this platform".into())
    }

    pub fn start_capture(
        _app: tauri::AppHandle,
        _monitor_index: usize,
        _fps: u32,
    ) -> Result<CaptureSession, String> {
        Err("Screen capture is not supported on this platform".into())
    }
}

pub use imp::*;
