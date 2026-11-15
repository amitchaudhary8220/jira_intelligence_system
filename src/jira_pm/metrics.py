"""The answers. Plain Python + Jira - no LLM here.

Every function returns a plain dict (JSON-friendly). The same functions are used by:
  - step1 (prints tables, no LLM)  -> proves the numbers are right
  - the agent (as tools)           -> the LLM only chooses WHICH function and words the answer

How this company uses Jira (found by looking at our Jira site, Nov 2026):
  - A FEATURE is a Jira COMPONENT ("Form Builder", "Voter Module User Portal", ...).
    Projects are bigger modules (FB, VO, WEB...). We fall back to a project if no component matches.
  - Epics are quarterly initiatives: "[Q4 FY26] Enable Admins to Import and Export Forms".
  - Real sprints live in the Sprint field ("Q4 FY26 - Sprint 4"). Week labels exist but are messy.
  - Workflow: To Do -> In Progress -> In Review -> Ready to merge -> Deployed on Staging
              -> In QA -> Ready to deploy -> Released   (+ On Hold, Ideation)
"""

import difflib
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import Settings
from .jira_client import Jira, JiraError, is_human, jql_quote, parse_time
from .naming import RULE_LABELS, WORKLOG_LABELS, check_title, check_worklog, is_compliant
from .sprints import SprintMixin
from .roster import CLEAR_WINNER_GAP, DEV_ROLES, MATCH_THRESHOLD, Person, Roster, load_roster, name_score

MAX_LIST = 25          # never hand the LLM more than this many issues in one list
DASHBOARD_PARTS = ("sprint_overview", "bug_overview", "naming:", "worklogs:", "naming_checked:", "worklogs_checked:",
                   "free_developers", "inactive:")
CACHE_SECONDS = 3600
# "What does X have to do?" = everything assigned that hasn't reached staging or release yet.
ISSUE_TYPE_ALIASES = {"bug": "Bug", "bugs": "Bug", "defect": "Bug", "defects": "Bug",
                      "subtask": "Sub-task", "sub-task": "Sub-task", "subtasks": "Sub-task", "sub-tasks": "Sub-task",
                      # "stories / tickets / tasks / work" mean EVERYTHING assigned, not one Jira type
                      "story": "", "stories": "", "ticket": "", "tickets": "", "task": "", "tasks": "", "work": "",
                      "all": "", "any": ""}
TODO_EXCLUDED = ("Deployed on Staging",)          # plus every Done-category status (Released, Done)
SCOPE_WORDS = {                                   # how person_issues results should be described, per scope
    "all": (" (every status, including finished ones). Lead with this TOTAL, then the count per stage, "
            "then the list"),
    "todo": ", still to do (everything not yet Deployed on Staging or Released)",
    "open": ", not finished yet",
    "active": ", being worked on right now",
}
AVAILABILITY_ROLES = (*DEV_ROLES, "qa")   # "who is free": developers and QA (their assigned stories are their work)
SAFE_EMAIL = re.compile(r"[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}")   # what we put inside a JQL string

# Order statuses roughly by workflow position, so lists read naturally.
STATUS_ORDER = ["In Progress", "In Review", "Ready to merge", "Deployed on Staging", "In QA",
                "Ready to deploy", "To Do", "On Hold", "Ideation", "Released", "Done"]
PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest"]

ISSUE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter",
                "components", "parent", "created", "updated", "resolutiondate", "project"]


WORKFLOW = ["To Do", "In Progress", "In Review", "Ready to merge", "Deployed on Staging",
            "In QA", "Ready to deploy", "On Hold"]
FIXED_UNRELEASED = {"Ready to deploy", "Deployed on Staging"}
NOT_A_BUG = {"invalid", "duplicate", "won't do", "won't fix", "cannot reproduce", "rejected", "cancelled", "not a bug"}


def bug_state(issue: dict) -> str:
    """open | fixed_unreleased | fixed | invalid  - what a PM actually wants to know about a bug."""
    f = issue["fields"]
    status = f["status"]["name"]
    if f["status"]["statusCategory"]["key"] == "done":
        resolution = ((f.get("resolution") or {}).get("name") or "").lower()
        return "invalid" if status.lower() in NOT_A_BUG or resolution in NOT_A_BUG else "fixed"
    return "fixed_unreleased" if status in FIXED_UNRELEASED else "open"


_STATUS_CATEGORY_FIXES = {"inprogress": '"In Progress"', "in_progress": '"In Progress"', "indeterminate": '"In Progress"',
                          "todo": '"To Do"', "to_do": '"To Do"', "new": '"To Do"', "complete": '"Done"'}


def fix_jql(jql: str) -> str:
    """Repair JQL slips that Jira silently answers with 0 results, e.g. statusCategory = InProgress."""
    def repl(m: "re.Match[str]") -> str:
        value = m.group(2).strip('"\'')
        fixed = _STATUS_CATEGORY_FIXES.get(value.lower().replace(" ", ""), None)
        return f"statusCategory {m.group(1)} {fixed}" if fixed else m.group(0)
    return re.sub(r"statusCategory\s*(=|!=)\s*(\"[^\"]*\"|'[^']*'|\w+)", repl, jql, flags=re.I)


GENERIC_FEATURE_WORDS = {"module", "feature", "features", "component", "section", "page", "area", "screen", "flow"}


def _feature_core(name: str) -> str:
    """'payments module' -> 'payments';  'Voter Module User Portal' -> 'voter user portal'."""
    return " ".join(w for w in name.split() if w not in GENERIC_FEATURE_WORDS)


def adf_text(node) -> str:
    """Plain text from Atlassian Document Format (how Jira v3 stores comments / worklog notes)."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return " ".join(adf_text(n) for n in node)
    return (node.get("text") or "") + " " + adf_text(node.get("content"))


def _rank(value: str, order: list[str]) -> int:
    return order.index(value) if value in order else len(order)


class PMService(SprintMixin):
    def __init__(self, jira: Jira, settings: Settings):
        self.jira = jira
        self.settings = settings
        self._cache: dict[str, tuple[float, object]] = {}

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> "PMService":
        s = settings or Settings.from_env()
        return cls(Jira(s.jira_base_url, s.jira_email, s.jira_api_token), s)

    # ------------------------------------------------------------------ helpers
    def _cached(self, key: str, fn, seconds: int = CACHE_SECONDS):
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < seconds:
            return hit[1]
        value = fn()
        self._cache[key] = (time.time(), value)
        return value

    def roster(self) -> Roster:
        return self._cached("roster", lambda: load_roster(self.jira, self.settings.roster_path))

    def me(self) -> Person:
        """The owner of the API token."""
        def load():
            u = self.jira.myself()
            return self.roster().by_id().get(u["accountId"]) or Person(u["accountId"], u["displayName"])
        return self._cached("me", load)

    def _status_list(self) -> str:
        return ", ".join(jql_quote(s) for s in self.settings.active_statuses)

    def slim(self, issue: dict) -> dict:
        """Shrink a Jira issue to what a human (or the LLM) needs."""
        f = issue["fields"]
        parent = f.get("parent") or {}
        parent_f = parent.get("fields") or {}
        out = {
            "key": issue["key"],
            "summary": f.get("summary"),
            "type": (f.get("issuetype") or {}).get("name"),
            "status": (f.get("status") or {}).get("name"),
            "priority": (f.get("priority") or {}).get("name"),
            "assignee": (f.get("assignee") or {}).get("displayName", "Unassigned"),
            "components": [c["name"] for c in f.get("components") or []],
            "updated": (f.get("updated") or "")[:10],
            "url": self.jira.browse_url(issue["key"]),
        }
        if (parent_f.get("issuetype") or {}).get("name") == "Epic":
            out["epic"] = f"{parent['key']} {parent_f.get('summary', '')}"
        return out

    def _sorted_slim(self, issues: list[dict]) -> list[dict]:
        rows = [self.slim(i) for i in issues]
        rows.sort(key=lambda r: (_rank(r["status"], STATUS_ORDER), _rank(r["priority"], PRIORITY_ORDER)))
        return rows[:MAX_LIST]

    # ------------------------------------------------------------------ resolving names
    def person_by_email(self, email: str) -> Person:
        """The Jira person behind a signed-in email (cached an hour). If Jira has no match, a placeholder
        Person("email:<address>") is returned so "my ..." questions explain the problem instead of guessing."""
        email = email.strip().lower()

        def load():
            # 1) team.yaml email  2) the token owner's own email  3) JQL by email  4) Jira user search (needs "Browse users")
            listed = self.roster().by_email(email)
            if listed:
                return listed
            try:
                owner = self.jira.myself()
                if (owner.get("emailAddress") or "").lower() == email:
                    return self.me()
            except JiraError:
                pass
            # JQL accepts an email for user fields, even without "Browse users": the assignee (or reporter) of an
            # issue found by `assignee = "<email>"` IS that person. An unknown email is a JQL error -> no match.
            if SAFE_EMAIL.fullmatch(email):
                for fld in ("assignee", "reporter"):
                    try:
                        hits = self.jira.search(f"{fld} = {jql_quote(email)} ORDER BY updated DESC", [fld], limit=1, page_size=1)
                    except JiraError:
                        break                                   # Jira doesn't know this email at all
                    user = (hits[0]["fields"].get(fld) or {}) if hits else {}
                    shown = (user.get("emailAddress") or "").lower()
                    if user.get("accountId") and (not shown or shown == email):
                        return self.roster().by_id().get(user["accountId"]) or Person(user["accountId"], user.get("displayName") or email)
            try:
                users = [u for u in self.jira.get("/rest/api/3/user/search", query=email, maxResults=10) if is_human(u)]
            except JiraError:
                users = []
            exact = [u for u in users if (u.get("emailAddress") or "").lower() == email]
            pick = exact[0] if exact else (users[0] if len(users) == 1 else None)
            if not pick:
                return Person(f"email:{email}", email)
            return self.roster().by_id().get(pick["accountId"]) or Person(pick["accountId"], pick["displayName"])
        return self._cached(f"person_by_email:{email}", load, 3600)

    def resolve_person(self, who: str | None, me: Person | None = None) -> Person:
        return self.match_person(who, me)[0]

    def match_person(self, who: str | None, me: Person | None = None) -> tuple[Person, str | None]:
        """Find a person from what the user typed. Typo-tolerant.

        Returns (person, note). `note` is set when we corrected a typo, so the answer can say
        "I assumed you meant Arjun Malhotra". Raises LookupError if nobody or several people fit.
        """
        if not who or who.strip().lower() in ("me", "myself", "i", "mine", "my"):
            person = me or self.me()
            if person.account_id.startswith("email:"):          # signed in, but no Jira account matched
                raise LookupError(f"I couldn't find a Jira account for {person.name}, so I can't look up 'my' work. "
                                  "Ask your Jira admin, or ask about someone by name.")
            return person, None
        roster = self.roster()
        hits = roster.ranked(who)
        if not hits:
            # Not on the roster: ask Jira (prefix search), then rank its answers the same way.
            users = self.jira.find_users(who) or self.jira.find_users(who.split()[0])
            hits = sorted(((roster.by_id().get(u["accountId"]) or Person(u["accountId"], u["displayName"]),
                            name_score(who, u["displayName"])) for u in users), key=lambda x: -x[1])
            hits = [h for h in hits if h[1] >= MATCH_THRESHOLD]
        if not hits:
            close = sorted(((p.name, name_score(who, p.name)) for p in roster.people), key=lambda x: -x[1])[:3]
            raise LookupError(f"No person matching '{who}'. Closest names: {', '.join(n for n, _ in close)}.")
        best, score = hits[0]
        tied = [p.name for p, s in hits if score - s < CLEAR_WINNER_GAP]
        if len(tied) > 1:
            raise LookupError(f"'{who}' could be several people: {', '.join(tied[:8])}. Which one?")
        note = None if score >= 0.95 else f"'{who}' isn't an exact name - assumed {best.name}."
        return best, note

    def features(self) -> list[dict]:
        """Every component in every project you can see: [{name, project, project_name}]."""
        def load():
            out = []
            for p in self.jira.projects():
                for c in self.jira.components(p["key"]):
                    out.append({"name": c["name"], "project": p["key"], "project_name": p["name"]})
            return out
        return self._cached("features", load)

    def resolve_feature(self, text: str) -> dict:
        """Turn 'form builder' / 'voter module' into a JQL clause.

        Returns {"clause": 'component in (...)', "matched": [...], "kind": "component"|"project"}.
        Several components can match ("voter module" -> User Portal, Admin Portal, Misc) - we use all.
        """
        t = " ".join(text.strip().lower().split())
        feats = self.features()
        names = sorted({f["name"] for f in feats})
        exact = [n for n in names if n.lower() == t]
        partial = [n for n in names if t in n.lower()]
        # Typos: compare the meaningful words only ("payments module" must NOT match "Event Module"
        # just because both end in "module"), and only accept close spellings.
        core = _feature_core(t)
        fuzzy = []
        if len(core) >= 3:
            scored = sorted(((difflib.SequenceMatcher(None, core, _feature_core(n.lower())).ratio(), n) for n in names),
                            reverse=True)
            fuzzy = [n for r, n in scored[:3] if r >= 0.8]
        matched = exact or partial or fuzzy
        if matched:
            return {"kind": "component", "matched": matched,
                    "clause": f"component in ({', '.join(jql_quote(n) for n in matched)})"}
        projects = {f["project"]: f["project_name"] for f in feats}
        for key, name in projects.items():
            if t in (key.lower(), name.lower()) or t in name.lower():
                return {"kind": "project", "matched": [f"{name} ({key})"], "clause": f"project = {key}"}
        suggestions = difflib.get_close_matches(text, names, n=5, cutoff=0.3)
        raise LookupError(f"No feature/component matches '{text}'. Closest: {', '.join(suggestions) or 'none'}. "
                          "Feature names are in English: if the user wrote it in Hindi or another script, retry "
                          "with the English name; otherwise use list_features. Do NOT answer with numbers until a "
                          "tool returns them.")

    # ------------------------------------------------------------------ 1. my / someone's work
    def person_issues(self, who: str | None = None, scope: str = "open",
                      relation: str = "assignee", me: Person | None = None, issue_type: str | None = None) -> dict:
        """Issues for a person.

        scope:    all (everything assigned, any status - "what is assigned to X")
                  | todo (still to do: not yet Deployed on Staging, not Released/Done - "what does X have to do")
                  | active (being worked on now: ACTIVE_STATUSES - "what is X working on")
                  | open (not finished) | sprint (in the current sprint) | done_recent (finished in the last 14 days)
        relation: assignee (work they do) | reporter (tickets they raised - typical for PMs)
        issue_type: only this Jira type, e.g. "Bug" ("bugs assigned to me"). Empty = every type ("what is assigned").
        """
        person, match_note = self.match_person(who, me)
        itype = ISSUE_TYPE_ALIASES.get((issue_type or "").strip().lower(), (issue_type or "").strip())
        who_clause = f"{'reporter' if relation == 'reporter' else 'assignee'} = {jql_quote(person.account_id)}"
        scope_clause = {
            "all": "",
            "todo": f"statusCategory != Done AND status not in ({', '.join(jql_quote(x) for x in TODO_EXCLUDED)})",
            "open": "statusCategory != Done",
            "active": f"status in ({self._status_list()})",
            "sprint": "sprint in openSprints()",
            "done_recent": "statusCategory = Done AND resolved >= -14d",
        }.get(scope)
        if scope_clause is None:
            raise ValueError("scope must be all, todo, active, open, sprint or done_recent")
        type_clause = f"issuetype = {jql_quote(itype)}" if itype else "issuetype != Epic"
        jql = " AND ".join(x for x in (who_clause, scope_clause, type_clause) if x) + " ORDER BY updated DESC"
        issues = self.jira.search(jql, ISSUE_FIELDS, limit=1000)
        # "open" in Jira means "not finished", but people read "open issue" as "nobody has it". Group a person's
        # unfinished tickets the way a human would describe them, and tell the LLM which words to use.
        active = set(self.settings.active_statuses)

        def group(i: dict) -> str:
            st = i["fields"]["status"]
            if st["statusCategory"]["key"] == "done":
                return "done"
            if st["name"] in active:
                return "being_worked_on"
            return "not_started" if st["statusCategory"]["key"] == "new" else "waiting_for_release"
        groups = Counter(group(i) for i in issues)
        holder = "created by" if relation == "reporter" else "assigned to"
        return {
            "person": person.name,
            "name_match_note": match_note,
            "relation": relation,
            "scope": scope,
            "total": len(issues),
            "issue_type": itype or "all types",
            "how_to_say_it": (f"These {len(issues)} {(itype.lower() + 's') if itype else 'tickets'} are {holder} {person.name}"
                              + SCOPE_WORDS.get(scope, "")
                              + ". Never call them 'open issues' (that sounds like nobody has them). Use by_stage."),
            "by_stage": {k: groups[k] for k in ("being_worked_on", "not_started", "waiting_for_release", "done") if groups[k]},
            "by_status": dict(Counter(self.slim(i)["status"] for i in issues).most_common()),
            "issues": self._sorted_slim(issues),
            "shown": min(len(issues), MAX_LIST),
            "jql": jql,
        }

    # ------------------------------------------------------------------ 2. bugs in a feature
    def feature_bugs(self, feature: str, days: int = 90) -> dict:
        """Bugs reported in a feature (component) during the last `days` days."""
        f = self.resolve_feature(feature)
        jql = f"issuetype = Bug AND {f['clause']} AND created >= -{days}d ORDER BY created DESC"
        issues = self.jira.search(jql, ISSUE_FIELDS + ["resolution"])
        rows = [self.slim(i) for i in issues]
        states = Counter(bug_state(i) for i in issues)
        open_issues = [i for i in issues if bug_state(i) == "open"]
        return {
            "feature": f["matched"],
            "days": days,
            "total_reported": len(rows),
            "still_open": states["open"],                      # needs work (To Do, In Progress, In QA, On Hold...)
            "fixed_not_released": states["fixed_unreleased"],  # Ready to deploy / Deployed on Staging
            "fixed_released": states["fixed"],
            "invalid": states["invalid"],                      # closed as Invalid / Duplicate / Won't Do: not real bugs
            "valid_bugs": len(rows) - states["invalid"],
            "by_status_all_reported": dict(Counter(r["status"] for r in rows).most_common()),
            "by_priority_all_reported": dict(Counter(r["priority"] for r in rows).most_common()),
            "by_priority_still_open": dict(Counter(self.slim(i)["priority"] for i in open_issues).most_common()),
            "by_component": dict(Counter(c for r in rows for c in r["components"]).most_common()),
            "by_assignee_all_reported": dict(Counter(r["assignee"] for r in rows).most_common(10)),
            "open_bugs": self._sorted_slim(open_issues),
            "jql": jql,
        }

    # ------------------------------------------------------------------ 3. who works on a feature
    def feature_developers(self, feature: str, days: int | None = None) -> dict:
        """People assigned to work in a feature.

        days=None -> the current open sprint(s). days=30 -> anything touched in the last 30 days.
        """
        f = self.resolve_feature(feature)
        window = "sprint in openSprints()" if not days else f"updated >= -{days}d"
        jql = f"{f['clause']} AND {window} AND issuetype != Epic AND assignee is not EMPTY"
        issues = self.jira.search(jql, ISSUE_FIELDS)
        roles = {p.account_id: p.role for p in self.roster().people}
        per: dict[str, dict] = {}
        active = set(self.settings.active_statuses)
        for i in issues:
            a = i["fields"]["assignee"]
            if not is_human(a):
                continue
            row = per.setdefault(a["accountId"], {"name": a["displayName"], "role": roles.get(a["accountId"], "unknown"),
                                                  "issues": 0, "active_now": 0, "done": 0, "types": Counter()})
            row["issues"] += 1
            row["types"][i["fields"]["issuetype"]["name"]] += 1
            status = i["fields"]["status"]
            if status["name"] in active:
                row["active_now"] += 1
            if status["statusCategory"]["key"] == "done":
                row["done"] += 1
        people = sorted(per.values(), key=lambda r: -r["issues"])
        for r in people:
            r["types"] = dict(r["types"])
        devs = [r for r in people if r["role"] in DEV_ROLES]
        return {
            "feature": f["matched"],
            "window": "current sprint" if not days else f"last {days} days",
            "people_count": len(people),
            "developer_count": len(devs),
            "people": people,
            "issues_considered": len(issues),
            "note": None if self.roster().source == "team.yaml"
                    else "Roles unknown (no team.yaml), so developer_count = everyone assigned.",
            "jql": jql,
        }

    # ------------------------------------------------------------------ 4. free developers
    def free_developers(self) -> dict:
        """Developers with NOTHING actively in progress right now.

        busy  = has an issue assigned in ACTIVE_STATUSES (In Progress / In Review / Ready to merge / In QA):
                a story in review or in QA is still the assignee's work
        free  = no active issue. Split into:
                 - 'free_with_queue': has To Do items in the open sprint (can pick something up)
                 - 'free_idle': nothing active, nothing queued -> really available
        Issues in Deployed on Staging / Ready to deploy don't make you busy: they're waiting for release.
        Developers AND QA people are counted (AVAILABILITY_ROLES).
        """
        roster = self.roster()
        devs = [p for p in roster.people if p.role in AVAILABILITY_ROLES]
        jql = (f"assignee is not EMPTY AND statusCategory != Done AND issuetype != Epic "
               f"AND (sprint in openSprints() OR status in ({self._status_list()}))")
        issues = self.jira.search(jql, ["assignee", "status", "summary"])
        active_names = set(self.settings.active_statuses)
        work: dict[str, dict[str, list[str]]] = defaultdict(lambda: {"active": [], "queued": [], "waiting": []})
        for i in issues:
            a = i["fields"]["assignee"]
            if not is_human(a):
                continue
            st = i["fields"]["status"]
            bucket = ("active" if st["name"] in active_names
                      else "queued" if st["statusCategory"]["key"] == "new"
                      else "waiting")
            work[a["accountId"]][bucket].append(f"{i['key']} ({st['name']})")

        busy, free_queue, free_idle = [], [], []
        for p in devs:
            w = work.get(p.account_id, {"active": [], "queued": [], "waiting": []})
            row = {"name": p.name, "role": p.role, "active": len(w["active"]),
                   "queued_in_sprint": len(w["queued"]), "waiting_qa_release": len(w["waiting"])}
            if w["active"]:
                row["active_issues"] = w["active"][:5]
                busy.append(row)
            elif w["queued"]:
                row["queued_issues"] = w["queued"][:5]
                free_queue.append(row)
            else:
                free_idle.append(row)
        busy.sort(key=lambda r: -r["active"])
        return {
            "developers_considered": len(devs),
            "roster_source": roster.source,
            "busy_count": len(busy),
            "free_count": len(free_queue) + len(free_idle),
            "free_idle_count": len(free_idle),
            "free_idle": free_idle,
            "free_with_queue": free_queue,
            "busy": busy,
            "definition": f"busy = has an issue in {', '.join(self.settings.active_statuses)}",
            "note": "Leave/holidays are not in Jira, so someone 'free' may simply be on leave."
                    + ("" if roster.source == "team.yaml" else
                       " Roles unknown (no team.yaml): QA/PMs are counted as developers."),
        }

    # ------------------------------------------------------------------ 5. inactive people
    def inactive_people(self, days: int = 7) -> dict:
        """People on the roster with NO Jira activity in the last `days` days.

        Activity = any of: logged work, changed an issue (status/fields), commented, created an issue.
        """
        roster = self.roster()
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        acts: dict[str, Counter] = defaultdict(Counter)

        def recent(ts: str | None) -> bool:
            t = parse_time(ts)
            return bool(t and t >= cutoff)

        issues = self.jira.search(f"updated >= -{days}d", ["creator", "created", "comment", "worklog"],
                                  expand="changelog")
        for issue in issues:
            key, f = issue["key"], issue["fields"]
            if is_human(f.get("creator")) and recent(f.get("created")):
                acts[f["creator"]["accountId"]]["created_issue"] += 1

            cl = issue.get("changelog") or {}
            histories = cl.get("histories", [])
            if cl.get("total", 0) > len(histories):           # search truncated it -> fetch the newest
                histories = self.jira.changelog_tail(key, cl["total"])
            for h in histories:
                if is_human(h.get("author")) and recent(h.get("created")):
                    kind = "status_change" if any(it.get("field") == "status" for it in h.get("items", [])) else "issue_update"
                    acts[h["author"]["accountId"]][kind] += 1

            cm = f.get("comment") or {}
            comments = cm.get("comments", [])
            if cm.get("total", 0) > len(comments):
                comments = self.jira.comments(key)
            for c in comments:
                if is_human(c.get("author")) and recent(c.get("created")):
                    acts[c["author"]["accountId"]]["comment"] += 1

            wl = f.get("worklog") or {}
            logs = wl.get("worklogs", [])
            if wl.get("total", 0) > len(logs):
                logs = self.jira.worklogs(key, cutoff)
            for w in logs:
                if is_human(w.get("author")) and (recent(w.get("started")) or recent(w.get("created"))):
                    acts[w["author"]["accountId"]]["work_logged"] += 1

        inactive = [p for p in roster.people if p.account_id not in acts]
        active = [p for p in roster.people if p.account_id in acts]

        # Context for the inactive ones: do they at least have open work assigned?
        open_counts: Counter = Counter()
        if inactive:
            ids = ", ".join(jql_quote(p.account_id) for p in inactive)
            for i in self.jira.search(f"assignee in ({ids}) AND statusCategory != Done", ["assignee"]):
                open_counts[i["fields"]["assignee"]["accountId"]] += 1

        return {
            "days": days,
            "roster_size": len(roster.people),
            "roster_source": roster.source,
            "active_count": len(active),
            "inactive_count": len(inactive),
            "inactive": [{"name": p.name, "role": p.role, "open_assigned": open_counts[p.account_id]}
                         for p in inactive],
            "active": sorted(({"name": p.name, "role": p.role, **acts[p.account_id]} for p in active),
                             key=lambda r: r["name"].lower())[:60],
            "issues_scanned": len(issues),
            "note": "Only Jira activity is visible. Leave, meetings, or coding without updating tickets look like inactivity.",
        }

    # ------------------------------------------------------------------ dashboard
    def sprint_overview(self) -> dict:
        """The team's current (open) sprints: totals, where work is sitting, the biggest queue."""
        def load():
            sprint_field = self.jira.sprint_field()
            fields = ["status", "assignee", "issuetype", "priority"] + ([sprint_field] if sprint_field else [])
            issues = self.jira.search("sprint in openSprints() AND issuetype != Epic", fields)
            sprints: Counter = Counter()
            status_counts: Counter = Counter()
            types: Counter = Counter()
            high_open = 0
            done = 0
            for i in issues:
                f = i["fields"]
                for sp in f.get(sprint_field) or []:
                    if sp.get("state") == "active":
                        sprints[sp["name"]] += 1
                if f["status"]["statusCategory"]["key"] == "done":
                    done += 1
                    continue
                status_counts[f["status"]["name"]] += 1
                types[f["issuetype"]["name"]] += 1
                if (f.get("priority") or {}).get("name") in ("Highest", "High"):
                    high_open += 1
            pipeline = [{"status": st, "count": status_counts.pop(st, 0)} for st in WORKFLOW]
            pipeline += [{"status": st, "count": c} for st, c in status_counts.most_common()]
            open_count = len(issues) - done
            biggest = max(pipeline, key=lambda r: r["count"]) if pipeline else None
            return {
                "names": [n for n, _ in sprints.most_common()],
                "total": len(issues), "done": done, "open": open_count,
                "pipeline": pipeline,
                "biggest_queue": biggest,
                "open_by_type": dict(types.most_common()),
                "high_priority_open": high_open,
            }
        return self._cached("sprint_overview", load, seconds=300)

    def jira_tz(self):
        """The token owner's Jira timezone (JQL dates like "2026-11-09" are read in it). Falls back to UTC."""
        def load():
            try:
                return ZoneInfo(self.jira.myself().get("timeZone") or "UTC")
            except Exception:  # noqa: BLE001 - unknown zone name or Jira hiccup: UTC is a safe default
                return timezone.utc
        return self._cached("jira_tz", load, 86400)

    def projects(self) -> list[dict]:
        """[{key, name}] for every project the token can see, sorted by name."""
        return self._cached("projects", lambda: sorted(
            ({"key": p["key"], "name": p["name"]} for p in self.jira.projects()), key=lambda p: p["name"].lower()))

    def resolve_project(self, text: str) -> dict:
        """'VO' / 'voter outreach' / 'voter outrich' -> {key, name}."""
        t = " ".join(text.strip().lower().split())
        projects = self.projects()
        for p in projects:
            if t in (p["key"].lower(), p["name"].lower()):
                return p
        partial = [p for p in projects if t in p["name"].lower()]
        if len(partial) == 1:
            return partial[0]
        close = difflib.get_close_matches(t, [p["name"].lower() for p in projects], n=1, cutoff=0.75)
        if close:
            return next(p for p in projects if p["name"].lower() == close[0])
        raise LookupError(f"No project matching '{text}'. Projects: " + ", ".join(f"{p['key']} = {p['name']}" for p in projects))

    def bug_overview(self, days: int = 30, project: str | None = None) -> dict:
        """Bugs (all projects, or one): weekly trend (8 weeks), features with the most bugs, open high-priority bugs."""
        proj = self.resolve_project(project) if project else None

        def load():
            window = max(days, 56)
            scope = f" AND project = {proj['key']}" if proj else ""
            bugs = self.jira.search(f"issuetype = Bug{scope} AND created >= -{window}d",
                                    ["created", "status", "components", "priority", "summary", "assignee", "resolution"])
            # Weeks start Monday 00:00 in the Jira user's timezone - the same clock Jira uses for the dates in the
            # click-through query (created >= "YYYY-MM-DD"), so a chart column and its list always agree.
            now = datetime.now(self.jira_tz())
            this_monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
            weeks = [this_monday - timedelta(weeks=w) for w in range(7, -1, -1)]
            trend: Counter = Counter()
            per_feature: dict[str, Counter] = defaultdict(Counter)
            states: Counter = Counter()
            hot = []
            cutoff = now - timedelta(days=days)
            for b in bugs:
                created = parse_time(b["fields"]["created"])
                for w in reversed(weeks):
                    if created >= w:
                        trend[w] += 1
                        break
                if created < cutoff:
                    continue
                state = bug_state(b)
                states[state] += 1
                for c in b["fields"].get("components") or [{"name": "No component"}]:
                    per_feature[c["name"]][state] += 1
                if state == "open" and (b["fields"].get("priority") or {}).get("name") in ("Highest", "High"):
                    hot.append(b)
            features = sorted(({"feature": n, "open": c["open"], "fixed_not_released": c["fixed_unreleased"],
                                "fixed": c["fixed"], "invalid": c["invalid"], "total": sum(c.values())}
                               for n, c in per_feature.items()), key=lambda r: -(r["total"] - r["invalid"]))
            return {
                "days": days,
                "project": proj,
                "reported": sum(states.values()),
                "open": states["open"],
                "fixed_not_released": states["fixed_unreleased"],
                "fixed": states["fixed"],
                "invalid": states["invalid"],
                "trend": [{"week": w.date().isoformat(), "count": trend[w]} for w in weeks],
                "by_feature": features[:10],
                "high_priority_open": self._sorted_slim(hot)[:10],
                "note": "by_feature is sorted by valid bugs (total minus invalid). A bug in 2 components counts in both.",
            }
        return self._cached(f"bug_overview:{days}:{proj['key'] if proj else 'all'}", load, seconds=300)

    def clear_dashboard_parts(self) -> None:
        for k in [k for k in list(self._cache) if k.startswith(DASHBOARD_PARTS)]:
            self._cache.pop(k, None)

    def dashboard(self, bug_days: int = 30, inactive_days: int = 7, refresh: bool = False, force: bool = False) -> dict:
        """Everything the dashboard page shows, in one call (cached 5 minutes).

        refresh = re-read everything from Jira (the Refresh button). force = rebuild this period from the
        section caches without clearing them (used by the background warmer).
        """
        key = f"dashboard:{bug_days}:{inactive_days}"
        hit = self._cache.get(key)
        if hit and not refresh and not force and time.time() - hit[0] < 300:
            return hit[1]
        if refresh:
            self.clear_dashboard_parts()
        started = time.time()
        now = datetime.now(timezone.utc)
        # The sections are independent and mostly wait on Jira, so fetch them in parallel. Parts that don't depend
        # on the period (sprint, availability, 7-day inactivity) are cached, so switching 7/30/90 only redoes the rest.
        with ThreadPoolExecutor(max_workers=6) as pool:
            f_sprint = pool.submit(self.sprint_overview)
            f_bugs = pool.submit(self.bug_overview, bug_days)
            f_naming = pool.submit(self._cached, f"naming:{bug_days}", lambda: self.naming_compliance(bug_days), 300)
            f_worklogs = pool.submit(self._cached, f"worklogs:{bug_days}", lambda: self.worklog_quality(bug_days), 300)
            f_avail = pool.submit(self._cached, "free_developers", self.free_developers, 300)
            f_inactive = pool.submit(self._cached, f"inactive:{inactive_days}", lambda: self.inactive_people(inactive_days), 300)
            sprint, bugs, naming, worklogs = f_sprint.result(), f_bugs.result(), f_naming.result(), f_worklogs.result()
            avail, inactive = f_avail.result(), f_inactive.result()

        inactive_names = {p["name"] for p in inactive["inactive"]}
        stale = [{"name": b["name"], "active": b["active"], "issues": b.get("active_issues", [])}
                 for b in avail["busy"] if b["name"] in inactive_names]

        result = {
            "generated_at": now.isoformat(),
            "jira_url": self.jira.base_url,
            "seconds": round(time.time() - started, 1),
            "bug_days": bug_days,
            "inactive_days": inactive_days,
            "sprint": sprint,
            "bugs": bugs,
            "team": {
                "roster_size": len(self.roster().people),
                "roster_source": self.roster().source,
                "developers": avail["developers_considered"],
                "busy": avail["busy_count"],
                "free_with_queue": len(avail["free_with_queue"]),
                "free_idle": avail["free_idle_count"],
                "free_people": avail["free_idle"] + avail["free_with_queue"],
                "workload": [{"name": b["name"], "active": b["active"], "queued": b["queued_in_sprint"]}
                             for b in avail["busy"][:10]],
                "busy_people": [{"name": b["name"], "active": b["active"], "queued_in_sprint": b["queued_in_sprint"],
                                 "waiting_qa_release": b["waiting_qa_release"]} for b in avail["busy"]],
                "active_statuses": self.settings.active_statuses,
            },
            "standards": {
                "naming": {k: naming[k] for k in ("days", "tickets_checked", "compliant", "compliance_pct", "by_rule",
                                                  "by_type", "people_not_following")},
                "worklogs": {k: worklogs[k] for k in ("days", "worklogs_checked", "compliant", "compliance_pct",
                                                      "by_rule", "people_not_following")},
            },
            "activity": {
                "inactive_count": inactive["inactive_count"],
                "active_count": inactive["active_count"],
                "inactive": inactive["inactive"],
                "busy_but_inactive": stale,
            },
        }
        self._cache[key] = (time.time(), result)
        return result

    # ------------------------------------------------------------------ 7. naming standard
    def _naming_checked(self, days: int, feature: str | None = None,
                        person: Person | None = None) -> tuple[list[dict], str]:
        """Every ticket created in the last N days with its naming-standard findings. Cached 5 minutes, so the
        summary numbers and the click-through list ("which tickets have this problem?") come from one check."""
        clauses = [f"created >= -{days}d"]
        if feature:
            clauses.append(self.resolve_feature(feature)["clause"])
        if person:
            clauses.append(f"creator = {jql_quote(person.account_id)}")
        jql = " AND ".join(clauses) + " ORDER BY created DESC"

        def load():
            out = []
            for i in self.jira.search(jql, ["summary", "issuetype", "creator", "reporter", "status", "created",
                                            "priority", "assignee", "components", "parent", "updated"]):
                f = i["fields"]
                author = f.get("creator") if is_human(f.get("creator")) else f.get("reporter")
                if not is_human(author):
                    continue
                errors = [x for x in check_title(f.get("summary", ""), f["issuetype"]["name"]) if x.severity == "error"]
                # a ticket counts ONCE per rule (an epic can break the epic rule two ways)
                out.append({"issue": i, "author": author, "errors": errors, "error_rules": sorted({x.rule for x in errors})})
            return out
        return self._cached(f"naming_checked:{jql}", load, 300), jql

    # ------------------------------------------------------------------ daily time log (5 h per working day)
    def time_log(self, person: Person, days: int = 14, start=None, end=None) -> dict:
        """One person's worklogs per day, against the daily requirement: the last `days` days, or start..end
        (e.g. one calendar month; days after today are left out).

        Days are calendar days in the Jira timezone (IST here). Saturday and Sunday are always off (required 0 h);
        time logged on a weekend still shows. Today is "in_progress" until the requirement is met. Cached 2 minutes.
        """
        tz = self.jira_tz()
        today = datetime.now(tz).date()
        if start is not None:
            end = min(end or today, today)
            days = max(0, (end - start).days + 1)
        else:
            end = today
            start = today - timedelta(days=days - 1)
        required = self.settings.daily_log_hours

        def load():
            q = jql_quote(person.account_id)
            cutoff = datetime.combine(start, datetime.min.time(), tz)
            issues = self.jira.search(f'worklogAuthor = {q} AND worklogDate >= "{start}" AND worklogDate <= "{end}" '
                                      "ORDER BY updated DESC", ["worklog", "summary", "status", "issuetype"], limit=500) if days else []
            per_day: dict = defaultdict(dict)                 # date -> issue key -> ticket row
            for i in issues:
                f = i["fields"]
                wl = f.get("worklog") or {}
                logs = wl.get("worklogs", [])
                if wl.get("total", 0) > len(logs):            # Jira embeds only the latest 20 worklogs
                    logs = self.jira.worklogs(i["key"], cutoff)
                for w in logs:
                    if (w.get("author") or {}).get("accountId") != person.account_id:
                        continue
                    started = parse_time(w.get("started"))
                    if not started:
                        continue
                    d = started.astimezone(tz).date()
                    if d < start or d > end:
                        continue
                    t = per_day[d].setdefault(i["key"], {
                        "key": i["key"], "summary": f.get("summary"), "status": (f.get("status") or {}).get("name"),
                        "type": (f.get("issuetype") or {}).get("name"), "url": self.jira.browse_url(i["key"]),
                        "seconds": 0, "notes": []})
                    t["seconds"] += w.get("timeSpentSeconds", 0)
                    note = " ".join(adf_text(w.get("comment")).split())
                    if note and note not in t["notes"]:
                        t["notes"].append(note)
            rows = []
            for n in range(days):
                d = end - timedelta(days=n)
                tickets = sorted(per_day.get(d, {}).values(), key=lambda t: -t["seconds"])
                seconds = sum(t["seconds"] for t in tickets)        # add exact seconds, round once (no 59.99h)
                for t in tickets:
                    t["hours"] = round(t.pop("seconds") / 3600, 4)
                hours = round(seconds / 3600, 4)
                weekend = d.weekday() >= 5
                need = 0.0 if weekend else required
                status = ("weekend" if weekend else "met" if hours >= need
                          else "in_progress" if d == today else "short")
                rows.append({"date": d.isoformat(), "weekday": d.strftime("%a"), "weekend": weekend,
                             "required_hours": need, "logged_hours": hours,
                             "short_by": round(max(0.0, need - hours), 4),
                             "extra": round(max(0.0, hours - need), 4),        # time over the requirement (all of it on weekends)
                             "status": status, "tickets": tickets})
            work = [r for r in rows if not r["weekend"]]
            # Only days that can be judged: finished working days, plus today once it already has enough time.
            # (A working day still in progress is neither met nor short yet - it isn't counted.)
            closed = [r for r in work if r["status"] != "in_progress"]
            return {
                "person": person.name, "from": start.isoformat(), "to": end.isoformat(), "days": days, "today": today.isoformat(),
                "timezone": str(tz), "required_hours_per_day": required,
                "summary": {
                    "working_days": len(closed),
                    "today_in_progress": any(r["status"] == "in_progress" for r in work),
                    "days_met": sum(r["status"] == "met" for r in work),
                    "days_short": sum(r["status"] == "short" for r in work),
                    "logged_hours": round(sum(r["logged_hours"] for r in rows), 2),
                    "required_hours": round(required * len(closed), 2),
                    "short_hours": round(sum(r["short_by"] for r in closed), 2),
                    "extra_hours": round(sum(r["extra"] for r in rows), 2),
                    "days_over": sum(r["extra"] > 0 for r in rows),
                },
                "rows": rows,
                "note": f"Required {required:g} h per working day (Monday to Friday). Saturday and Sunday are off.",
            }
        return self._cached(f"timelog:{person.account_id}:{start}:{end}:{today}", load, 120)

    # ------------------------------------------------------------------ a person's profile (their own page)
    def profile(self, person: Person, email: str | None = None) -> dict:
        """Everything Jira knows about one person, plus what they do in Jira. Cached 5 minutes per person.

        Identity fields the current token can't read are returned with value None and a "why", so the page shows
        them empty and they fill in by themselves with a stronger token (admin / service account with "Browse users").
        Job title, department, manager, phone and office are not in Jira's API at all.
        """
        acc = person.account_id
        if acc.startswith("email:"):                         # signed in, but no Jira account found for the email
            return {"linked": False, "name": None, "email": email or person.name, "avatar": None,
                    "fields": self._profile_fields(person, email or person.name, {}, "none"),
                    "note": "No Jira account was found for this email, so there is no Jira activity to show."}

        def load():
            user, source = self._profile_user(acc)
            q = jql_quote(acc)
            mine = f"assignee = {q} AND issuetype != Epic"
            with ThreadPoolExecutor(max_workers=6) as pool:
                f_now = pool.submit(self.person_issues, None, "open", "assignee", person)
                f_sprint = pool.submit(self.jira.search, f"{mine} AND sprint in openSprints()", ["status"])
                f_counts = {k: pool.submit(self.jira.count, jql) for k, jql in {
                    "finished": f"{mine} AND statusCategory = Done AND resolved >= -30d",
                    "bugs_fixed": f"{mine} AND issuetype = Bug AND statusCategory = Done AND resolved >= -30d",
                    "bugs_reported": f"reporter = {q} AND issuetype = Bug AND created >= -30d",
                    "tickets_created": f"reporter = {q} AND created >= -30d",
                }.items()}
                f_features = pool.submit(self.jira.search, f"{mine} AND updated >= -90d", ["components"], limit=300)
                f_recent = pool.submit(self.jira.search, f"(assignee = {q} OR reporter = {q}) ORDER BY updated DESC",
                                       ISSUE_FIELDS, limit=8, page_size=8)
                f_worklogs = pool.submit(self._worklogs_checked, 30, person)
                f_titles = pool.submit(self.naming_compliance, 30, "me", None, person)

                now, sprint_issues, recent = f_now.result(), f_sprint.result(), f_recent.result()
                worklogs, titles = f_worklogs.result(), f_titles.result()
                features = Counter(c["name"] for i in f_features.result() for c in i["fields"].get("components") or [])
                counts = {k: f.result() for k, f in f_counts.items()}

            sprint_done = sum(1 for i in sprint_issues if i["fields"]["status"]["statusCategory"]["key"] == "done")
            logs_ok = sum(1 for w in worklogs if not w["errors"])
            return {
                "linked": True,
                "name": (user.get("displayName") or person.name),
                "email": email or user.get("emailAddress"),
                "avatar": (user.get("avatarUrls") or {}).get("48x48"),
                "fields": self._profile_fields(person, email, user, source),
                "right_now": {"total": now["total"], "by_stage": now["by_stage"], "issues": now["issues"][:8]},
                "sprint": {"assigned": len(sprint_issues), "done": sprint_done, "not_done": len(sprint_issues) - sprint_done},
                "last_30_days": {
                    **counts,
                    "hours_logged": round(sum(w["seconds"] for w in worklogs) / 3600, 1),
                    "worklogs": len(worklogs),
                    "worklog_quality_pct": round(100 * logs_ok / len(worklogs)) if worklogs else None,
                    "titles_checked": titles["tickets_checked"],
                    "title_standard_pct": titles["compliance_pct"],
                },
                "top_features": [{"name": n, "issues": c} for n, c in features.most_common(5)],
                "recent": [self.slim(i) for i in recent],
                "note": "From live Jira. Counts for the last 30 days use Jira's own (approximate) count.",
            }
        return self._cached(f"profile:{acc}", load, 300)

    def _profile_user(self, account_id: str) -> tuple[dict, str]:
        """The person's Jira user record: the full profile if the token may read it, else the copy on their tickets."""
        try:
            if account_id == self.me().account_id:
                return self.jira.get("/rest/api/3/myself", expand="groups,applicationRoles"), "profile"
            return self.jira.get("/rest/api/3/user", accountId=account_id, expand="groups,applicationRoles"), "profile"
        except JiraError:
            pass                                             # no "Browse users": fall back to their tickets
        q = jql_quote(account_id)
        for fld in ("assignee", "reporter"):
            try:
                hits = self.jira.search(f"{fld} = {q} ORDER BY updated DESC", [fld], limit=1, page_size=1)
            except JiraError:
                continue
            if hits and (hits[0]["fields"].get(fld) or {}).get("accountId") == account_id:
                return hits[0]["fields"][fld], "tickets"
        return {}, "none"

    @staticmethod
    def _profile_fields(person: Person, email: str | None, user: dict, source: str) -> list[dict]:
        """Every profile field, in display order. value None = not available with the current token (see "why")."""
        browse = "Needs a Jira token with the \"Browse users\" permission (an admin or service-account token)."
        directory = ("Not in Jira's API, even with an admin token: it lives in the Atlassian organization directory "
                     "or Google Workspace.")
        groups = user.get("groups") if isinstance(user.get("groups"), dict) else None
        roles = user.get("applicationRoles") if isinstance(user.get("applicationRoles"), dict) else None
        has_jira = source != "none"
        if not has_jira:                                     # no Jira account at all: say that, not "needs a token"
            browse = "No Jira account was found for this email."

        def field(label, value, why=None):
            return {"label": label, "value": value if value not in ("", [], None) else None, "why": None if value else why}
        return [
            field("Name", user.get("displayName") or (person.name if has_jira else None), "No Jira account found for this email."),
            field("Email", email or user.get("emailAddress"), "Jira hides this person's email."),
            field("Jira account ID", person.account_id if has_jira else None, "No Jira account found for this email."),
            field("Account status", ("Active" if user.get("active", True) else "Deactivated") if has_jira else None, browse),
            field("Account type", {"atlassian": "Person", "app": "App / bot", "customer": "Customer"}.get(user.get("accountType", ""), user.get("accountType")), browse),
            field("Time zone", user.get("timeZone"), browse),
            field("Language", (user.get("locale") or "").replace("_", "-") or None, browse),
            field("Role (team.yaml)", person.role if person.role and person.role != "unknown" else None,
                  "Not set in team.yaml (make roles)."),
            field("Team (team.yaml)", person.team, "Not set in team.yaml."),
            field("Jira groups", ", ".join(g["name"] for g in groups.get("items", [])) if groups else None, browse),
            field("Jira products", ", ".join(r.get("name", "") for r in roles.get("items", [])) if roles else None, browse),
            field("Job title", None, directory),
            field("Department", None, directory),
            field("Manager", None, directory),
            field("Phone", None, directory),
            field("Office / location", None, directory),
        ]

    def naming_compliance(self, days: int = 30, who: str | None = None, feature: str | None = None,
                          me: Person | None = None) -> dict:
        """Ticket titles created in the last `days` days, checked against the naming standard.

        Each ticket is charged to the person who CREATED it (they wrote the title).
        """
        person, match_note = self.match_person(who, me) if who else (None, None)
        checked, jql = self._naming_checked(days, feature, person)

        per: dict[str, dict] = {}
        rules: Counter = Counter()
        by_type: dict[str, Counter] = defaultdict(Counter)
        compliant_total = 0
        for c in checked:
            i, author, errors = c["issue"], c["author"], c["errors"]
            f = i["fields"]
            itype = f["issuetype"]["name"]
            ok = not errors
            compliant_total += ok
            by_type[itype]["total"] += 1
            by_type[itype]["compliant"] += ok
            row = per.setdefault(author["accountId"], {"name": author["displayName"], "created": 0,
                                                       "violations": 0, "rules": Counter(), "examples": []})
            row["created"] += 1
            if not ok:
                row["violations"] += 1
                for rule in c["error_rules"]:
                    rules[rule] += 1
                    row["rules"][rule] += 1
                if len(row["examples"]) < 5:
                    row["examples"].append({"key": i["key"], "type": itype, "title": f.get("summary"),
                                            "problems": [x.message for x in errors], "url": self.jira.browse_url(i["key"])})
        people = []
        for r in per.values():
            r["compliance_pct"] = round(100 * (r["created"] - r["violations"]) / r["created"])
            r["top_problems"] = [RULE_LABELS[k] for k, _ in r.pop("rules").most_common(3)]
            people.append(r)
        people.sort(key=lambda r: (-r["violations"], r["compliance_pct"]))
        total = sum(r["created"] for r in people)
        return {
            "days": days,
            "standard": "Jira Ticket Naming Convention Standard: [Work Type] [Module | ] Action or outcome",
            "person": person.name if person else "everyone",
            "name_match_note": match_note,
            "tickets_checked": total,
            "compliant": compliant_total,
            "compliance_pct": round(100 * compliant_total / total) if total else None,
            "people_checked": len(people),
            "people_with_bad_titles": sum(1 for p in people if p["violations"]),
            "people_listed": min(MAX_LIST, sum(1 for p in people if p["violations"])),
            "by_rule": [{"rule": k, "label": RULE_LABELS[k], "count": c} for k, c in rules.most_common()],
            "by_type": {t: {"total": c["total"], "compliant_pct": round(100 * c["compliant"] / c["total"])}
                        for t, c in sorted(by_type.items(), key=lambda kv: -kv[1]["total"])},
            "people_not_following": [p for p in people if p["violations"]][:MAX_LIST],
            "people_fully_compliant": [p["name"] for p in people if not p["violations"]],
            "jql": jql,
            "note": "Rule-based check of titles. Charged to the ticket creator. by_rule counts tickets (once per rule).",
        }

    def naming_tickets(self, days: int = 30, rule: str | None = None, person: str | None = None) -> dict:
        """Drill-down: every ticket from the period whose title breaks the standard (one rule and/or one creator)."""
        checked, jql = self._naming_checked(days)
        who = self.resolve_person(person) if person else None
        rows = []
        for c in checked:
            if not c["errors"] or (rule and rule not in c["error_rules"]):
                continue
            if who and c["author"]["accountId"] != who.account_id:
                continue
            rows.append({**self.slim(c["issue"]), "creator": c["author"]["displayName"],
                         "problems": [x.message for x in c["errors"]]})
        label = RULE_LABELS.get(rule or "", "Titles not following the standard")
        title = " · ".join(b for b in [who.name if who else "", label, f"last {days} days"] if b)
        return self._drill_result(
            title, rows, fallback_jql=jql,
            note="Charged to the person who created the ticket (they wrote the title).",
            ask_prompt=(f"For tickets created in the last {days} days with the problem \"{label}\""
                        f"{' by ' + who.name if who else ''}, suggest better titles that follow our naming standard."))

    def _worklogs_checked(self, days: int, person: Person | None = None) -> list[dict]:
        """Every worklog started in the last N days with its convention findings, newest first. Cached 5 minutes."""
        jql = f"worklogDate >= -{days}d" + (f" AND worklogAuthor = {jql_quote(person.account_id)}" if person else "")

        def load():
            cutoff = datetime.now(timezone.utc) - timedelta(days=days)
            out = []
            for i in self.jira.search(jql, ["worklog", "summary", "status", "issuetype"]):
                f = i["fields"]
                wl = f.get("worklog") or {}
                logs = wl.get("worklogs", [])
                if wl.get("total", 0) > len(logs):
                    logs = self.jira.worklogs(i["key"], cutoff)
                for w in logs:
                    started = parse_time(w.get("started"))
                    if not is_human(w.get("author")) or not started or started < cutoff:
                        continue
                    if person and w["author"]["accountId"] != person.account_id:
                        continue
                    note = " ".join(adf_text(w.get("comment")).split())
                    errors = [x for x in check_worklog(note, self.settings.worklog_tags) if x.severity == "error"]
                    out.append({"key": i["key"], "summary": f.get("summary"),
                                "status": (f.get("status") or {}).get("name", ""),
                                "type": (f.get("issuetype") or {}).get("name", ""),
                                "author": w["author"], "note": note, "time": w.get("timeSpent"),
                                "seconds": w.get("timeSpentSeconds", 0), "started": started,
                                "errors": errors, "error_rules": sorted({x.rule for x in errors})})
            out.sort(key=lambda r: r["started"], reverse=True)
            return out
        return self._cached(f"worklogs_checked:{jql}", load, 300)

    def worklog_quality(self, days: int = 7, who: str | None = None, me: Person | None = None) -> dict:
        """Worklogs from the last `days` days checked against the team's convention: "[Category] what was done".

        The convention isn't in the naming PDF - it's what 98% of the team's own worklogs already do.
        """
        person, match_note = self.match_person(who, me) if who else (None, None)
        per: dict[str, dict] = {}
        rules: Counter = Counter()
        tags_used: Counter = Counter()
        for c in self._worklogs_checked(days, person):
            note = c["note"]
            if note.startswith("["):
                tags_used[note[1:note.find("]")].strip().title() if "]" in note else "?"] += 1
            row = per.setdefault(c["author"]["accountId"], {"name": c["author"]["displayName"], "logs": 0,
                                                            "hours": 0.0, "violations": 0, "rules": Counter(),
                                                            "examples": []})
            row["logs"] += 1
            row["hours"] += c["seconds"] / 3600
            if c["errors"]:
                row["violations"] += 1
                for rule in c["error_rules"]:
                    rules[rule] += 1
                    row["rules"][rule] += 1
                if len(row["examples"]) < 3:
                    row["examples"].append({"key": c["key"], "time": c["time"], "note": note or "(empty)",
                                            "problems": [x.message for x in c["errors"]],
                                            "url": self.jira.browse_url(c["key"])})
        people = []
        for r in per.values():
            r["hours"] = round(r["hours"], 1)
            r["compliance_pct"] = round(100 * (r["logs"] - r["violations"]) / r["logs"])
            r["top_problems"] = [WORKLOG_LABELS[k] for k, _ in r.pop("rules").most_common(2)]
            people.append(r)
        people.sort(key=lambda r: (-r["violations"], r["compliance_pct"]))
        total = sum(r["logs"] for r in people)
        bad = sum(r["violations"] for r in people)
        return {
            "days": days,
            "convention": "[Category] what was done   e.g. [Dev] Add version filter to submissions report",
            "person": person.name if person else "everyone",
            "name_match_note": match_note,
            "worklogs_checked": total,
            "compliant": total - bad,
            "compliance_pct": round(100 * (total - bad) / total) if total else None,
            "people_checked": len(people),
            "people_with_bad_worklogs": sum(1 for p in people if p["violations"]),
            "people_listed": min(MAX_LIST, sum(1 for p in people if p["violations"])),
            "by_rule": [{"rule": k, "label": WORKLOG_LABELS[k], "count": c} for k, c in rules.most_common()],
            "tags_used": dict(tags_used.most_common(10)),
            "people_not_following": [p for p in people if p["violations"]][:MAX_LIST],
            "people_fully_compliant": [p["name"] for p in people if not p["violations"]],
            "note": "Convention inferred from the team's own worklogs (not in the naming PDF). Tags: WORKLOG_TAGS in .env.",
        }

    def worklog_entries(self, days: int = 7, rule: str | None = None, person: str | None = None) -> dict:
        """Drill-down: every worklog from the period that breaks the convention (one rule and/or one person)."""
        who = self.resolve_person(person) if person else None
        rows = []
        for c in self._worklogs_checked(days):
            if not c["errors"] or (rule and rule not in c["error_rules"]):
                continue
            if who and c["author"]["accountId"] != who.account_id:
                continue
            rows.append({"key": c["key"], "summary": c["summary"], "type": c["type"], "status": c["status"],
                         "priority": "", "assignee": c["author"]["displayName"], "components": [], "updated": "",
                         "url": self.jira.browse_url(c["key"]), "note": c["note"], "time": c["time"],
                         "started": f"{c['started']:%d %b}", "problems": [x.message for x in c["errors"]]})
        label = WORKLOG_LABELS.get(rule or "", "Worklogs not following “[Category] what was done”")
        title = " · ".join(b for b in [who.name if who else "", label, f"last {days} days"] if b)
        return self._drill_result(
            title, rows, fallback_jql=f"worklogDate >= -{days}d",
            note="Each row is one worklog; it opens the ticket the time was logged on.",
            ask_prompt=(f"Who logged time without a proper worklog description in the last {days} days"
                        f"{' (' + who.name + ')' if who else ''}, and what should those worklogs say?"))

    def _drill_result(self, title: str, rows: list[dict], fallback_jql: str = "", note: str | None = None,
                      ask_prompt: str | None = None) -> dict:
        """Common shape for click-through lists built from already-checked rows."""
        keys = list(dict.fromkeys(r["key"] for r in rows))
        jql = f"key in ({', '.join(keys[:100])})" if keys else fallback_jql
        if len(keys) > 100:
            note = (note + " " if note else "") + "Open in Jira shows the first 100."
        return {"title": title, "total": len(rows), "issues": rows[: self.DRILL_LIMIT],
                "truncated": len(rows) > self.DRILL_LIMIT, "jql": jql,
                "jira_link": f"{self.jira.base_url}/issues/?jql={quote(jql)}", "note": note, "ask_prompt": ask_prompt}

    # ------------------------------------------------------------------ drill-down (click a chart -> the tickets)
    DRILL_LIMIT = 200          # rows sent to the page
    DRILL_SCAN_LIMIT = 3000    # tickets counted (safety cap; a 90-day bug list is ~460)

    def drilldown(self, kind: str, **p) -> dict:
        """The tickets behind one chart mark.

        kind: bugs_week {week: "YYYY-MM-DD"}            bugs created in that week (Mon..Sun)
              bugs_feature {feature, days, state?}      bugs in one component (state = open|fixed_unreleased|fixed|invalid)
              bugs_state {days, state?}                 all bugs in the period, optionally one state
              sprint_status {status}                    open-sprint issues in one workflow status
              person_active {name}                      a person's active issues
              naming_rule {days, rule?, person?}        tickets whose titles break the naming standard
              worklog_rule {days, rule?, person?}       worklogs that break "[Category] what was done"
              sprint_outcome {sprint, outcome?, ...}    the tickets behind a sprint-report number
        """
        if kind == "naming_rule":
            return self.naming_tickets(int(p.get("days") or 30), p.get("rule") or None, p.get("person") or None)
        if kind == "worklog_rule":
            return self.worklog_entries(int(p.get("days") or 7), p.get("rule") or None, p.get("person") or None)
        state = p.get("state") or None
        proj = self.resolve_project(p["project"]) if p.get("project") else None
        scope = f" AND project = {proj['key']}" if proj else ""
        in_proj = f" · {proj['name']}" if proj else ""
        if kind == "bugs_week":
            start = datetime.strptime(p["week"], "%Y-%m-%d").date()
            end = start + timedelta(days=7)
            jql = f'issuetype = Bug{scope} AND created >= "{start}" AND created < "{end}" ORDER BY created DESC'
            title = f"Bugs reported in the week of {start:%d %b}{in_proj}"
        elif kind in ("bugs_feature", "bugs_state"):
            days = int(p.get("days", 30))
            feature = p.get("feature")
            where = ""
            if kind == "bugs_feature":
                where = " AND component is EMPTY" if feature == "No component" else f" AND component = {jql_quote(feature)}"
            jql = f"issuetype = Bug{scope}{where} AND created >= -{days}d ORDER BY created DESC"
            label = {"open": "open", "fixed_unreleased": "fixed, not released", "fixed": "fixed",
                     "invalid": "invalid"}.get(state or "", "")
            title = (f"{label.capitalize() + ' bugs' if label else 'Bugs'}{' in ' + feature if feature else ''}"
                     f"{in_proj} · last {days} days")
        elif kind == "sprint_status":
            jql = (f"sprint in openSprints() AND status = {jql_quote(p['status'])} AND issuetype != Epic "
                   "ORDER BY priority DESC, updated DESC")
            title = f"Current sprint · {p['status']}"
        elif kind == "person_active":
            person = self.resolve_person(p["name"])
            jql = (f"assignee = {jql_quote(person.account_id)} AND status in ({self._status_list()}) "
                   "AND issuetype != Epic ORDER BY updated DESC")
            title = f"{person.name} · active issues"
        elif kind == "person_open":
            person = self.resolve_person(p["name"])
            jql = (f"assignee = {jql_quote(person.account_id)} AND statusCategory != Done "
                   "AND issuetype != Epic ORDER BY updated DESC")
            title = f"{person.name} · open issues"
        elif kind == "sprint_outcome":
            return self.sprint_tickets(p.get("sprint"), p.get("outcome"), p.get("project"), p.get("person"), p.get("flag"))
        else:
            raise ValueError(f"unknown drill-down kind {kind!r}")

        # Count EVERYTHING (the number must match the chart), but only send the first DRILL_LIMIT rows to the page.
        issues = self.jira.search(jql, ISSUE_FIELDS + ["resolution"], limit=self.DRILL_SCAN_LIMIT)
        hit_scan_limit = len(issues) >= self.DRILL_SCAN_LIMIT
        if state:
            issues = [i for i in issues if bug_state(i) == state]
        rows = [self.slim(i) for i in issues]
        rows.sort(key=lambda r: (_rank(r["status"], STATUS_ORDER), _rank(r["priority"], PRIORITY_ORDER)))
        notes = []
        if state:
            notes.append("Open in Jira shows every state; this list is filtered to the one you clicked.")
        if hit_scan_limit:
            notes.append(f"Only the first {self.DRILL_SCAN_LIMIT} matching tickets were scanned - narrow the period.")
        return {
            "title": title,
            "total": len(rows),
            "issues": rows[: self.DRILL_LIMIT],
            "truncated": len(rows) > self.DRILL_LIMIT,
            "jql": jql,
            "jira_link": f"{self.jira.base_url}/issues/?jql={quote(jql)}",
            "note": " ".join(notes) or None,
        }

    # ------------------------------------------------------------------ 6. generic + lookups
    def search_issues(self, jql: str, limit: int = MAX_LIST) -> dict:
        """Any JQL query (read-only). For questions the other tools don't cover."""
        jql = fix_jql(jql)
        issues = self.jira.search(jql, ISSUE_FIELDS, limit=min(limit, MAX_LIST))
        total = self.jira.count(jql)
        out = {"jql": jql, "total_estimate": total, "shown": len(issues), "issues": [self.slim(i) for i in issues]}
        if not issues:
            out["hint"] = ("0 results. Before saying 'none', check the query: status names are " + ", ".join(
                f'"{w}"' for w in WORKFLOW) + '; statusCategory is "To Do", "In Progress" or "Done"; '
                "epics have no component (use project = KEY); projects use their KEY.")
        return out

    def list_features(self, query: str | None = None) -> dict:
        feats = self.features()
        if query:
            q = query.lower()
            feats = [f for f in feats if q in f["name"].lower() or q in f["project_name"].lower()]
        by_project: dict[str, list[str]] = defaultdict(list)
        for f in feats:
            by_project[f"{f['project_name']} ({f['project']})"].append(f["name"])
        return {"count": len(feats), "features_by_project": dict(by_project)}

    def team(self) -> dict:
        r = self.roster()
        return {"source": r.source, "count": len(r.people),
                "by_role": dict(Counter(p.role for p in r.people)),
                "people": [{"name": p.name, "role": p.role, "team": p.team} for p in r.people]}
