const COMMANDS: &[&str] = &["start", "update", "stop", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
