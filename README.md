<p align="center">
  <img src="Logo.svg" alt="Kizuna" width="120" />
</p>

<h1 align="center">Kizuna</h1>

<p align="center">
  Self-hosted Discord alternative with text chat, voice channels, and screen sharing.<br />
  You host the server, you own the data.
</p>

<p align="center">
  <a href="https://github.com/ItsAshn/kizuna/releases"><img src="https://img.shields.io/github/package-json/v/ItsAshn/kizuna?style=flat-square&label=version" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ItsAshn/kizuna?style=flat-square" alt="License" /></a>
  <a href="https://github.com/ItsAshn/kizuna/pkgs/container/kizuna"><img src="https://img.shields.io/github/v/release/ItsAshn/kizuna?logo=docker&style=flat-square&label=docker" alt="Docker" /></a>
  <a href="https://github.com/ItsAshn/kizuna/issues"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
</p>

> [!IMPORTANT]
> Voice channels rely on WebRTC, which may have limited support on mobile browsers and some Linux configurations. If you run into issues, please [open a GitHub issue](https://github.com/ItsAshn/kizuna/issues/new) or reach out — your feedback helps improve cross-platform support.

## Features

- **Real-time text chat** — channels, direct messages, typing indicators, and `@mentions` (`@everyone`, `@here`, `@user`)
- **Voice channels** — powered by WebRTC via mediasoup SFU with per-channel audio quality controls
- **Screen sharing** — share your screen in voice channels (desktop client only)
- **Custom roles & permissions** — create roles with granular permissions (send messages, manage channels, delete messages, kick members, manage invites)
- **File uploads & attachments** — images, video, audio, PDFs, and more with drag-and-drop
- **Invite codes** — generate join links with usage limits and expiry, with QR codes
- **Cross-server** — connect to multiple self-hosted Kizuna servers from one client
- **Desktop client** — Windows, macOS (Apple Silicon), and Linux via Tauri v2 with auto-updates and background notifications
- **Docker deployment** — one-command deploy with automatic HTTPS via Caddy

## Project Structure

| Package | Path | Purpose |
|---|---|---|
| `@kizuna/server` | `apps/server/` | Node.js backend, WebSocket API, mediasoup SFU for WebRTC |
| `@kizuna/desktop` | `apps/desktop/` | Tauri v2 desktop client (SvelteKit + Vite) |
| `@kizuna/shared` | `packages/shared/` | Shared TypeScript types and utilities |

## Deploy

### Docker (recommended)

```bash
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
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

<details>
<summary>Environment Variables</summary>

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
</details>

## Desktop Client

Download the latest release from the [releases page](https://github.com/ItsAshn/kizuna/releases) and point it at your server's address.

## Development

### Quick Start (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash
```

This installs Rust, Node.js, pnpm, and all system dependencies (including rebuilding webkit2gtk with WebRTC on Arch). On Windows, it sets up WebView2, Visual C++ Build Tools, and the full toolchain.

Skip the WebRTC rebuild if you only need text chat:

```bash
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash -s -- --skip-webrtc
```

### Manual Setup

```bash
pnpm install

# Start the server (http://localhost:5000)
pnpm dev:server

# Start the desktop client dev server (http://localhost:1420)
pnpm dev:desktop
```

Open `http://localhost:1420` in Chrome or Firefox. Voice channels require WebRTC support.

<details>
<summary>Linux Voice / WebRTC</summary>

Voice channels need `webkit2gtk-4.1` compiled with `ENABLE_WEB_RTC=ON`. Most distros ship without it.

| Distro | Status | Fix |
|---|---|---|
| **Arch / CachyOS** (`extra`) | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from PKGBUILD, ~45 min) |
| **Debian / Ubuntu** | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from apt source, ~60 min) |
| **Fedora** | No WebRTC | `scripts/build-webkit-webrtc.sh` (rebuilds from dnf source, ~60 min) |
| **CI AppImage** | WebRTC enabled | Pre-built AppImage bundles patched webkit — voice out of the box |

The install script detects your distro and offers to run `build-webkit-webrtc.sh` automatically. If you skip the rebuild, use `pnpm dev:desktop` and open Chrome/Firefox instead — voice will work there.

**PipeWire systems (Arch, CachyOS, Fedora, etc.):** Ensure `pipewire-pulse` is installed.

```bash
sudo pacman -S pipewire-pulse
systemctl --user enable --now pipewire-pulse pipewire-pulse.socket
```
</details>

### Build from Source

```bash
# One-line setup (recommended)
curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash

# Or manually — requires Node.js 22+, pnpm 9+, Rust toolchain
pnpm install

# Build the server
pnpm build:server

# Build the desktop client
pnpm build:desktop
```

The CI-built AppImage and `.deb` bundle the patched webkit2gtk automatically — voice works out of the box for end users.

## License

GNU Affero General Public License v3.0 (AGPLv3). You may use, modify, and distribute this software freely, including for commercial purposes. If you modify the software and make it available as a network service, you must provide the complete source code of your modified version under the same license.

<p align="center">
  <img src="apps/desktop/public/KizunaStampHappy.webp" alt="" width="48" />
</p>
