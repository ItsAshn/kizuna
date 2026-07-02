---
title: Updating
description: How to update your self-hosted Kizuna server. Keep your Discord alternative up to date with Docker or manual upgrade instructions.
---

# Updating

## Automatic (recommended)

The compose file ships with [Watchtower](https://github.com/containrrr/watchtower), which polls `ghcr.io/itsashn/kizuna` every hour and automatically restarts the Kizuna container when a new image is available. No manual intervention needed.

To disable, remove the `watchtower` service from your `docker-compose.yml`.

## Manual update via pre-built image

```bash
docker compose pull && docker compose up -d
```

The pre-built image is pulled from `ghcr.io/itsashn/kizuna:latest`. No build tools or source code needed on your server. Your data in `data/` and `uploads/` is preserved across updates (bind mounts).

### Safe update with rollback

```bash
./scripts/update.sh                 # latest version
./scripts/update.sh --pin v0.2.0   # pin to a specific release tag
```

The script pulls the image, recreates the container, waits for the `/health` endpoint to respond, and rolls back to the previous image if the health check fails.

### Pin to a release

Edit `docker-compose.yml` and change the image tag:

```yaml
services:
  kizuna:
    image: ghcr.io/itsashn/kizuna:v0.2.0
```

Then:

```bash
docker compose pull && docker compose up -d
```

## Development builds (local compilation)

If you need to build from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Manual (without Docker)

```bash
git pull
pnpm install
pnpm --filter @kizuna/server build
# Restart the server process
```

## Database

Kizuna uses SQLite and manages schema automatically on startup. No manual migration steps are required.
