#!/usr/bin/env bash
# ─── Kizuna: safe update with health-check-aware rollback ─────────────────────
#
# Pulls the Kizuna image, recreates the container, waits for /health to pass,
# and rolls back to the image that was running before if it does not.
#
# Usage:
#   ./scripts/update.sh
#
# Options:
#   --pin <tag>   Switch to a specific release (e.g. --pin v0.2.0) and stay on
#                 it. Writes KIZUNA_TAG=<tag> to .env, which docker-compose.yml
#                 uses as the image tag. Use --pin latest to go back to
#                 following stable releases.
#   --no-verify   Skip health check after update
#   --dry-run     Show what would happen without making changes
#
# Without --pin the script updates whatever tag .env already selects
# (KIZUNA_TAG, default "latest"). A pinned version tag never changes, so
# updating a pinned install is a no-op until you pin a newer one.
# ────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[*]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*"; }

IMAGE="ghcr.io/itsashn/kizuna"
PIN=""
VERIFY=true
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pin)
      if [[ $# -lt 2 || -z "$2" ]]; then
        err "--pin needs a tag, e.g. --pin v0.2.0"
        exit 1
      fi
      PIN="$2"
      shift 2
      ;;
    --no-verify) VERIFY=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# Docker tag grammar. Also keeps the value safe to write into .env.
if [[ -n "$PIN" && ! "$PIN" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  err "Invalid tag: $PIN"
  exit 1
fi

cd "$PROJECT_DIR"

# ─── .env helpers ───────────────────────────────────────────────────────────────

# Prints the KIZUNA_TAG value from .env, or nothing when unset.
read_env_tag() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E '^[[:space:]]*KIZUNA_TAG=' "$ENV_FILE" | tail -1 \
    | sed -E 's/^[[:space:]]*KIZUNA_TAG=//; s/^["'\'']//; s/["'\'']$//' || true
}

# Sets KIZUNA_TAG in .env, or removes it when given an empty value.
write_env_tag() {
  local value="$1" tmp
  touch "$ENV_FILE"
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  grep -vE '^[[:space:]]*KIZUNA_TAG=' "$ENV_FILE" > "$tmp" || true
  if [ -n "$value" ]; then
    printf 'KIZUNA_TAG=%s\n' "$value" >> "$tmp"
  fi
  # Keep the original file's permissions (it holds JWT_SECRET).
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Runs the health check inside the container, so it works even though the
# compose file does not publish port 5000 to the host. The image is
# node:*-slim, which has node but no curl or wget.
container_healthy() {
  docker compose exec -T kizuna node -e \
    "fetch('http://localhost:'+(process.env.SERVER_PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    > /dev/null 2>&1
}

wait_healthy() {
  local tries="$1"
  for _ in $(seq 1 "$tries"); do
    if container_healthy; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ─── Work out old and new tags ──────────────────────────────────────────────────

OLD_ENV_TAG="$(read_env_tag)"
OLD_TAG="${OLD_ENV_TAG:-latest}"
if [ -n "$PIN" ]; then
  NEW_TAG="$PIN"
else
  NEW_TAG="$OLD_TAG"
fi

if [ "$DRY_RUN" = true ]; then
  log "Dry run — current tag: ${OLD_TAG}, target: ${IMAGE}:${NEW_TAG}"
  if [ "$NEW_TAG" != "$OLD_TAG" ]; then
    log "Would write KIZUNA_TAG=${NEW_TAG} to .env"
  fi
  log "Would pull ${IMAGE}:${NEW_TAG}, recreate the kizuna container and check /health"
  exit 0
fi

# ─── Record the running image for rollback (before anything is pulled) ──────────
#
# Pulling moves the tag (e.g. :latest) to the new image, so the old image has
# to be captured first. The local image ID is what we roll back to; the repo
# digest is a fallback in case the old image was pruned in the meantime.

OLD_IMAGE_ID=""
OLD_DIGEST=""
CONTAINER_ID="$(docker compose ps -q kizuna 2>/dev/null || true)"
if [ -n "$CONTAINER_ID" ]; then
  OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_ID" 2>/dev/null || true)"
fi
if [ -n "$OLD_IMAGE_ID" ]; then
  OLD_DIGEST="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$OLD_IMAGE_ID" 2>/dev/null \
    | grep -oE 'sha256:[a-f0-9]{64}' | head -1 || true)"
  log "Current image: ${OLD_IMAGE_ID}${OLD_DIGEST:+ (${OLD_DIGEST})}"
else
  warn "No running kizuna container found; rollback will not be possible."
fi

restore_env_tag() {
  write_env_tag "$OLD_ENV_TAG"
}

# ─── Switch tag and pull ────────────────────────────────────────────────────────

if [ "$NEW_TAG" != "$OLD_TAG" ]; then
  if [ "$NEW_TAG" = "latest" ]; then
    log "Unpinning: following ${IMAGE}:latest again"
    write_env_tag ""
  else
    log "Pinning to ${IMAGE}:${NEW_TAG} (KIZUNA_TAG in .env)"
    write_env_tag "$NEW_TAG"
  fi
fi

log "Pulling ${IMAGE}:${NEW_TAG} ..."
if ! docker compose pull kizuna 2>&1; then
  err "Failed to pull image. Is Docker running, and does the tag exist?"
  restore_env_tag
  exit 1
fi

# ─── Recreate container ──────────────────────────────────────────────────────────

log "Recreating kizuna container ..."
if ! docker compose up -d --no-deps kizuna 2>&1; then
  err "Failed to recreate container."
  restore_env_tag
  exit 1
fi

# ─── Health check ────────────────────────────────────────────────────────────────

if [ "$VERIFY" = false ]; then
  log "Health check skipped (--no-verify)."
  log "Update complete."
  exit 0
fi

log "Waiting for /health to respond (up to 60s) ..."

if wait_healthy 30; then
  log "Health check passed. Update complete (${IMAGE}:${NEW_TAG})."
  exit 0
fi

err "Health check failed after 60s."

if [ -z "$OLD_IMAGE_ID" ]; then
  warn "No previous image recorded, so there is nothing to roll back to."
  warn "Check logs with: docker compose logs kizuna"
  exit 1
fi

# ─── Roll back ───────────────────────────────────────────────────────────────────

warn "Rolling back to the previous image (${OLD_IMAGE_ID}) ..."

if ! docker image inspect "$OLD_IMAGE_ID" > /dev/null 2>&1; then
  if [ -n "$OLD_DIGEST" ]; then
    warn "Previous image is gone locally; pulling ${IMAGE}@${OLD_DIGEST} ..."
    docker pull "${IMAGE}@${OLD_DIGEST}" || true
    OLD_IMAGE_ID="${IMAGE}@${OLD_DIGEST}"
  fi
fi

# Point the old tag back at the old image, then restore .env, so compose
# recreates the container from exactly what was running before.
if docker tag "$OLD_IMAGE_ID" "${IMAGE}:${OLD_TAG}" 2>/dev/null; then
  restore_env_tag
  docker compose up -d --no-deps kizuna 2>&1 || true

  if wait_healthy 15; then
    log "Rollback successful. Server is healthy on the previous image."
    if [ "$OLD_TAG" = "latest" ]; then
      warn "Watchtower (if enabled) will pull the new :latest again within the hour."
      warn "To stay on the working version, pin it: ./scripts/update.sh --pin <previous version>"
    fi
  else
    warn "Rollback may not have fully recovered. Check logs with: docker compose logs kizuna"
  fi
else
  restore_env_tag
  warn "Could not restore the previous image. Check logs with: docker compose logs kizuna"
fi

exit 1
