# Getting Started

Kizuna is a self-hosted Discord alternative with real-time text chat, voice channels (WebRTC via mediasoup SFU), and screen sharing.

## Quick Start

### Join an existing server

1. Download the desktop app for [Linux, macOS, or Windows](https://github.com/ItsAshn/kizuna/releases/latest)
2. Get an invite link from a server admin and paste it into the app
3. Or try the official test server at `server.use-kizuna.com`

### Host your own server

```bash
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
cp .env.example .env
# Edit .env — set DOMAIN and JWT_SECRET at minimum
docker compose up -d
```

The server will be available at `https://your-domain.com`. For voice and screen sharing to work, ensure UDP ports `40000-40099` are reachable.

## Features

- **Real-time text chat** — channels, direct messages, typing indicators, and `@mentions` (`@everyone`, `@here`, `@user`)
- **Voice channels** — powered by WebRTC via mediasoup SFU with per-channel audio quality controls
- **Screen sharing** — share your screen in voice channels (desktop client only)
- **Custom roles & permissions** — create roles with granular permissions
- **File uploads & attachments** — images, video, audio, PDFs, and more with drag-and-drop
- **Invite codes** — generate join links with usage limits and expiry, with QR codes
- **Cross-server** — connect to multiple self-hosted Kizuna servers from one client
- **Desktop client** — Windows, macOS (Apple Silicon), and Linux via Tauri v2 with auto-updates
- **Docker deployment** — one-command deploy with automatic HTTPS via Caddy

## Project Structure

| Package | Path | Purpose |
|---|---|---|
| `@kizuna/server` | `apps/server/` | Node.js backend, WebSocket API, mediasoup SFU for WebRTC |
| `@kizuna/desktop` | `apps/desktop/` | Tauri v2 desktop client (React + Vite) |
| `@kizuna/shared` | `packages/shared/` | Shared TypeScript types and utilities |
