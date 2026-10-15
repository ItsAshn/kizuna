---
title: Self-Hosting
description: Deploy your own Kizuna server with Docker. Self-hosted Discord alternative — one command deploy with automatic HTTPS via Caddy.
---

# Self-Hosting

Deploy your own Kizuna server with Docker. Pre-built multi-arch images are pulled from `ghcr.io/itsashn/kizuna` — no build tools or compilation needed on your server.

## Prerequisites

- A server running Linux (amd64 or arm64)
- A domain name with an A record pointing to your server's IP
- Docker and Docker Compose v2 installed
- Ports 80, 443 (TCP) and 40000-40099 (UDP and TCP) reachable

## Setup

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in
```

### 2. Clone and configure

```bash
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
cp .env.example .env
```

Edit `.env` — set at minimum:

| Variable     | Description                |
| ------------ | -------------------------- |
| `DOMAIN`     | Your domain name           |
| `JWT_SECRET` | Run `openssl rand -hex 64` |

See [Configuration](/guide/configuration) for all available variables.

### 3. Prepare data directories

```bash
mkdir -p data uploads
chown -R 1000:1000 data uploads
```

The container runs as UID 1000. `data/` holds the SQLite database, `uploads/` holds attachments and GIFs.

### 4. Configure firewall

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 40000:40099/udp
sudo ufw allow 40000:40099/tcp
sudo ufw enable
```

```bash
# Firewalld (Fedora/RHEL)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-port=40000-40099/udp
sudo firewall-cmd --permanent --add-port=40000-40099/tcp
sudo firewall-cmd --reload
```

Ports 80/443 are for HTTPS via Caddy. 40000-40099 are for WebRTC voice and video — Caddy can't proxy media, so these are exposed directly from the Kizuna container. UDP is the normal path; TCP on the same range is the fallback for clients whose network blocks UDP.

If your VPS has an external firewall (DigitalOcean, AWS, etc.), open these ports there too.

### 5. Launch

```bash
docker compose up -d
```

This pulls the pre-built image from `ghcr.io/itsashn/kizuna:latest` and starts everything. Caddy will automatically obtain a Let's Encrypt certificate on first run.

### 6. Verify

```bash
docker compose ps
docker compose logs kizuna
curl -I https://your-domain.com/health
```

Visit `https://your-domain.com` and create an account.

## How it works

```
Internet
    ├── :443 (HTTPS) → Caddy → kizuna:5000 (HTTP + WebSocket)
    └── :40000-40099 (UDP, TCP fallback) → Kizuna (mediasoup WebRTC SFU)
```

Caddy handles TLS termination and reverse-proxies to the Kizuna server on port 5000. WebRTC media bypasses Caddy entirely. Because Caddy is the only way in for HTTP, the compose file sets `TRUST_PROXY=true` so the server reads the client IP from Caddy's `X-Forwarded-For`.

## Updating

### Automatic (default)

The compose file includes [Watchtower](https://github.com/containrrr/watchtower), which polls for new images every hour and automatically updates the Kizuna container when a new release is available. No action needed — updates happen in the background. It follows the `latest` tag, which only moves for stable releases, never for release candidates.

To disable automatic updates, remove the `watchtower` service from `docker-compose.yml`.

### Manual

```bash
# Pull latest image and recreate
docker compose pull && docker compose up -d
```

For safe updates with health-check verification and automatic rollback:

```bash
./scripts/update.sh                 # update the tag you are on (latest by default)
./scripts/update.sh --pin v0.2.0   # pin to a specific release
./scripts/update.sh --pin latest   # unpin
./scripts/update.sh --no-verify     # skip health check
```

The update script records the running image, pulls the new one, recreates the container, waits for `/health` to respond, and rolls back to the recorded image on failure.

### Pinning to a release

```bash
# Set the tag in .env (or run ./scripts/update.sh --pin v0.2.0):
#   KIZUNA_TAG=v0.2.0
# Then:
docker compose pull && docker compose up -d
```

## Development builds

If you need to build the image locally (e.g. for testing changes):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

This requires the build tools (python3, make, g++) inside the Docker build stage — not on your host.

## Directory layout

```
kizuna/
├── .env              # Your configuration
├── data/             # SQLite database (persistent)
├── uploads/          # Attachments, GIFs (persistent)
├── Caddyfile         # Reverse proxy config
└── docker-compose.yml
```

## Backups

Your data lives in `data/` and `uploads/` directories on the host. Back them up however you prefer:

```bash
tar -czf kizuna-backup.tar.gz data/ uploads/
```
