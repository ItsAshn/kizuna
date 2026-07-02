#!/bin/sh
set -e
mkdir -p /data /app/uploads 2>/dev/null || true
exec node dist/index.js
