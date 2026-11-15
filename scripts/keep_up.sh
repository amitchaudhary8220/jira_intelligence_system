#!/usr/bin/env bash
# Install / remove the two launchd jobs that keep Jira Pulse shared from this Mac (make keep-up / make keep-down):
#   com.jirapulse.watchdog  every minute + at login: start Docker if needed, repair the tunnel if the address is down
#   com.jirapulse.awake     caffeinate -s: no system sleep while on power (the screen can still turn off)
set -euo pipefail
cd "$(dirname "$0")/.."
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
JOBS=(com.jirapulse.watchdog com.jirapulse.awake)

case "${1:-install}" in
  install)
    mkdir -p data "$AGENTS"
    for job in "${JOBS[@]}"; do
      cp "deploy/$job.plist" "$AGENTS/$job.plist"
      launchctl bootout "$DOMAIN/$job" 2>/dev/null || true
      launchctl bootstrap "$DOMAIN" "$AGENTS/$job.plist"
    done
    echo "Installed: watchdog (every minute) + keep-awake on power. Repairs are logged in data/watchdog.log"
    ;;
  uninstall)
    for job in "${JOBS[@]}"; do
      launchctl bootout "$DOMAIN/$job" 2>/dev/null || true
      [ -f "$AGENTS/$job.plist" ] && mv "$AGENTS/$job.plist" "data/$job.plist.disabled"
    done
    echo "Stopped. The Mac can sleep again; sharing keeps running until: make unshare"
    ;;
  *) echo "usage: $0 install|uninstall"; exit 1 ;;
esac
