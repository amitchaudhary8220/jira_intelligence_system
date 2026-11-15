"""The team list ("roster").

Why we need it: Jira search only returns people who DID something. Someone who did
nothing for 7 days never shows up in any search, so to find them we must know who
SHOULD be there. That's the roster.

Two sources:
  1. team.yaml (best): you list people + their role (dev / qa / pm / design / ...).
     Generate a first version with `make roster`, then edit roles by hand.
  2. Automatic fallback: everyone who was assignee on an issue in the last N days.
     Works out of the box, but doesn't know roles, so "free developers" includes QA/PMs.
"""

import difflib
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from .jira_client import Jira, is_human

MATCH_THRESHOLD = 0.72   # below this a name is "not a match"
CLEAR_WINNER_GAP = 0.06  # best match must beat the runner-up by this much, else we ask "which one?"


def _norm(name: str) -> str:
    """'lakshmi.raman' / 'Lakshmi_Raman' / ' lakshmi  raman ' -> 'lakshmi raman'."""
    return " ".join(re.sub(r"[._\-]+", " ", name.lower()).split())


def name_score(query: str, name: str) -> float:
    """How well `query` matches `name`, 0..1. Typo-tolerant ("Arjn Malhtra" ~ "Arjun Malhotra").

    1.0   exact (ignoring case, dots, underscores)
    0.98  every typed word is a whole word of the name ("ravi" -> "Ravi Kumar Mehra")
    0.90  typed text starts a word of the name ("ravi" -> "Kiran Ravishankar")
    0.85  typed text appears inside the name
    else  fuzzy: each typed word vs its closest word in the name (difflib similarity, like a spell-checker),
          or the whole string vs the whole name - whichever is higher.
    """
    q, n = _norm(query), _norm(name)
    if not q or not n:
        return 0.0
    if q == n:
        return 1.0
    if set(q.split()) <= set(n.split()):
        return 0.98
    if f" {n}".find(f" {q}") >= 0:
        return 0.90
    if q in n:
        return 0.85
    name_words = n.split()

    def word_sim(a: str) -> float:
        return max(1.0 if (len(a) >= 3 and b.startswith(a)) else difflib.SequenceMatcher(None, a, b).ratio()
                   for b in name_words)

    words = q.split()
    per_word = sum(word_sim(a) for a in words) / len(words)
    whole = difflib.SequenceMatcher(None, q, n).ratio()
    return round(max(per_word * 0.92, whole * 0.9), 3)


ROLES = ("dev", "qa", "pm", "design", "devops", "lead", "other", "unknown")
DEV_ROLES = ("dev", "devops", "lead", "unknown")   # who counts as a "developer"


@dataclass
class Person:
    account_id: str
    name: str
    role: str = "unknown"
    team: str | None = None
    active: bool = True          # false = left the company / on long leave: ignored everywhere
    email: str | None = None     # work email: links a signed-in user (AUTH_MODE=proxy/password) to this person


@dataclass
class Roster:
    people: list[Person]
    source: str                  # "team.yaml" or "auto: assignees in last 60 days"

    def by_id(self) -> dict[str, Person]:
        return {p.account_id: p for p in self.people}

    def by_email(self, email: str) -> Person | None:
        email = email.strip().lower()
        return next((p for p in self.people if (p.email or "").strip().lower() == email), None)

    def find(self, text: str) -> list[Person]:
        """People matching `text`, best first (typo-tolerant). See name_score()."""
        return [p for p, _ in self.ranked(text)]

    def ranked(self, text: str, threshold: float = MATCH_THRESHOLD) -> list[tuple[Person, float]]:
        scored = [(p, name_score(text, p.name)) for p in self.people]
        return sorted([x for x in scored if x[1] >= threshold], key=lambda x: -x[1])


def load_roster(jira: Jira, path: Path, auto_days: int = 60) -> Roster:
    if path.exists():
        data = yaml.safe_load(path.read_text()) or {}
        people = [Person(**p) for p in data.get("people", [])]
        return Roster([p for p in people if p.active], source=path.name)
    return Roster(discover_people(jira, auto_days), source=f"auto: assignees in last {auto_days} days")


def discover_people(jira: Jira, days: int = 60) -> list[Person]:
    issues = jira.search(f"assignee is not EMPTY AND updated >= -{days}d", fields=["assignee"])
    seen: dict[str, Person] = {}
    for issue in issues:
        a = issue["fields"].get("assignee")
        if is_human(a) and a.get("active", True) and a["accountId"] not in seen:
            seen[a["accountId"]] = Person(account_id=a["accountId"], name=a["displayName"])
    return sorted(seen.values(), key=lambda p: p.name.lower())


def write_roster(people: list[Person], path: Path) -> None:
    header = (
        "# Team roster for the Jira PM agent.\n"
        f"# role: one of {', '.join(ROLES)}   (dev/devops/lead/unknown count as developers)\n"
        "# team: optional, free text (e.g. 'Voter Outreach')\n"
        "# active: false = ignore this person (left, long leave, external)\n"
        "# email: their work email - needed for sign-in (AUTH_MODE=proxy/password) to know who 'me' is\n"
    )
    body = yaml.safe_dump({"people": [asdict(p) for p in people]}, sort_keys=False, allow_unicode=True)
    path.write_text(header + body)

