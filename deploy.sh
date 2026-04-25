#!/usr/bin/env bash
# Native (non-Docker) redeploy for Claude Code Web GUI.
#   - ui:          next start -p 2000   (PID -> pids/ui.pid, log -> logs/ui.log)
#   - ws-gateway:  node dist/index.js   (PORT=2001, PID -> pids/ws.pid, log -> logs/ws.log)
#
# Usage:
#   ./deploy.sh                full pipeline (pull + install + build + restart)
#   ./deploy.sh --no-pull      skip git pull (e.g. running with local edits)
#   ./deploy.sh --no-install   skip yarn install
#   ./deploy.sh --restart-only just bounce the running processes
#   ./deploy.sh --ui|--ws      only redeploy that service

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

UI_PORT="${UI_PORT:-2000}"
WS_PORT="${WS_PORT:-2001}"

DO_PULL=1
DO_INSTALL=1
DO_BUILD=1
DO_RESTART=1
ONLY=""   # "" | "ui" | "ws"

for arg in "$@"; do
  case "$arg" in
    --no-pull)     DO_PULL=0 ;;
    --no-install)  DO_INSTALL=0 ;;
    --no-build)    DO_BUILD=0 ;;
    --restart-only) DO_PULL=0; DO_INSTALL=0; DO_BUILD=0 ;;
    --ui)          ONLY="ui" ;;
    --ws)          ONLY="ws" ;;
    -h|--help)     sed -n '1,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

want() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# 1) git pull (skip if dirty — preserve WIP)
if (( DO_PULL )); then
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "working tree has local changes — skipping 'git pull' to protect WIP"
  else
    log "git pull --ff-only"
    git pull --ff-only
  fi
fi

# 2) install
if (( DO_INSTALL )); then
  if want ui; then log "yarn install (ui)";          (cd ui          && yarn install --immutable); fi
  if want ws; then log "yarn install (ws-gateway)";  (cd ws-gateway  && yarn install --immutable); fi
fi

# 3) build
if (( DO_BUILD )); then
  if want ui; then log "yarn build (ui)";            (cd ui          && yarn build); fi
  if want ws; then log "yarn build (ws-gateway)";    (cd ws-gateway  && yarn build); fi
fi

# 4) load .env so ws-gateway (and any non-Next consumer) sees secrets
if [[ -f .env ]]; then
  # `.env` values may legitimately reference unset vars; relax nounset for sourcing only.
  set +u
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  set -u
else
  warn ".env not found — services may fail to boot (SESSION_SECRET, SHARED_PASSWORD required)"
fi

# Enable monitor mode so each backgrounded service runs in its own process
# group; that lets us signal yarn + its node child together via `kill -- -PID`.
set -m

# Send a signal to a service's whole process group, falling back to the
# single pid if the group is already gone (children re-parented).
_kill_group() {
  local sig="$1" pid="$2"
  kill "-$sig" -- "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}

stop_svc() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  rm -f "$pidfile"
  [[ -n "${pid:-}" ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    log "$name pidfile was stale (pid $pid not running)"
    return 0
  fi
  log "stopping $name (pgid $pid)"
  _kill_group TERM "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not exit on TERM — sending KILL"
    _kill_group KILL "$pid"
  fi
}

start_ui() {
  log "starting ui on :$UI_PORT"
  pushd "$ROOT/ui" >/dev/null
  nohup yarn start -p "$UI_PORT" >> "$LOG_DIR/ui.log" 2>&1 &
  local pid=$!
  popd >/dev/null
  disown 2>/dev/null || true
  echo "$pid" > "$PID_DIR/ui.pid"
}

start_ws() {
  log "starting ws-gateway on :$WS_PORT"
  pushd "$ROOT/ws-gateway" >/dev/null
  PORT="$WS_PORT" nohup yarn start >> "$LOG_DIR/ws.log" 2>&1 &
  local pid=$!
  popd >/dev/null
  disown 2>/dev/null || true
  echo "$pid" > "$PID_DIR/ws.pid"
}

# 5) restart
if (( DO_RESTART )); then
  if want ui; then stop_svc ui; start_ui; fi
  if want ws; then stop_svc ws; start_ws; fi
fi

# 6) health check (give Next.js a moment to bind)
sleep 2
check_port() {
  local port="$1" name="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "$name listening on :$port  ✓"
  else
    fail "$name is NOT listening on :$port — see $LOG_DIR/$name.log"
  fi
}

if want ui; then check_port "$UI_PORT" ui; fi
if want ws; then check_port "$WS_PORT" ws; fi

log "done. tail logs with: tail -f logs/ui.log logs/ws.log"
