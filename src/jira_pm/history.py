"""Chat history in SQLite: one file, no server to run, part of Python (sqlite3).

Each conversation belongs to an OWNER: the signed-in user's email (with login), or "acct:<jira account id>" from
the "I am" picker (local development without login). Every read/write filters by owner, so nobody can see or
delete anyone else's chats.

Rules: each owner keeps MAX_PER_OWNER conversations, least-recently-used eviction (LRU): updated_at is "last used",
bumped when you ask in a chat AND when you open it, and a new chat beyond the cap removes the one used longest ago.
Conversations untouched for RETENTION_DAYS are deleted. Messages store what the chat shows (question, answer, which tools ran) - they can contain Jira details,
so the retention rule matters.

JS comparison: like better-sqlite3 in Node - a local file, plain SQL, no ORM.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

MAX_PER_OWNER = 5
RETENTION_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (owner, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'bot')),
    text             TEXT NOT NULL,
    tools            TEXT NOT NULL DEFAULT '[]',
    seconds          REAL,
    created_at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS day_reasons (          -- why someone logged less than the daily requirement (Time log tab)
    owner       TEXT NOT NULL,
    day         TEXT NOT NULL,                    -- YYYY-MM-DD
    reason      TEXT NOT NULL,                    -- half_day | arrived_late | no_active_story | on_leave | other | made_up | comp_off
    note        TEXT NOT NULL DEFAULT '',
    other_day   TEXT,                             -- made_up / comp_off: the day the extra time was worked
    updated_at  REAL NOT NULL,
    PRIMARY KEY (owner, day)
);
"""


def title_of(question: str) -> str:
    t = " ".join(question.split())
    return t if len(t) <= 60 else t[:57] + "…"


class ChatStore:
    def __init__(self, path: str | Path, max_per_owner: int = MAX_PER_OWNER, retention_days: int = RETENTION_DAYS):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.max_per_owner = max_per_owner
        self.retention_days = retention_days
        self._lock = threading.Lock()              # one connection, used from FastAPI's thread pool
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA foreign_keys = ON")
            if self.path != ":memory:":
                self._db.execute("PRAGMA journal_mode = WAL")   # safe if the process stops mid-write
            self._db.executescript(SCHEMA)
            cols = {r["name"] for r in self._db.execute("PRAGMA table_info(day_reasons)")}
            if "other_day" not in cols:                 # databases created before "made up / comp off"
                try:
                    self._db.execute("ALTER TABLE day_reasons ADD COLUMN other_day TEXT")
                except sqlite3.OperationalError as e:   # another process (e.g. a reloading server) just added it
                    if "duplicate column" not in str(e):
                        raise
            self._db.commit()

    # ------------------------------------------------------------------ reads (always scoped to the owner)
    def recent(self, owner: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, title, created_at, updated_at FROM conversations WHERE owner = ? "
                "ORDER BY updated_at DESC LIMIT ?", (owner, self.max_per_owner)).fetchall()
        return [dict(r) for r in rows]

    def get(self, owner: str, conversation_id: str, touch: bool = False) -> dict | None:
        """One conversation with its messages. touch=True marks it used (opening it in the sidebar, for LRU)."""
        with self._lock:
            if touch:
                self._db.execute("UPDATE conversations SET updated_at = ? WHERE id = ? AND owner = ?",
                                 (time.time(), conversation_id, owner))
                self._db.commit()
            conv = self._db.execute("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND owner = ?",
                                    (conversation_id, owner)).fetchone()
            if not conv:
                return None
            msgs = self._db.execute("SELECT role, text, tools, seconds FROM messages WHERE conversation_id = ? ORDER BY id",
                                    (conversation_id,)).fetchall()
        return {**dict(conv), "messages": [{"role": m["role"], "text": m["text"], "tools": json.loads(m["tools"]),
                                             "seconds": m["seconds"]} for m in msgs]}

    def turns(self, owner: str, conversation_id: str) -> list[dict]:
        """[{role, text}] for rebuilding the agent's context after a restart."""
        conv = self.get(owner, conversation_id)
        return [{"role": m["role"], "text": m["text"]} for m in conv["messages"]] if conv else []

    def owner_of(self, conversation_id: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT owner FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return row["owner"] if row else None

    # ------------------------------------------------------------------ writes
    def add_exchange(self, owner: str, conversation_id: str, question: str, answer: str,
                     tools: list | None = None, seconds: float | None = None) -> None:
        """Save one question + answer. Creates the conversation on first use, then applies the per-owner cap."""
        now = time.time()
        with self._lock:
            row = self._db.execute("SELECT owner FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row and row["owner"] != owner:
                raise PermissionError("conversation belongs to someone else")
            if not row:
                self._db.execute("INSERT INTO conversations (id, owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                                 (conversation_id, owner, title_of(question), now, now))
            else:
                self._db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            self._db.executemany(
                "INSERT INTO messages (conversation_id, role, text, tools, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(conversation_id, "user", question, "[]", None, now),
                 (conversation_id, "bot", answer, json.dumps(tools or []), seconds, now)])
            # keep only the N most recently used conversations for this owner (LRU) (messages go with them: ON DELETE CASCADE)
            self._db.execute(
                "DELETE FROM conversations WHERE owner = ? AND id NOT IN "
                "(SELECT id FROM conversations WHERE owner = ? ORDER BY updated_at DESC LIMIT ?)",
                (owner, owner, self.max_per_owner))
            self._db.commit()

    def delete(self, owner: str, conversation_id: str) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM conversations WHERE id = ? AND owner = ?", (conversation_id, owner))
            self._db.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------ time log reasons (always scoped to the owner)
    def day_reasons(self, owner: str, start: str, end: str) -> dict[str, dict]:
        with self._lock:
            rows = self._db.execute("SELECT day, reason, note, other_day FROM day_reasons "
                                    "WHERE owner = ? AND day BETWEEN ? AND ?", (owner, start, end)).fetchall()
        return {r["day"]: {"reason": r["reason"], "note": r["note"], "other_day": r["other_day"]} for r in rows}

    def days_covered_by(self, owner: str, start: str, end: str) -> list[dict]:
        """Short days that point at a day in start..end as where the time was made up (made_up / comp_off)."""
        with self._lock:
            rows = self._db.execute("SELECT day, reason, other_day FROM day_reasons WHERE owner = ? AND other_day "
                                    "BETWEEN ? AND ? ORDER BY day", (owner, start, end)).fetchall()
        return [dict(r) for r in rows]

    def set_day_reason(self, owner: str, day: str, reason: str | None, note: str = "", other_day: str | None = None) -> None:
        """Save (or with reason=None, remove) the reason for one day."""
        with self._lock:
            if reason is None:
                self._db.execute("DELETE FROM day_reasons WHERE owner = ? AND day = ?", (owner, day))
            else:
                self._db.execute("INSERT INTO day_reasons (owner, day, reason, note, other_day, updated_at) "
                                 "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, day) DO UPDATE SET reason = excluded.reason, "
                                 "note = excluded.note, other_day = excluded.other_day, updated_at = excluded.updated_at",
                                 (owner, day, reason, note, other_day, time.time()))
            self._db.commit()

    def purge_old(self) -> int:
        """Delete conversations nobody touched for retention_days. Returns how many."""
        cutoff = time.time() - self.retention_days * 86400
        with self._lock:
            cur = self._db.execute("DELETE FROM conversations WHERE updated_at < ?", (cutoff,))
            self._db.execute("DELETE FROM day_reasons WHERE updated_at < ?", (time.time() - 400 * 86400,))
            self._db.commit()
        return cur.rowcount
