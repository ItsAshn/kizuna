use serde::Serialize;

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

pub struct VideoStreamHandle {
    pub width: u32,
    pub height: u32,
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
