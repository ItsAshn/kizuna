# Updating

Keep your Kizuna server up to date with the latest features and security fixes.

## Docker (recommended)

```bash
cd /path/to/kizuna
git pull
docker compose up -d --build
```

This pulls the latest code, rebuilds the container image, and recreates the containers. Your data in `data/` and `uploads/` is preserved (bind mounts).

### Before Updating

1. **Back up your data** — see [Infrastructure > Backup Strategy](/guide/infrastructure#backup-strategy)
2. **Check the changelog** — review [GitHub Releases](https://github.com/ItsAshn/kizuna/releases) for breaking changes
3. **Test on a staging instance** if you run a large community

### Rollback

If an update causes issues:

```bash
git checkout <previous-tag>
docker compose up -d --build
```

Releases are tagged as `v0.1.0`, `v0.2.0`, etc.

## Manual (non-Docker)

```bash
cd /opt/kizuna
git pull
pnpm install
pnpm --filter @kizuna/server build
sudo systemctl restart kizuna
```

## Pin to Specific Version

To avoid surprises, pin to a release tag instead of tracking `main`:

```bash
git fetch --tags
git checkout v0.1.0
docker compose up -d --build
```

## Database Migrations

Kizuna uses SQLite and manages schema automatically on startup. No manual migration steps are required. The server creates tables and adds columns as needed when it boots.

If you ever need to roll back past a schema change, restore from your most recent backup.

## Checking Version

To see what version you're running:

```bash
# Docker
docker compose exec kizuna node -e "console.log(require('./apps/server/package.json').version)"

# Manual (systemd)
sudo journalctl -u kizuna -n 50 | grep -i version
```

The server logs its version on startup.
