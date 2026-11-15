"""Suggest each person's role (dev / qa / pm / design / devops) from what they actually do in Jira.

Signals, strongest first:
  1. Worklog tags (98% of worklogs carry one): [Dev] [Code Review] [Debug] -> dev, [Testing] [Bug Verification]
     [Test Setup] -> qa, [Design] -> design, [DevOps] [Deployment] -> devops, [Discussion] [Planning] -> pm.
  2. Bugs they reported (testers report bugs).
  3. Tickets they created (PMs create epics, stories and roadmap items).
  4. Work assigned to them (developers get tasks and bugs assigned).

It only SUGGESTS: the result goes to team.suggested.yaml with the evidence, and team.yaml is changed only with
--apply (and then only for people whose role is still "unknown", so hand edits are never overwritten).
"""

import difflib
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from .jira_client import is_human

TAG_ROLE = {
    "dev": "dev", "code review": "dev", "debug": "dev", "research": "dev", "review": "dev",
    "testing": "qa", "bug verification": "qa", "test setup": "qa", "automation": "qa",
    "design": "design",
    "devops": "devops", "deployment": "devops",
    "discussion": "pm", "planning": "pm", "meeting": "pm", "documentation": "pm",
    "coordination": "pm", "scoping": "pm", "grooming": "pm", "requirement": "pm", "requirements": "pm",
}
PLANNING = "pm"


def normalize_tag(tag: str) -> str:
    """'Discusssion' -> 'discussion' (typos), 'Code review' -> 'code review'."""
    t = " ".join(tag.lower().split())
    if t in TAG_ROLE:
        return t
    close = difflib.get_close_matches(t, TAG_ROLE.keys(), n=1, cutoff=0.85)
    return close[0] if close else t
TAG = re.compile(r"^\s*\[([^\]]+)\]")
PM_TYPES = {"Epic", "Story", "Project Roadmap"}
DEV_TYPES = {"Task", "Bug", "Sub-task", "Custom Subtask", "Custom", "DevOps", "POC Task"}


@dataclass
class RoleSuggestion:
    account_id: str
    name: str
    role: str
    confidence: str            # high | medium | low
    evidence: str


def suggest(worklog_tags: dict[str, Counter], bugs_reported: Counter, created: dict[str, Counter],
            assigned: dict[str, Counter], names: dict[str, str]) -> list[RoleSuggestion]:
    """Pure scoring (easy to test). All inputs are keyed by accountId."""
    out = []
    for aid, name in names.items():
        tags: Counter = Counter()
        for tag, n in worklog_tags.get(aid, Counter()).items():
            tags[normalize_tag(tag)] += n
        by_role: Counter = Counter()
        for tag, n in tags.items():
            if tag in TAG_ROLE:
                by_role[TAG_ROLE[tag]] += n
        made = created.get(aid, Counter())
        got = assigned.get(aid, Counter())
        bugs = bugs_reported.get(aid, 0)
        pm_made = sum(n for t, n in made.items() if t in PM_TYPES)
        dev_got = sum(n for t, n in got.items() if t in DEV_TYPES)

        bits = []
        if tags:
            bits.append("worklogs: " + ", ".join(f"[{t.title()}] {n}" for t, n in tags.most_common(3)))
        if bugs:
            bits.append(f"reported {bugs} bugs")
        if pm_made:
            bits.append(f"created {pm_made} epics/stories")
        if dev_got:
            bits.append(f"assigned {dev_got} tasks/bugs")
        evidence = " · ".join(bits) or "no activity in the period"

        total = sum(by_role.values())
        planning_heavy = (total >= 5 and by_role[PLANNING] / total >= 0.5) or pm_made >= 5
        if planning_heavy and dev_got >= 30:
            # plans AND carries a big ticket load: a team lead, not a pure PM (leads count as developers)
            out.append(RoleSuggestion(aid, name, "lead", "medium", evidence))
            continue
        if total >= 5:
            role, n = by_role.most_common(1)[0]
            share = n / total
            if share >= 0.6:
                out.append(RoleSuggestion(aid, name, role, "high" if share >= 0.8 and total >= 10 else "medium", evidence))
                continue
        # weaker signals when worklogs don't settle it
        if bugs >= 5 and bugs >= dev_got:
            out.append(RoleSuggestion(aid, name, "qa", "medium" if bugs >= 10 else "low", evidence))
        elif pm_made >= 3 and pm_made >= dev_got:
            out.append(RoleSuggestion(aid, name, "pm", "low", evidence))
        elif dev_got >= 3:
            out.append(RoleSuggestion(aid, name, "dev", "low", evidence))
        elif total:
            out.append(RoleSuggestion(aid, name, by_role.most_common(1)[0][0], "low", evidence))
        else:
            out.append(RoleSuggestion(aid, name, "unknown", "low", evidence))
    return sorted(out, key=lambda s: ({"high": 0, "medium": 1, "low": 2}[s.confidence], s.name.lower()))


def gather(service, days: int = 60) -> list[RoleSuggestion]:
    """Collect the signals from Jira (read-only) for everyone on the roster."""
    roster = service.roster()
    names = {p.account_id: p.name for p in roster.people}
    tags: dict[str, Counter] = defaultdict(Counter)
    for w in service._worklogs_checked(days):
        m = TAG.match(w["note"])
        if m and w["author"]["accountId"] in names:
            tags[w["author"]["accountId"]][m.group(1).strip().lower()] += 1
    bugs: Counter = Counter()
    for i in service.jira.search(f"issuetype = Bug AND created >= -{days}d", ["reporter"]):
        r = i["fields"].get("reporter")
        if is_human(r):
            bugs[r["accountId"]] += 1
    created: dict[str, Counter] = defaultdict(Counter)
    for c in service._naming_checked(days)[0]:
        created[c["author"]["accountId"]][c["issue"]["fields"]["issuetype"]["name"]] += 1
    assigned: dict[str, Counter] = defaultdict(Counter)
    for i in service.jira.search(f"assignee is not EMPTY AND updated >= -{days}d", ["assignee", "issuetype"]):
        a = i["fields"].get("assignee")
        if is_human(a):
            assigned[a["accountId"]][i["fields"]["issuetype"]["name"]] += 1
    return suggest(tags, bugs, created, assigned, names)
