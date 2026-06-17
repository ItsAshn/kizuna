#!/usr/bin/env bash
# ─── Kizuna: migrate from Docker named volumes to bind mounts ───────────────────
#
# Copies data from the old Docker named volumes (kizuna_data, kizuna_uploads) to
# the new bind-mounted directories (./data, ./uploads).
#
# Safe to run multiple times — existing bind-mount data is backed up before
# overwriting.  Requires Docker to be installed and running.
#
# Usage:
#   chmod +x scripts/migrate-volumes.sh
#   ./scripts/migrate-volumes.sh
#
# To specify custom volume names (e.g. if you used a non-default compose project):
#   DATA_VOLUME=myproject_kizuna_data UPLOADS_VOLUME=myproject_kizuna_uploads ./scripts/migrate-volumes.sh
# ─────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/data"
UPLOADS_DIR="$PROJECT_DIR/uploads"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[*]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*"; }

# ─── Detect old named volumes ───────────────────────────────────────────────────

# Try common naming patterns: <project>_kizuna_data / kizuna_kizuna_data
# Docker Compose prefixes volumes with the project name (the directory name).
PROJECT_NAME="$(basename "$PROJECT_DIR")"

DATA_VOL="${DATA_VOLUME:-}"
UPLOADS_VOL="${UPLOADS_VOLUME:-}"

if [ -z "$DATA_VOL" ]; then
  for candidate in "${PROJECT_NAME}_kizuna_data" "kizuna_kizuna_data" "kizuna_data"; do
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      DATA_VOL="$candidate"
      break
    fi
  done
fi

if [ -z "$UPLOADS_VOL" ]; then
  for candidate in "${PROJECT_NAME}_kizuna_uploads" "kizuna_kizuna_uploads" "kizuna_uploads"; do
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      UPLOADS_VOL="$candidate"
      break
    fi
  done
fi

# Debug: list all volumes and their prefixes to help the user
list_volume_prefixes() {
  log "Available Docker volumes:"
  docker volume ls --format '{{.Name}}' 2>/dev/null | while read -r v; do
    echo "    $v"
  done
  echo ""
}

if [ -z "$DATA_VOL" ] && [ -z "$UPLOADS_VOL" ]; then
  warn "No kizuna named volumes found."
  warn "Project directory is: $PROJECT_DIR (project name: $PROJECT_NAME)"
  warn "Searched for: ${PROJECT_NAME}_kizuna_data, kizuna_kizuna_data, kizuna_data"
  echo ""
  list_volume_prefixes
  warn "If your volumes have a different name, specify them manually:"
  warn "  DATA_VOLUME=myvol_data UPLOADS_VOLUME=myvol_uploads $0"
  warn ""
  warn "If you never used the old named-volume setup, you can skip migration."
  exit 0
fi

log "Found volumes:"
[ -n "$DATA_VOL" ]    && log "  Data volume:    $DATA_VOL"
[ -n "$UPLOADS_VOL" ] && log "  Uploads volume: $UPLOADS_VOL"

# ─── Check Docker is available ───────────────────────────────────────────────────

if ! docker info >/dev/null 2>&1; then
  err "Docker is not running or not accessible. Start Docker and try again."
  exit 1
fi

# ─── Create target directories ────────────────────────────────────────────────────

mkdir -p "$DATA_DIR" "$UPLOADS_DIR"

# ─── Backup existing bind-mount data (if any) ──────────────────────────────────────

backup_if_exists() {
  local dir="$1"
  if [ -d "$dir" ] && [ "$(ls -A "$dir" 2>/dev/null)" ]; then
    local backup="${dir}.bak.$(date +%Y%m%d_%H%M%S)"
    log "Backing up existing $dir -> $backup"
    mv "$dir" "$backup"
    mkdir -p "$dir"
  fi
}

backup_if_exists "$DATA_DIR"
backup_if_exists "$UPLOADS_DIR"

# ─── Migrate data volume ──────────────────────────────────────────────────────────

if [ -n "$DATA_VOL" ]; then
  log "Copying $DATA_VOL -> $DATA_DIR ..."
  docker run --rm \
    -v "${DATA_VOL}:/src:ro" \
    -v "${DATA_DIR}:/dst" \
    alpine:latest \
    sh -c 'cp -a /src/. /dst/ 2>/dev/null || true; chown -R 1000:1000 /dst/ 2>/dev/null || true'
  log "Data volume migrated."
else
  warn "No data volume to migrate — skipping."
fi

# ─── Migrate uploads volume ───────────────────────────────────────────────────────

if [ -n "$UPLOADS_VOL" ]; then
  log "Copying $UPLOADS_VOL -> $UPLOADS_DIR ..."
  docker run --rm \
    -v "${UPLOADS_VOL}:/src:ro" \
    -v "${UPLOADS_DIR}:/dst" \
    alpine:latest \
    sh -c 'cp -a /src/. /dst/ 2>/dev/null || true; chown -R 1000:1000 /dst/ 2>/dev/null || true'
  log "Uploads volume migrated."
else
  warn "No uploads volume to migrate — skipping."
fi

# ─── Summary ──────────────────────────────────────────────────────────────────────

echo ""
log "Migration complete."
log "  DB data:     $DATA_DIR"
log "  Uploads:     $UPLOADS_DIR"
echo ""

# ─── Offer to remove old volumes ──────────────────────────────────────────────────

read -r -p "$(echo -e "${YELLOW}[?]${NC} Remove old named volumes? This cannot be undone. [y/N] ")" REMOVE
if [ "${REMOVE,,}" = "y" ] || [ "${REMOVE,,}" = "yes" ]; then
  [ -n "$DATA_VOL" ]    && { docker volume rm "$DATA_VOL" 2>/dev/null || warn "Could not remove $DATA_VOL — it may still be in use."; }
  [ -n "$UPLOADS_VOL" ] && { docker volume rm "$UPLOADS_VOL" 2>/dev/null || warn "Could not remove $UPLOADS_VOL — it may still be in use."; }
  log "Old volumes removed."
else
  warn "Old volumes kept. You can remove them manually later with:"
  [ -n "$DATA_VOL" ]    && warn "  docker volume rm $DATA_VOL"
  [ -n "$UPLOADS_VOL" ] && warn "  docker volume rm $UPLOADS_VOL"
fi

log "You can now run: docker compose up -d"
