# Configuration Reference

All environment variables for the Kizuna server. Set these in `.env` before running `docker compose up -d`.

## Required

| Variable | Example | Description |
|---|---|---|
| `DOMAIN` | `chat.example.com` | Domain with DNS A record pointing to your server. Caddy uses this for TLS. |
| `JWT_SECRET` | *(generated)* | Secret for signing auth tokens. Generate: `openssl rand -hex 64` |

## Server Identity

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `5000` | Internal HTTP port (Caddy reverse-proxies to this). Not exposed externally. |
| `SERVER_NAME` | `Kizuna Server` | Display name shown to clients. |
| `SERVER_DESCRIPTION` | `A self-hosted Kizuna community` | Short description. |
| `SERVER_URL` | *(auto)* | Public HTTPS URL. Used for invite links. Should match your domain. |
| `SERVER_PASSWORD` | *(none)* | Optional join password. If set, users must provide it to register. |

## WebRTC / Voice

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_ADDRESS` | *(auto via STUN)* | Public IP or hostname announced as WebRTC ICE candidate. Set this if auto-detection fails. |
| `RTC_MIN_PORT` | `40000` | Start of UDP port range for voice. Each participant uses ~2 ports. |
| `RTC_MAX_PORT` | `40099` | End of UDP port range. Increase if you expect 50+ concurrent voice users. |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | mediasoup listen address. Don't change this unless you know what you're doing. |
| `MEDIASOUP_LOG_LEVEL` | `warn` | mediasoup verbosity: `debug`, `warn`, `error`, `none`. |

## Features

| Variable | Default | Description |
|---|---|---|
| `UPNP_ENABLED` | `false` | UPnP port mapping. Disable when using Docker/Caddy. |
| `AUTO_TAGGING_ENABLED` | `false` | AI-powered GIF auto-tagging (CLIP model). Uses ~1.5 GB RAM. |

## Public Server Listing

| Variable | Default | Description |
|---|---|---|
| `IS_PUBLIC` | `false` | List this server on the public server browser. Sends heartbeats every 60s. |
| `ANNOUNCE_URL` | `https://server.use-kizuna.com` | Registry URL. Only used when `IS_PUBLIC=true`. |
| `IS_REGISTRY` | `false` | Enable registry endpoints. Only for running your own server browser. |

## Advanced

| Variable | Default | Description |
|---|---|---|
| `SERVER_DB_PATH` | `/data/server.db` | SQLite database path (inside container). |
| `GIFS_DIR` | `/app/uploads/gifs` | GIF/sticker storage directory. |
| `MAX_GIF_SIZE` | `5242880` | Max GIF file size in bytes (5 MB). |
| `MAX_PACK_SIZE` | `15728640` | Max sticker pack ZIP size in bytes (15 MB). |
| `MAX_BODY_SIZE` | `1048576` | Max request body size in bytes (1 MB). |

## Example: Production .env

```bash
# Required
DOMAIN=chat.example.com
JWT_SECRET=$(openssl rand -hex 64)

# Server
SERVER_NAME=My Community
SERVER_DESCRIPTION=Welcome to our Kizuna server!

# Voice
PUBLIC_ADDRESS=chat.example.com
RTC_MIN_PORT=40000
RTC_MAX_PORT=40099

# Public listing (optional)
IS_PUBLIC=true
```
