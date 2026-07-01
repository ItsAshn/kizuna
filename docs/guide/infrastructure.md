# Infrastructure

Guidance for running Kizuna in production beyond the basic Docker setup.

## Reverse Proxy Alternatives

### Caddy (default, recommended)

Caddy is bundled with the Docker Compose setup. It handles TLS automatically with zero configuration beyond setting `DOMAIN`.

Benefits:
- Automatic Let's Encrypt certificates
- Automatic HTTP → HTTPS redirects
- Health checks for the backend
- Simple, auditable config

### Nginx

If you already run Nginx, omit the `caddy` service from `docker-compose.yml` and add a server block:

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

The WebSocket upgrade headers are critical — voice channel signaling uses WebSockets.

### Behind Cloudflare

If your domain uses Cloudflare:

1. Set SSL/TLS mode to **Full (strict)**
2. Disable Cloudflare proxying (orange cloud → gray cloud) — WebRTC UDP doesn't work through Cloudflare's proxy
3. Alternatively, use a separate subdomain for voice if you need Cloudflare CDN on the web app

## Manual Deployment with Systemd

If you prefer running without Docker:

```bash
git clone https://github.com/ItsAshn/kizuna.git /opt/kizuna
cd /opt/kizuna
pnpm install
cp .env.example apps/server/.env
# Edit apps/server/.env
pnpm --filter @kizuna/server build
```

Create a systemd service at `/etc/systemd/system/kizuna.service`:

```ini
[Unit]
Description=Kizuna Server
After=network.target

[Service]
Type=simple
User=kizuna
WorkingDirectory=/opt/kizuna
Environment=NODE_ENV=production
EnvironmentFile=/opt/kizuna/apps/server/.env
ExecStart=/usr/bin/node /opt/kizuna/apps/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /bin/false kizuna
sudo chown -R kizuna:kizuna /opt/kizuna
sudo systemctl daemon-reload
sudo systemctl enable --now kizuna
```

## Backup Strategy

Kizuna stores all data in two directories:

| Directory | Contents | Critical? |
|---|---|---|
| `data/` | SQLite database (messages, users, channels, settings) | Yes |
| `uploads/` | Attachments, GIFs, server backgrounds | Depends on your use |

### Simple Backup Script

```bash
#!/bin/bash
# /opt/kizuna/scripts/backup.sh
BACKUP_DIR="/opt/backups/kizuna"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# Copy the database safely (SQLite supports this while running)
cd /opt/kizuna
sqlite3 data/server.db ".backup '$BACKUP_DIR/server_$TIMESTAMP.db'"

# Archive uploads
tar -czf "$BACKUP_DIR/uploads_$TIMESTAMP.tar.gz" -C /opt/kizuna uploads/

# Keep last 7 days
find "$BACKUP_DIR" -mtime +7 -delete
```

Add a cron job:

```bash
0 3 * * * /opt/kizuna/scripts/backup.sh  # Runs daily at 3 AM
```

### Docker Backup

For Docker deployments, simply backing up the `data/` and `uploads/` directories is sufficient since they're bind mounts:

```bash
cd /path/to/kizuna
tar -czf /tmp/kizuna-backup.tar.gz data/ uploads/
```

## Monitoring

### Health Check Endpoint

Kizuna exposes `GET /health` which returns `200 OK` when running. Caddy uses this internally, and you can use it with any monitoring tool:

```bash
curl -f https://chat.example.com/health && echo "UP" || echo "DOWN"
```

### Uptime Kuma

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is a self-hosted status monitor. Add a monitor:
- Type: HTTP(s)
- URL: `https://chat.example.com/health`
- Heartbeat interval: 60s

### Docker Health

The Docker container has a built-in `HEALTHCHECK` that tests the `/health` endpoint. Check status:

```bash
docker compose ps
# Healthy containers show "(healthy)" in the status column
```

## Resource Guidelines

| Users | RAM | CPU | Disk | Notes |
|---|---|---|---|---|
| 1-50 | 512 MB | 2 cores | 1-5 GB | Baseline |
| 50-200 | 1 GB | 2 cores | 5-20 GB | Voice usage increases |
| 200-500 | 2 GB | 4 cores | 20-50 GB | Consider SSD storage |
| 500+ | 4 GB+ | 4+ cores | 50 GB+ | Scale vertically first |

Voice/video is the primary resource consumer. Each active voice participant in a channel consumes ~100-300 kbps of bandwidth and marginal server CPU for the SFU. Text-only usage is extremely lightweight.

## Security Hardening

```bash
# Auto security updates (Ubuntu/Debian)
sudo apt install unattended-upgrades
sudo dpkg-reconfigure unattended-upgrades

# Fail2ban for brute-force protection
sudo apt install fail2ban
# Caddy logs to stdout — consider adding fail2ban rules for API auth endpoints

# Disable root SSH login
sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Use SSH keys only
# Add your key, then:
sudo sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
```
