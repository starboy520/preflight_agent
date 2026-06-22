#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
API_BASE_URL="${PREFLIGHT_API_BASE_URL:-http://localhost:8000}"
BACKEND_PORT="${PREFLIGHT_BACKEND_PORT:-8000}"
BACKEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

wait_for_backend() {
  for _ in $(seq 1 30); do
    if curl -sf "$API_BASE_URL/health" >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "Backend did not become ready at $API_BASE_URL" >&2
  return 1
}

start_backend_if_needed() {
  if curl -sf "$API_BASE_URL/health" >/dev/null; then
    echo "Backend already running at $API_BASE_URL"
    return 0
  fi

  echo "Starting backend on port $BACKEND_PORT..."
  (
    cd "$BACKEND_DIR"
    .venv/bin/uvicorn app.main:app --port "$BACKEND_PORT"
  ) &
  BACKEND_PID=$!
  wait_for_backend
  echo "Backend started (pid $BACKEND_PID)"
}

echo "==> Backend unit tests"
(
  cd "$BACKEND_DIR"
  .venv/bin/python -m pytest -q
)

start_backend_if_needed

echo "==> Frontend integration tests (live API)"
(
  cd "$FRONTEND_DIR"
  VITE_API_BASE_URL="$API_BASE_URL" npm run test:integration
)

echo "==> Smoke: POST sample plan via curl"
RESPONSE="$(curl -sf -X POST "$API_BASE_URL/api/v1/platform/runtime/agent-runs/preflight" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" \
  --data-binary @"$ROOT_DIR/scripts/fixtures/sample-preflight-request.json")"
DECISION="$(node -e "const b=JSON.parse(process.argv[1]); process.stdout.write(b.decision)" "$RESPONSE")"
if [[ "$DECISION" != "requires_approval" ]]; then
  echo "Unexpected decision from curl smoke test: $DECISION" >&2
  exit 1
fi
echo "curl smoke ok: decision=$DECISION"

echo
echo "All integration checks passed."
