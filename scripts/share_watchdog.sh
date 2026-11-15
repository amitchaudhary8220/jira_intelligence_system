#!/usr/bin/env bash
# Keeps Jira Pulse shared from this Mac. launchd runs it every minute (and at login): see `make keep-up`.
#   - Docker not running (e.g. after a reboot)  -> start Docker Desktop, wait for it
#   - public address not answering              -> scripts/share_local.sh check repairs it (fresh tunnel + Worker re-point)
# Only repairs are written to data/watchdog.log; a healthy minute writes nothing.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 0
mkdir -p data
LOG=data/watchdog.log
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

# one run at a time (a repair can take a couple of minutes)
LOCK=data/.watchdog.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null   # stale lock from a crash
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if ! docker info >/dev/null 2>&1; then
  echo "$(date '+%F %T') Docker not running - starting Docker Desktop" >> "$LOG"
  open -ga Docker
  for _ in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 4; done
  docker info >/dev/null 2>&1 || { echo "$(date '+%F %T') Docker still not up, will retry" >> "$LOG"; exit 0; }
fi

out="$(scripts/share_local.sh check 2>&1)"
[ "$out" = "ok" ] || echo "$out" >> "$LOG"
