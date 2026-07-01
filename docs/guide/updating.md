---
title: Updating
description: How to update your self-hosted Kizuna server. Keep your Discord alternative up to date with Docker or manual upgrade instructions.
---

# Updating

## Docker

```bash
git pull
docker compose up -d --build
```

Your data in `data/` and `uploads/` is preserved across updates (bind mounts).

### Pin to a release

```bash
git fetch --tags
git checkout v0.1.0
docker compose up -d --build
```

## Manual

```bash
git pull
pnpm install
pnpm --filter @kizuna/server build
# Restart the server process
```

## Database

Kizuna uses SQLite and manages schema automatically on startup. No manual migration steps are required.
