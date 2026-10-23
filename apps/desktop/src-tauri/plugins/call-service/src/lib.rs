//! Android foreground service for voice calls.
//!
//! Android silences microphone capture for apps in the background (9+) and
//! stops background work aggressively, so a call only survives the screen
//! turning off while a foreground service of type `microphone` (plus `camera`
//! while the camera is on) is running. The service and its ongoing
//! notification live in Kotlin under `android/`; the page calls the Kotlin
//! commands directly (`plugin:call-service|start`, `update`, `stop`) and hears
//! the notification's "Leave call" action as the `leave` plugin event.
//!
//! Every other platform registers nothing native. The plugin is still added
//! there so its permissions resolve in the shared capability file.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.kizuna.callservice";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("call-service")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "CallServicePlugin")?;
            Ok(())
        })
        .build()
}
