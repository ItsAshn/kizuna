#!/bin/sh
set -e

# Fix ownership of mounted data directories.
# The container starts as root so we can chown before dropping privileges.
mkdir -p /data /app/uploads
chown -R kizuna:kizuna /data /app/uploads 2>/dev/null || true

exec su kizuna -c 'exec node apps/server/dist/index.js'
