---
title: System Requirements
description: System requirements for Kizuna desktop client and server. Audio pipeline, screen capture support across Windows, macOS, Linux, and Android.
---

# System Requirements

## Audio Pipeline

Kizuna handles audio entirely in native code (Rust). No GStreamer or other media framework is required for voice chat.

### Required System Packages

#### Linux

| Package | Purpose |
|---|---|
| `alsa-lib` / `libasound2` | Audio device access (ALSA backend) |
| `pipewire` or `pulseaudio` | Audio server |
| `pipewire-pulse` | PulseAudio compatibility layer (**required on PipeWire systems**) |
| `paplay` (from `pulseaudio-utils` or `pipewire-pulse`) | Audio output subprocess |

**Arch:**
```bash
sudo pacman -S alsa-lib pipewire pipewire-pulse
```

**Debian/Ubuntu:**
```bash
sudo apt-get install libasound2 pipewire pipewire-pulse
```

**Fedora:**
```bash
sudo dnf install alsa-lib pipewire pipewire-pulse
```

#### macOS

No additional packages required. CoreAudio is used natively.

#### Windows

No additional packages required. WASAPI is used natively.

## Screen Capture

### Linux

Screen capture on Linux requires a Portal-compatible desktop environment (GNOME, KDE, etc.). On Wayland, the `xdg-desktop-portal` service must be running.

### macOS

Screen capture requires the app to be granted screen recording permission in System Settings > Privacy & Security.

## Server Requirements

| Resource | Minimum |
|---|---|
| CPU | 2 cores |
| RAM | 512 MB |
| Storage | 1 GB (grows with uploaded files) |
| Network | UDP ports 40000-40099 open for WebRTC |
