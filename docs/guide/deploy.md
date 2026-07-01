# Self-Hosting Guide

A complete walkthrough for deploying your own Kizuna server with Docker.

## Prerequisites

- **A server** with at least 512 MB RAM and 2 CPU cores (any VPS or home server running Linux)
- **A domain name** pointing to your server's IP (A record)
- **Docker** and **Docker Compose** v2 installed
- **Ports 80, 443 (TCP)** and **40000-40099 (UDP)** open in your firewall

### Recommended VPS Providers

| Provider | Starting Price | Notes |
|---|---|---|
| Hetzner | ~€4/mo | Best price-to-performance in EU |
| DigitalOcean | $6/mo | Good global presence, simple UI |
| BuyVM | $3.50/mo | Cheap, good for North America |
| Oracle Cloud | Free tier | 4 ARM cores, 24GB RAM free |

## Step 1: Server Setup

SSH into your server and install Docker:

```bash
# Install Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group membership to take effect
```

Verify Docker is working:

```bash
docker --version
docker compose version
```

## Step 2: Clone and Configure

```bash
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
cp .env.example .env
```

Edit `.env` and set at minimum:

| Variable | Example | Description |
|---|---|---|
| `DOMAIN` | `chat.example.com` | Your domain (must have DNS A record to this server) |
| `JWT_SECRET` | *(generated)* | Run `openssl rand -hex 64` to generate |

Review other variables if needed — see the [Configuration](/guide/configuration) reference for all options.

## Step 3: Prepare Data Directories

```bash
mkdir -p data uploads
chown -R 1000:1000 data uploads
```

The container runs as UID 1000. These directories hold the SQLite database and file uploads respectively.

## Step 4: Configure Firewall

### UFW (Ubuntu/Debian)

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 40000:40099/udp
sudo ufw enable
```

### Firewalld (Fedora/RHEL)

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-port=40000-40099/udp
sudo firewall-cmd --reload
```

Ports 80/443 are for HTTPS via Caddy. UDP ports 40000-40099 are for WebRTC voice traffic — Caddy can't proxy UDP, so these are exposed directly from the Kizuna container.

### Cloud Provider Firewalls

If your VPS has an external firewall (DigitalOcean, AWS, etc.), also open the same ports there.

## Step 5: Launch

```bash
docker compose up -d
```

On first run, Caddy will automatically obtain a Let's Encrypt certificate for your domain. This can take 30-60 seconds.

## Step 6: Verify

```bash
# Check containers are running
docker compose ps

# Check logs
docker compose logs kizuna
docker compose logs caddy

# Test HTTPS
curl -I https://chat.example.com/health
```

Visit `https://your-domain.com` and create an account. Congratulations — you're self-hosted!

## Architecture Overview

```
Internet
    │
    ├── :443 (HTTPS) → Caddy → kizuna:5000 (HTTP API + WebSocket)
    │                          │
    │                     TLS termination
    │                     Static file serving (optional)
    │                     Health checks
    │
    └── :40000-40099 (UDP) → Kizuna container (mediasoup WebRTC SFU)
                              │
                         Voice chat media
                         Screen share video
                         Direct P2P when possible
```

Caddy handles all HTTPS concerns — you never touch certificates. The Kizuna server is an internal HTTP service on port 5000, reverse-proxied by Caddy. WebRTC voice traffic bypasses Caddy entirely and goes directly to media ports.

## Directory Layout

```
kizuna/
├── .env              ← Your configuration
├── data/             ← SQLite database (persistent)
├── uploads/          ← Attachments, GIFs, backgrounds (persistent)
├── Caddyfile         ← Reverse proxy config
├── docker-compose.yml
└── apps/             ← Source code (not used at runtime)
```

Your database and uploads survive container recreations and updates.

## Upgrading

```bash
cd kizuna
git pull
docker compose up -d --build
```

For detailed upgrade instructions and breaking change notes, see [Updating](/guide/updating).
