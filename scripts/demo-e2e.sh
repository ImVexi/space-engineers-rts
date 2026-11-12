#!/usr/bin/env bash
# End-to-end check for the TEST-LOCKED demo site.
# Ports 8763 (backend) and 8764 (site preview) only. Everything is killed by PID.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DATA_DIR="data/demo-e2e"
LOG_DIR="$DATA_DIR/logs"
rm -rf "$DATA_DIR"
mkdir -p "$LOG_DIR"

BACKEND_PID=""
SITE_PID=""

kill_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

kill_port() {
  local port="$1"
  local pids
  pids=$(ss -ltnp 2>/dev/null | grep -E ":$port\\b" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  for pid in $pids; do kill_tree "$pid"; done
}

cleanup() {
  set +e
  kill_tree "$SITE_PID"
  kill_tree "$BACKEND_PID"
  kill_port 8763
  kill_port 8764
  for _ in $(seq 1 20); do
    if ! ss -ltn 2>/dev/null | grep -qE ':(8763|8764)\b'; then break; fi
    sleep 0.25
  done
}
trap cleanup EXIT

echo "[demo:e2e] starting backend on 127.0.0.1:8763 (test lock)"
RTS_DEMO=1 \
RTS_ENV=test \
RTS_TEST_SERVER_MARKER=se-rts-test \
RTS_BIND=127.0.0.1 \
RTS_PORT=8763 \
RTS_DATA_DIR="$DATA_DIR" \
RTS_DB_PATH="$DATA_DIR/rts.db" \
npx tsx packages/backend/src/index.ts >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8763/api/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:8763/api/health >/dev/null || { echo "[demo:e2e] backend failed"; cat "$LOG_DIR/backend.log"; exit 1; }

echo "[demo:e2e] building site (VITE_DEMO_ENV=test, VITE_DEMO_API_BASE=/api)"
(
  cd packages/demo-site
  VITE_DEMO_ENV=test VITE_DEMO_API_BASE=/api npx vite build >"$ROOT/$LOG_DIR/site-build.log" 2>&1
)

echo "[demo:e2e] starting site preview on 127.0.0.1:8764"
DEMO_BACKEND_PORT=8763 npm --workspace @se-rts/demo-site run preview >"$LOG_DIR/site.log" 2>&1 &
SITE_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8764/ >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:8764/ >/dev/null || { echo "[demo:e2e] site failed"; cat "$LOG_DIR/site.log"; exit 1; }

echo "[demo:e2e] running Playwright"
python3 packages/demo-site/e2e/demo_site.py

echo "[demo:e2e] stopping servers"
cleanup
if ss -ltnp | grep -qE ':(8763|8764)\b'; then
  echo "[demo:e2e] FAIL: listeners still present"
  ss -ltnp | grep -E ':(8763|8764)\b'
  exit 1
fi
echo "[demo:e2e] ports 8763/8764 are free"
