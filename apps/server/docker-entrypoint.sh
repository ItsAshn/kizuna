#!/bin/sh
set -e

# Fix ownership of mounted data directories.
# The container starts as root so we can chown before dropping privileges.
mkdir -p /data /app/uploads

# Recursive chown for /data (SQLite DB files) — fast since it's small.
# For /app/uploads, only fix files that aren't already owned by kizuna.
chown -R kizuna:kizuna /data 2>/dev/null || true
chown kizuna:kizuna /app/uploads 2>/dev/null || true
find /app/uploads -not -user kizuna -exec chown kizuna:kizuna {} + 2>/dev/null || true

exec gosu kizuna node apps/server/dist/index.js
