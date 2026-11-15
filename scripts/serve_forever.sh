#!/usr/bin/env bash
# Keeps the Jira Pulse server running. Restarts it if the process exits OR stops answering
# (3 failed health checks in a row, about 1 minute). Runs detached, so it survives closing the terminal.
#
#   make up       start in the background      make down     stop it
#   make status   is it up?                    logs          logs/server.log
#
# The server runs with --reload, so code edits in src/ are picked up without a restart.
# logs/watchdog.pid is simply overwritten on every start; "is it running" = is that process alive.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8010}"
LOG="logs/server.log"
mkdir -p logs
echo $$ > logs/watchdog.pid
# Keep the Mac awake (no idle / system sleep) for as long as this watchdog runs. caffeinate is built into macOS,
# changes no settings, and stops by itself when the watchdog stops (`make down`). Closing a MacBook lid still sleeps it.
caffeinate -ims -w $$ &
set -m                      # job control: the server gets its own process group, so we can stop it AND its reload worker

SERVER_PID=""
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill -TERM -- "-$SERVER_PID" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$SERVER_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$SERVER_PID" 2>/dev/null
}

trap 'stop_server; log "watchdog stopped"; exit 0' INT TERM

while true; do
  # keep the log small: one 5 MB rotation
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 5000000 ]; then mv "$LOG" "$LOG.1"; fi
  log "starting server on :$PORT"
  .venv/bin/uvicorn jira_pm.server:app --host 127.0.0.1 --port "$PORT" --reload --reload-dir src --no-access-log >> "$LOG" 2>&1 &
  SERVER_PID=$!
  fails=0
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sleep 20
    if curl -s -m 15 -o /dev/null -f "http://127.0.0.1:$PORT/api/health"; then fails=0; else fails=$((fails + 1)); fi
    if [ "$fails" -ge 3 ]; then
      log "server not answering for about a minute - restarting"
      stop_server
      break
    fi
  done
  log "server stopped - restarting in 3 s"
  sleep 3
done
