---
title: Updating
description: How to update your self-hosted Kizuna server. Keep your Discord alternative up to date with Docker or manual upgrade instructions.
---

# Updating

## Automatic (recommended)

The compose file ships with [Watchtower](https://github.com/containrrr/watchtower), which polls `ghcr.io/itsashn/kizuna` every hour and automatically restarts the Kizuna container when a new image is available. No manual intervention needed.

Watchtower follows the `latest` tag. That tag only moves for stable releases (`vX.Y.Z`) that passed CI; release candidates and betas are published under their own tag and never reach auto-updating servers.

To disable, remove the `watchtower` service from your `docker-compose.yml`.

## Manual update via pre-built image

```bash
docker compose pull && docker compose up -d
```

The pre-built image is pulled from `ghcr.io/itsashn/kizuna:latest`. No build tools or source code needed on your server. Your data in `data/` and `uploads/` is preserved across updates (bind mounts).

### Safe update with rollback

```bash
./scripts/update.sh                 # update the tag you are on (latest by default)
./scripts/update.sh --pin v0.2.0   # switch to a specific release and stay there
./scripts/update.sh --pin latest   # go back to following stable releases
```

The script records the running image, pulls the new one, recreates the container, checks `/health` from inside the container, and rolls back to the recorded image if the check fails.

### Pin to a release

The image tag comes from `KIZUNA_TAG` in `.env` (default `latest`). Either run `./scripts/update.sh --pin v0.2.0`, or set it yourself:

```bash
KIZUNA_TAG=v0.2.0
```

Then:

```bash
docker compose pull && docker compose up -d
```

A version tag never changes, so Watchtower leaves a pinned server alone.

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
