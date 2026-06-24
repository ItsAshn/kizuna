#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::{DynamicImage, EncodableLayout, ExtendedColorType, ImageEncoder};
    use tauri::Emitter;
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    };
    use windows::Win32::Graphics::Dxgi::{
        IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
        IDXGIResource, DXGI_OUTDUPL_FRAME_INFO,
        DXGI_ERROR_WAIT_TIMEOUT,
    };
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    use windows::Win32::Foundation::HMODULE;

    const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x00000001;

    use super::super::{CaptureSession, MonitorInfo, ScreenFramePayload};

    const MAX_DIMENSION: u32 = 1920;
    const JPEG_QUALITY: u8 = 75;
    const MAX_CONSECUTIVE_ERRORS: u32 = 10;

    pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
        let mut monitors = Vec::new();
        let mut index = 0u32;

        loop {
            let mut display_device = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..Default::default()
            };

            unsafe {
                let result = EnumDisplayDevicesW(
                    None,
                    index,
                    &mut display_device,
                    EDD_GET_DEVICE_INTERFACE_NAME,
                );

                if result.as_bool() {
                    let name = String::from_utf16_lossy(&display_device.DeviceString)
                        .trim_end_matches('\0')
                        .to_string();

                    let width = 0u32;
                    let height = 0u32;

                    monitors.push(MonitorInfo {
                        index: index as usize,
                        name: if name.is_empty() {
                            format!("Display {}", index + 1)
                        } else {
                            name
                        },
                        width,
                        height,
                    });

                    index += 1;
                } else {
                    break;
                }
            }
        }

        if monitors.is_empty() {
            monitors.push(MonitorInfo {
                index: 0,
                name: "Primary Display".into(),
                width: 0,
                height: 0,
            });
        }

        Ok(monitors)
    }

    pub fn start_capture(
        app: tauri::AppHandle,
        monitor_index: usize,
        fps: u32,
    ) -> Result<CaptureSession, String> {
        let interval_ms: u32 = if fps > 0 { 1000 / fps } else { 33 };
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        let (device, context) = create_d3d11_device()?;
        let duplication =
            create_desktop_duplication(&device, monitor_index)?;

        let handle = thread::spawn(move || {
            let period = Duration::from_millis(interval_ms as u64);
            let mut consecutive_errors: u32 = 0;

            loop {
                if cancel_clone.load(Ordering::Relaxed) {
                    break;
                }

                let start = std::time::Instant::now();

                match capture_frame(
                    &device,
                    &context,
                    &duplication,
                ) {
                    Ok(payload) => {
                        consecutive_errors = 0;
                        let _ = app.emit("screen:frame", payload);
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        eprintln!(
                            "[ScreenCapture] DXGI frame error ({} consecutive): {e}",
                            consecutive_errors
                        );
                        if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                            eprintln!(
                                "[ScreenCapture] DXGI: too many consecutive errors, stopping"
                            );
                            break;
                        }
                    }
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

    fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        unsafe {
            D3D11CreateDevice(
                None,
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                0,
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

    fn create_desktop_duplication(
        device: &ID3D11Device,
        monitor_index: usize,
    ) -> Result<IDXGIOutputDuplication, String> {
        let dxgi_device: windows::Win32::Graphics::Dxgi::IDXGIDevice =
            device.cast().map_err(|e| format!("Cast to IDXGIDevice failed: {e}"))?;

        let adapter: IDXGIAdapter1 = unsafe {
            dxgi_device
                .GetAdapter()
                .map_err(|e| format!("GetAdapter failed: {e}"))?
                .cast()
                .map_err(|e| format!("Cast to IDXGIAdapter1 failed: {e}"))?
        };

        let factory: IDXGIFactory1 = unsafe {
            adapter
                .GetParent::<IDXGIFactory1>()
                .map_err(|e| format!("GetParent factory failed: {e}"))?
        };

        let mut output_index = 0u32;
        loop {
            let output_result = unsafe { factory.EnumAdapters1(0) }
                .ok()
                .and_then(|adapter| {
                    let output = unsafe { adapter.EnumOutputs(output_index) }.ok()?;
                    Some(output)
                });

            let output = match output_result {
                Some(o) => o,
                None => break,
            };

            let output1: IDXGIOutput1 = output
                .cast()
                .map_err(|e| format!("Cast to IDXGIOutput1 failed: {e}"))?;

            if output_index as usize == monitor_index {
                let duplication = unsafe {
                    output1.DuplicateOutput(device)
                }
                .map_err(|e| format!("DuplicateOutput failed: {e}"))?;

                return Ok(duplication);
            }

            output_index += 1;
        }

        Err(format!("Monitor index {} not found", monitor_index))
    }

    fn capture_frame(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        duplication: &IDXGIOutputDuplication,
    ) -> Result<ScreenFramePayload, String> {
        unsafe {
            let (_frame_info, desktop_resource) = loop {
                let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut desktop_resource: Option<IDXGIResource> = None;
                match duplication.AcquireNextFrame(100, &mut frame_info, &mut desktop_resource) {
                    Ok(()) => break (frame_info, desktop_resource),
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        return Err("Timeout acquiring frame".into());
                    }
                    Err(e) => {
                        return Err(format!("AcquireNextFrame failed: {e}"));
                    }
                }
            };

            let desktop_resource = desktop_resource
                .ok_or("No desktop resource acquired")?;

            let texture: ID3D11Texture2D = desktop_resource
                .cast()
                .map_err(|e| format!("Cast to ID3D11Texture2D failed: {e}"))?;

            let mut desc = std::mem::zeroed();
            texture.GetDesc(&mut desc);

            let width = desc.Width;
            let height = desc.Height;

            let mut staging_desc = desc;
            staging_desc.BindFlags = 0;
            staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            staging_desc.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_STAGING;
            staging_desc.MiscFlags = 0;

            let mut staging_texture: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging_texture))
                .map_err(|e| format!("CreateTexture2D failed: {e}"))?;
            let staging_texture = staging_texture
                .ok_or("CreateTexture2D returned null")?;

            context.CopyResource(&staging_texture, &texture);

            let mut mapped: D3D11_MAPPED_SUBRESOURCE = std::mem::zeroed();
            context
                .Map(
                    &staging_texture,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )
                .map_err(|e| format!("Map failed: {e}"))?;

            let data = std::slice::from_raw_parts(
                mapped.pData as *const u8,
                mapped.RowPitch as usize * height as usize,
            );

            let encoded = encode_frame(data, mapped.RowPitch as u32, width, height)?;

            context.Unmap(&staging_texture, 0);

            duplication.ReleaseFrame().ok();

            Ok(encoded)
        }
    }

    fn encode_frame(
        data: &[u8],
        row_pitch: u32,
        width: u32,
        height: u32,
    ) -> Result<ScreenFramePayload, String> {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            let src_row = y as usize * row_pitch as usize;
            let dst_row = y as usize * (width as usize * 4);
            for x in 0..width {
                let src = src_row + x as usize * 4;
                let dst = dst_row + x as usize * 4;
                if src + 3 < data.len() && dst + 3 < rgba.len() {
                    rgba[dst] = data[src + 2];
                    rgba[dst + 1] = data[src + 1];
                    rgba[dst + 2] = data[src];
                    rgba[dst + 3] = data[src + 3];
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
