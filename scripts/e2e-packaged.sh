#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE_DIR=${E2E_STATE_DIR:-/tmp/opencode}
PIDFILE=${E2E_PIDFILE:-$STATE_DIR/pi-desktop-packaged-e2e.pid}
LOGFILE=${E2E_LOGFILE:-$STATE_DIR/pi-desktop-packaged-e2e.log}
SCREENSHOT=${E2E_SCREENSHOT:-$ROOT_DIR/.playwright-mcp/e2e-packaged.png}
DISPLAY_VALUE=${DISPLAY:-:0.0}
MSG=${MSG:-}

mkdir -p "$STATE_DIR" "$(dirname "$SCREENSHOT")"

fail() {
  printf 'e2e-packaged: %s\n' "$*" >&2
  printf 'e2e-packaged: log: %s\n' "$LOGFILE" >&2
  exit 1
}

read_state() {
  [[ -r "$PIDFILE" ]] || return 1
  # shellcheck disable=SC1090
  source "$PIDFILE"
  [[ ${PID:-} =~ ^[0-9]+$ && ${PORT:-} =~ ^[0-9]+$ && ${PGID:-} =~ ^[0-9]+$ ]]
}

stop_running() {
  read_state || { rm -f "$PIDFILE"; return 0; }
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    return 0
  fi

  local cwd cmdline
  cwd=$(readlink -f "/proc/$PID/cwd" 2>/dev/null || true)
  cmdline=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)
  [[ "$cwd" == "$ROOT_DIR" ]] || fail "refusing to stop PID $PID: cwd is '$cwd'"
  [[ "$cmdline" == *"--remote-debugging-port=$PORT"* ]] || fail "refusing to stop PID $PID: command line is '$cmdline'"

  kill -TERM -- "-$PGID" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL -- "-$PGID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

if [[ ${1:-} == stop ]]; then
  stop_running
  exit 0
fi

[[ -n "$MSG" ]] || fail 'MSG is required, e.g. make e2e-packaged MSG="Reply with PONG"'
read_state && fail "existing packaged E2E is running; use 'make e2e-stop' first"

APPIMAGE=$(ls -t "$ROOT_DIR"/release/*.AppImage 2>/dev/null | head -n1 || true)
[[ -n "$APPIMAGE" && -x "$APPIMAGE" ]] || fail "no executable AppImage under release/; run 'make dist-linux' first"

PORT=''
for candidate in $(shuf -i 9222-9399 -n 40); do
  if ! ss -ltnH "sport = :$candidate" | grep -q .; then
    PORT=$candidate
    break
  fi
done
[[ -n "$PORT" ]] || fail "could not find a free CDP port"
if ss -ltnH "sport = :$PORT" | grep -q .; then
  fail "selected CDP port $PORT became occupied before launch"
fi

USER_DATA_DIR="$STATE_DIR/pi-desktop-packaged-e2e-$PORT"
rm -rf "$USER_DATA_DIR"
: > "$LOGFILE"
printf 'E2E port=%s app=%s log=%s screenshot=%s\n' "$PORT" "$APPIMAGE" "$LOGFILE" "$SCREENSHOT"

setsid env DISPLAY="$DISPLAY_VALUE" nohup "$APPIMAGE" \
  --no-sandbox --disable-gpu --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  >"$LOGFILE" 2>&1 < /dev/null &
PID=$!
PGID=$PID
printf 'PID=%s\nPORT=%s\nPGID=%s\n' "$PID" "$PORT" "$PGID" > "$PIDFILE"

cleanup() {
  stop_running || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in {1..300}; do
  kill -0 "$PID" 2>/dev/null || fail "packaged app exited before CDP readiness"
  if npx tsx "$ROOT_DIR/scripts/cdp-drive.ts" "$PORT" ready 1000 >> "$LOGFILE" 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" == 1 ]] || fail "packaged app did not become CDP-ready; inspect $LOGFILE"

npx tsx "$ROOT_DIR/scripts/cdp-drive.ts" "$PORT" chat "$MSG" "$SCREENSHOT" >> "$LOGFILE" 2>&1 \
  || fail "packaged E2E failed; inspect $LOGFILE"
[[ -s "$SCREENSHOT" ]] || fail "CDP reported success but screenshot is missing or empty"
printf 'E2E_OK screenshot=%s log=%s\n' "$SCREENSHOT" "$LOGFILE"
