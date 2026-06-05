use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub device_id: String,
    pub is_default: bool,
    pub max_channels: u16,
    pub default_sample_rate: u32,
}

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub buffer_size_ms: u32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 1,
            buffer_size_ms: 20,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoSource {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub source_type: VideoSourceType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoSourceType {
    Monitor,
    Window,
}

#[derive(Debug, Clone)]
pub struct VideoConfig {
    pub fps: u32,
    pub max_width: u32,
    pub jpeg_quality: u8,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            fps: 15,
            max_width: 1920,
            jpeg_quality: 75,
        }
    }
}

pub struct AudioStreamHandle {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct VideoStreamHandle {
    pub width: u32,
    pub height: u32,
}

pub trait AudioCaptureBackend: Send {
    fn list_devices(&self) -> Result<Vec<AudioDevice>, String>;
    fn start_capture(
        &self,
        device: &AudioDevice,
        config: &AudioConfig,
        on_data: Box<dyn Fn(Vec<f32>) + Send + 'static>,
    ) -> Result<AudioStreamHandle, String>;
    fn stop_capture(&self);
}

pub trait ScreenCaptureBackend: Send {
    fn list_sources(&self) -> Result<Vec<VideoSource>, String>;
    fn start_capture(
        &self,
        source_index: usize,
        config: &VideoConfig,
        on_frame: Box<dyn Fn(Vec<u8>, u32, u32) + Send + 'static>,
    ) -> Result<VideoStreamHandle, String>;
    fn stop_capture(&self);
}
