#!/usr/bin/env bash
# ─── Kizuna: safe update with health-check-aware rollback ─────────────────────
#
# Pulls the latest Docker image, recreates the container, waits for /health to
# pass, and rolls back on failure.
#
# Usage:
#   ./scripts/update.sh
#
# Options:
#   --pin <tag>   Update to a specific version (e.g. --pin v0.2.0)
#   --no-verify   Skip health check after update
#   --dry-run     Show what would happen without making changes
# ────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[*]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*"; }

IMAGE="ghcr.io/itsashn/kizuna"
TAG="latest"
VERIFY=true
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pin) TAG="$2"; shift 2 ;;
    --no-verify) VERIFY=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

cd "$PROJECT_DIR"

if [ "$DRY_RUN" = true ]; then
  log "Dry run — would pull ${IMAGE}:${TAG} and recreate kizuna container"
  exit 0
fi

# ─── Pull latest image ──────────────────────────────────────────────────────────

log "Pulling ${IMAGE}:${TAG} ..."
if ! docker compose pull kizuna 2>&1; then
  err "Failed to pull image. Is Docker running?"
  exit 1
fi

# ─── Record current image digest for rollback ────────────────────────────────────

CURRENT_IMAGE=$(docker inspect "$IMAGE:$TAG" --format '{{.RepoDigests}}' 2>/dev/null || echo "")
if [ -n "$CURRENT_IMAGE" ]; then
  CURRENT_DIGEST=$(echo "$CURRENT_IMAGE" | grep -oP 'sha256:[a-f0-9]+' | head -1 || echo "")
else
  CURRENT_DIGEST=""
fi

# ─── Recreate container ──────────────────────────────────────────────────────────

log "Recreating kizuna container ..."
if ! docker compose up -d --no-deps kizuna 2>&1; then
  err "Failed to recreate container."
  exit 1
fi

# ─── Health check ────────────────────────────────────────────────────────────────

if [ "$VERIFY" = false ]; then
  log "Health check skipped (--no-verify)."
  log "Update complete."
  exit 0
fi

log "Waiting for /health to respond (up to 60s) ..."

PORT="${SERVER_PORT:-5000}"
HEALTHY=false

for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [ "$HEALTHY" = true ]; then
  log "Health check passed. Update complete."
else
  err "Health check failed after 60s."

  if [ -n "$CURRENT_DIGEST" ]; then
    warn "Rolling back to previous image ($CURRENT_DIGEST) ..."
    docker pull "$IMAGE@$CURRENT_DIGEST" 2>/dev/null || true
    docker compose up -d --no-deps kizuna 2>/dev/null || true

    # Quick health check on rollback
    sleep 5
    if curl -fsS "http://localhost:${PORT}/health" > /dev/null 2>&1; then
      log "Rollback successful. Server is healthy on the previous version."
    else
      warn "Rollback may not have fully recovered. Check logs with: docker compose logs kizuna"
    fi
  else
    warn "No previous image digest available for rollback."
    warn "Check logs with: docker compose logs kizuna"
  fi

  exit 1
fi
