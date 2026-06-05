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

```bash
# Install dependencies
pnpm install

# Start the server (http://localhost:5000)
pnpm dev:server

# Start the desktop client dev server (http://localhost:1420)
pnpm dev:desktop
```

Open `http://localhost:1420` in Chrome or Firefox. Voice channels require WebRTC support.

### Linux Dev Notes

Voice channels in the Tauri desktop window (`pnpm desktop`) require `webkit2gtk-4.1` built with WebRTC support. On Arch Linux, the standard `extra/webkit2gtk-4.1` package does not include it. Use `pnpm dev:desktop` and open Chrome/Firefox for voice features during development. The CI-built AppImage bundles WebKit+GStreamer from Ubuntu, which includes full WebRTC support out of the box.

**PipeWire systems (Arch, CachyOS, Fedora, etc.):** Ensure `pipewire-pulse` is installed and running so the AppImage's audio pipeline can access your microphone through the PulseAudio compatibility layer. Without it, microphone permissions will be denied and the settings panel may freeze.

```bash
# CachyOS / Arch Linux
sudo pacman -S pipewire-pulse
systemctl --user enable --now pipewire-pulse pipewire-pulse.socket
```

## Building from Source

```bash
# Prerequisites: Node.js 22+, pnpm 9+, Rust toolchain
pnpm install

# Build the server
pnpm build:server

# Build the desktop client
pnpm build:desktop
```

## License

Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0). You may use, share, and modify this software for non-commercial purposes only. Any derivative works must be shared under the same license.
