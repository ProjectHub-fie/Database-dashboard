#!/usr/bin/env bash
# Run a DB Horizon API instance with a supervisor loop.
#
# The public workspace hosts (work-1 / work-2) proxy to fixed ports, and the
# Vercel deployment proxies /api to one of them. If the node process dies the
# whole app starts returning 502, so this wrapper restarts it and keeps the log
# in .runtime/ (which survives container restarts, unlike /tmp).
#
#   scripts/serve-live.sh 12000
#
# Not for production deployments — use a real process manager there.
set -u

PORT="${1:?usage: serve-live.sh <port>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/.runtime"
LOG="$RUNTIME/api-$PORT.log"

mkdir -p "$RUNTIME/data-$PORT" "$RUNTIME"

cd "$ROOT/packages/server" || exit 1

while true; do
  echo "=== $(date -Is) starting API on :$PORT ===" >> "$LOG"
  PORT="$PORT" \
  HOST=0.0.0.0 \
  NODE_ENV=production \
  AUTH_REQUIRED=false \
  SERVE_CLIENT=true \
  DATA_DIR="$RUNTIME/data-$PORT" \
  node dist/index.js >> "$LOG" 2>&1
  code=$?
  echo "=== $(date -Is) API on :$PORT exited ($code), restarting in 2s ===" >> "$LOG"
  sleep 2
done
