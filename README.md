# Kizuna

Self-hosted Discord alternative with text chat and voice channels. You host the server, you own the data.

## Features

- Real-time text chat with channels and direct messages
- Voice channels powered by WebRTC (mediasoup SFU)
- Custom roles and permissions
- File uploads and attachments
- Desktop client (Windows + Linux) via Tauri
- Docker one-command deployment

## Hosting a Server

### Docker (recommended)

```bash
# Create .env file
cp apps/server/.env.example .env
# Edit .env — set JWT_SECRET at minimum

docker compose up -d
```

The server will be available on port `5000`. For voice to work, ensure UDP ports `40000-40099` are reachable.

### Manual

```bash
# Requires Node.js 22+ and pnpm 9+
pnpm install
pnpm build:server
pnpm start
```

### Configuration

All settings are in the `.env` file. The only required one is `JWT_SECRET` — generate it with:

```bash
openssl rand -hex 64
```

See `apps/server/.env.example` for a full reference of every option (public address, voice ports, TURN, DDNS, UPnP, etc).

## Connecting

Download the latest desktop client from [releases](https://github.com/itsashn/kizuna/releases) and point it at your server's address.

## License

Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0). You may use, share, and modify this software for non-commercial purposes only. Any derivative works must be shared under the same license.
