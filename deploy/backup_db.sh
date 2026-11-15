#!/usr/bin/env bash
# Nightly backup of Jira Pulse's own database (time-log reasons + chat history; Jira data lives in Jira).
# Installed as a cron job by `make deploy` (21:00 UTC = 02:30 IST). Keeps the last 14 daily copies in
# the data volume: /app/data/backups/chats-YYYY-MM-DD.sqlite3. Uses SQLite's online backup, so it's safe while the app runs.
#
# Restore one (on the VM):
#   docker compose --profile google stop jira-pulse
#   docker run --rm -v jira-pulse_chat-data:/d alpine cp /d/backups/chats-YYYY-MM-DD.sqlite3 /d/chats.sqlite3
#   docker compose --profile google up -d
set -euo pipefail
docker exec -i jira-pulse-jira-pulse-1 .venv/bin/python - <<'PY'
import datetime, pathlib, sqlite3

data = pathlib.Path("/app/data")
out = data / "backups"
out.mkdir(exist_ok=True)
target = out / f"chats-{datetime.date.today():%Y-%m-%d}.sqlite3"
src, dst = sqlite3.connect(data / "chats.sqlite3"), sqlite3.connect(target)
with dst:
    src.backup(dst)                      # consistent copy, even while the app is writing
dst.close(); src.close()
copies = sorted(out.glob("chats-*.sqlite3"))
for old in copies[:-14]:                 # keep the newest 14
    old.unlink()
print(f"{datetime.datetime.now():%F %T} backed up to {target.name} ({target.stat().st_size} bytes); "
      f"{min(len(copies), 14)} copies kept")
PY
