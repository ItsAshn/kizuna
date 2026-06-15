# Kizuna System Requirements

## Audio Pipeline

Kizuna handles audio entirely in native code (Rust). No GStreamer or other media framework is required for voice chat.

### Required System Packages

#### Linux

| Package | Purpose |
|---------|---------|
| `alsa-lib` / `libasound2` | Audio device access (ALSA backend) |
| `pipewire` or `pulseaudio` | Audio server |
| `pipewire-pulse` | PulseAudio compatibility layer (**required on PipeWire systems**) |
| `paplay` (from `pulseaudio-utils` or `pipewire-pulse`) | Audio output subprocess |

Install guides per distro:

**Arch:**
```
sudo pacman -S alsa-lib pipewire pipewire-pulse
```

**Debian/Ubuntu:**
```
sudo apt-get install libasound2 pipewire pipewire-pulse
```

**Fedora:**
```
sudo dnf install alsa-lib pipewire pipewire-pulseaudio
```

#### Windows
No special audio packages needed. WASAPI is built into Windows.

#### macOS
No special audio packages needed. CoreAudio is built into macOS.

### Optional: Full WebRTC webkit2gtk (Linux only)

For **non-voice** features that require browser WebRTC (e.g., screen sharing preview in the webview), webkit2gtk must be built with `ENABLE_WEB_RTC=ON`. Most distros ship without this flag.

Voice chat itself does NOT depend on webkit2gtk WebRTC. All audio (capture, processing, encoding, decoding, playback) runs in native Rust code.

Run `./scripts/install-linux.sh` to detect and offer to rebuild webkit2gtk.

### Runtime Diagnostics

The desktop app runs an environment check on startup. Missing audio dependencies will be reported in the UI. Run the `get_environment` Tauri command to see the diagnostics.

## Server Requirements

- Node.js 20+
- Open UDP ports for mediasoup (default: 40000-49999)
- A public IP or hostname for WebRTC ICE candidates

## Development Requirements

- Rust 1.70+
- Node.js 20+
- pnpm 9+
- Tauri system dependencies (see `./scripts/install-linux.sh`)
