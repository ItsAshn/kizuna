# Kizuna

Self-hosted Discord alternative with text chat, voice channels, and screen sharing. You host the server, you own the data.

## Features

- **Real-time text chat** — channels, direct messages, typing indicators, and `@mentions` (`@everyone`, `@here`, `@user`)
- **Voice channels** — powered by WebRTC via mediasoup SFU with per-channel audio quality controls
- **Screen sharing** — share your screen in voice channels (desktop client only)
- **Custom roles & permissions** — create roles with granular permissions (send messages, manage channels, delete messages, kick members, manage invites)
- **File uploads & attachments** — images, video, audio, PDFs, and more with drag-and-drop
- **Invite codes** — generate join links with usage limits and expiry, with QR codes
- **Cross-server** — connect to multiple self-hosted Kizuna servers from one client
- **Desktop client** — Windows + Linux via Tauri v2 with auto-updates and background notifications
- **Docker deployment** — one-command deploy with automatic HTTPS via Caddy

## Hosting a Server

### Docker (recommended)

```bash
# Clone and configure
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna

# Create .env file
cp .env.example .env
# Edit .env — set DOMAIN and JWT_SECRET at minimum

docker compose up -d
```

The server will be available at `https://your-domain.com`. For voice and screen sharing to work, ensure UDP ports `40000-40099` are reachable.

### Manual

```bash
# Requires Node.js 22+ and pnpm 9+
pnpm install
pnpm build:server
pnpm start
```

### Environment Variables

All settings are in the `.env` file. See `.env.example` for a full reference.

**Required:**
- `DOMAIN` — your domain name (Caddy needs this for HTTPS)
- `JWT_SECRET` — generate with `openssl rand -hex 64`

**Optional but recommended:**
- `SERVER_NAME` — display name shown to clients
- `SERVER_DESCRIPTION` — short description
- `SERVER_URL` — full HTTPS URL (used for invite codes)
- `SERVER_PASSWORD` — optional join password
- `PUBLIC_ADDRESS` — your server's public IP for WebRTC (auto-detected if blank)

## Connecting

Download the latest desktop client from [releases](https://github.com/ItsAshn/kizuna/releases) and point it at your server's address.

## Development

### Quick Start (recommended)

```bash
# One-line install — detects OS, installs deps, clones, builds
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash
```

This installs Rust, Node.js, pnpm, and all system dependencies (including rebuilding webkit2gtk with WebRTC on Arch). On Windows, it sets up WebView2, Visual C++ Build Tools, and the full toolchain.

Skip the WebRTC rebuild if you only need text chat:
```bash
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash -s -- --skip-webrtc
```

### Manual Setup

```bash
# Install dependencies
pnpm install

# Start the server (http://localhost:5000)
pnpm dev:server

# Start the desktop client dev server (http://localhost:1420)
pnpm dev:desktop
```

Open `http://localhost:1420` in Chrome or Firefox. Voice channels require WebRTC support.

### Linux Voice / WebRTC

Voice channels need `webkit2gtk-4.1` compiled with `ENABLE_WEB_RTC=ON`. Most distros ship without it.

| Distro | Status | Fix |
|--------|--------|-----|
| **Arch / CachyOS** (`extra` repo) | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from PKGBUILD, ~45 min) |
| **Debian / Ubuntu** | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from apt source, ~60 min) |
| **Fedora** | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from dnf source, ~60 min) |
| **CI AppImage** | WebRTC enabled | Pre-built AppImage bundles patched webkit — end users get voice out of the box |

The install script detects your distro and offers to run `build-webkit-webrtc.sh` automatically. If you skip the rebuild, use `pnpm dev:desktop` and open Chrome/Firefox instead — voice will work there.

**PipeWire systems (Arch, CachyOS, Fedora, etc.):** Ensure `pipewire-pulse` is installed and running so the audio pipeline can access your microphone.

```bash
# CachyOS / Arch Linux
sudo pacman -S pipewire-pulse
systemctl --user enable --now pipewire-pulse pipewire-pulse.socket
```

## Building from Source

```bash
# One-line setup (recommended — installs all deps)
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash

# Or manually:
# Prerequisites: Node.js 22+, pnpm 9+, Rust toolchain
# Linux: also need webkit2gtk-4.1, gtk3, alsa (see scripts/install-linux.sh)
# Arch Linux: rebuild webkit2gtk-4.1 with ENABLE_WEB_RTC=ON for voice (see scripts/build-webkit-webrtc.sh)

pnpm install

# Build the server
pnpm build:server

# Build the desktop client
pnpm build:desktop
```

The CI-built AppImage and `.deb` bundle the patched webkit2gtk automatically — voice works out of the box for end users.

## License

Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0). You may use, share, and modify this software for non-commercial purposes only. Any derivative works must be shared under the same license.
