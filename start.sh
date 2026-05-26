#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${AGENT_CONSOLE_PORT:-8765}"
URL="http://127.0.0.1:${PORT}"

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${PORT}/tcp" 2>/dev/null || true
  fi
}

PIDS="$(port_pids | tr ' ' '\n' | sed '/^$/d' | sort -u)"
if [[ -n "$PIDS" ]]; then
  MATCHED=""
  while IFS= read -r pid; do
    CMD="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$CMD" == *"$ROOT"* || "$CMD" == *"server.ts"* ]]; then
      MATCHED=1
    fi
  done <<< "$PIDS"
  if [[ -z "$MATCHED" ]]; then
    echo "Port $PORT is already used by another process:"
    while IFS= read -r pid; do
      ps -p "$pid" -o pid=,args= 2>/dev/null || true
    done <<< "$PIDS"
    exit 1
  fi
  echo "Agent Console is already running: $URL"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  fi
  exit 0
fi

(
  sleep 2
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  fi
) &

bun run start
