#!/usr/bin/env bash
set -euo pipefail

PORT="${AGENT_CONSOLE_PORT:-8765}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${PORT}/tcp" 2>/dev/null || true
  fi
}

PIDS="$(port_pids | tr ' ' '\n' | sed '/^$/d' | sort -u)"
if [[ -z "$PIDS" ]]; then
  echo "Agent Console is not running."
  exit 0
fi

TARGETS=""
while IFS= read -r pid; do
  CMD="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [[ "$CMD" == *"$ROOT"* || "$CMD" == *"server.ts"* ]]; then
    TARGETS="${TARGETS} ${pid}"
  else
    echo "Port $PORT is used by another process. Not stopping PID $pid: $CMD"
  fi
done <<< "$PIDS"

if [[ -n "${TARGETS// }" ]]; then
  kill $TARGETS
  echo "Agent Console stopped."
  exit 0
fi

echo "Agent Console process was not found on port $PORT."
exit 1
