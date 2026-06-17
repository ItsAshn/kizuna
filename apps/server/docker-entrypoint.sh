#!/bin/sh
set -e

# Fix ownership of mounted data directories.
# The container starts as root so we can chown before dropping privileges.
mkdir -p /data /app/uploads
chown kizuna:kizuna /data /app/uploads 2>/dev/null || true

exec gosu kizuna node apps/server/dist/index.js
