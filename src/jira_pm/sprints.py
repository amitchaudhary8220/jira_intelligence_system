"""Sprint reports: what a sprint delivered, what slipped, and per-person sprint stats.

How this company runs sprints (found in Jira, Nov 2026):
  - Every scrum board (13 of them) has its OWN copy of each sprint, all with the same name and dates
    ("Q4 FY26 - Sprint 3" exists on 13 boards). So a company sprint = all board-sprints with one name.
  - Final status is "Released" (Done category). "Ready to deploy" / "Deployed on Staging" / "In QA" mean the
    dev work is finished but the ticket has not shipped.
  - Story points are not used (0 of 581 Sprint 3 issues), so delivery is counted in tickets, not points.
  - 77% of bugs carry a "Relates" link to the task they were found in -> bugs can be traced to that task's assignee.

Outcome of each sprint ticket (for a closed sprint, judged at the sprint's end date):
  released          Done-category and resolved by the end of the sprint            -> delivered
  done_after        Done now, but resolved after the sprint ended                   -> not delivered in the sprint
  dev_complete      In QA / Deployed on Staging / Ready to deploy                   -> not delivered (waiting to ship)
  in_progress       In Progress / In Review / Ready to merge                        -> not delivered
  not_started       To Do / On Hold / Ideation / Reopened ...                       -> not delivered
  carried_over      not delivered AND also placed in a later sprint
  added_mid_sprint  put into the sprint after it started (from the issue's change history)

Per-person numbers are facts to talk about, not a single "efficiency score": hours logged reward logging,
ticket counts ignore size, and bug counts depend on how hard the area is. The highlights name a leader per
metric instead of ranking people on one number.
"""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from .jira_client import is_human, jql_quote, parse_time

DEV_COMPLETE = {"In QA", "Deployed on Staging", "Ready to deploy"}
BACK_FROM = {"Released", "Done", "Ready to deploy", "Deployed on Staging", "In QA"}
BACK_TO = {"To Do", "In Progress", "Reopened", "Issue Reported"}
NOT_A_BUG = {"invalid", "duplicate", "won't do", "won't fix", "cannot reproduce", "rejected", "cancelled", "not a bug"}
OUTCOMES = ["released", "done_after", "dev_complete", "in_progress", "not_started"]
OUTCOME_LABELS = {"released": "Released", "done_after": "Finished after the sprint", "dev_complete": "Dev done, not released",
                  "in_progress": "Still in progress", "not_started": "Not started"}


def _iso(ts: str | None) -> datetime | None:
    """Agile API dates: '2026-10-29T05:30:00.000Z'."""
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def sprint_key(name: str) -> str:
    """Spellings that mean the same sprint: case, en/em dashes and extra spaces don't matter."""
    return " ".join(name.lower().replace("–", "-").replace("—", "-").split())


def _sprint_keys(field_text: str | None) -> set[str]:
    """Jira's change history lists a ticket's sprints as 'Sprint A, Sprint B'. Compare whole names, so that
    'Sprint 1' is not mistaken for 'Sprint 10'."""
    return {sprint_key(n) for n in (field_text or "").split(",") if n.strip()}


def sprint_window(sp: dict, now: datetime | None = None) -> tuple[datetime, datetime, bool, datetime]:
    """(start, end, ended, cutoff). A sprint is judged at its END DATE once that has passed, even if some
    boards never clicked "Complete". cutoff = end + 1 day of grace for late-evening releases."""
    now = now or datetime.now(timezone.utc)
    start = _iso(sp.get("start")) or now
    end = _iso(sp.get("end")) or now
    ended = end < now
    return start, end, ended, (end + timedelta(days=1) if ended else now)


def classify(f: dict, ended: bool, cutoff: datetime, active_statuses: set[str]) -> str:
    """The outcome of one sprint ticket. Used by the report AND the trend, so their numbers always agree."""
    status = f["status"]["name"]
    if f["status"]["statusCategory"]["key"] == "done":
        resolved = parse_time(f.get("resolutiondate"))
        return "released" if (not ended or (resolved and resolved <= cutoff)) else "done_after"
    if status in DEV_COMPLETE:
        return "dev_complete"
    if status in active_statuses:
        return "in_progress"
    return "not_started"


def _is_invalid(f: dict) -> bool:
    status = (f.get("status") or {}).get("name", "").lower()
    resolution = ((f.get("resolution") or {}).get("name") or "").lower()
    return status in NOT_A_BUG or resolution in NOT_A_BUG


class SprintMixin:
    """Mixed into PMService (needs self.jira, self._cached, self.settings, self.slim, self.resolve_project)."""

    # ------------------------------------------------------------------ which sprints exist
    def sprint_list(self) -> list[dict]:
        """Company sprints (grouped by name across boards), newest first."""
        def load():
            boards, start = [], 0
            while True:
                d = self.jira.get("/rest/agile/1.0/board", startAt=start, maxResults=50)
                boards += d["values"]
                if d.get("isLast", True):
                    break
                start += len(d["values"])
            groups: dict[str, list[dict]] = defaultdict(list)
            for b in boards:
                if b.get("type") != "scrum":
                    continue
                st = 0
                while True:
                    d = self.jira.get(f"/rest/agile/1.0/board/{b['id']}/sprint", state="active,closed", startAt=st, maxResults=50)
                    for sp in d["values"]:
                        groups[sprint_key(sp["name"])].append({**sp, "board": b["name"]})
                    if d.get("isLast", True):
                        break
                    st += len(d["values"])
            now = datetime.now(timezone.utc)
            out = []
            for sps in groups.values():
                spellings = Counter(x["name"] for x in sps)        # "Tasks Completed < 1 Jul" + "Tasks completed < 1 Jul"
                name = spellings.most_common(1)[0][0]
                starts = [_iso(x.get("startDate")) for x in sps if x.get("startDate")]
                ends = [_iso(x.get("endDate")) for x in sps if x.get("endDate")]
                end = max(ends) if ends else None
                active = [x for x in sps if x["state"] == "active"]
                out.append({
                    "name": name,
                    "names": sorted(spellings),                     # every spelling used on some board
                    "ids": [x["id"] for x in sps],
                    "boards": len(sps),
                    "state": "active" if active else "closed",
                    "start": min(starts).isoformat() if starts else None,
                    "end": end.isoformat() if end else None,
                    # boards that never closed this sprint although its end date has passed
                    "still_open_after_end": sorted(x["board"] for x in active if end and end < now - timedelta(days=1)),
                })
            out.sort(key=lambda s: s["start"] or "", reverse=True)
            return out
        return self._cached("sprint_list", load, seconds=900)

    def resolve_sprint(self, text: str | None = None) -> dict:
        """'' / 'current' -> the newest active sprint; 'last' / 'previous' -> the newest closed one;
        otherwise match by name ('sprint 3' -> 'Q4 FY26 - Sprint 3')."""
        sprints = self.sprint_list()
        if not sprints:
            raise LookupError("No sprints found on any scrum board.")
        t = " ".join((text or "").lower().replace("–", "-").split())
        if t in ("", "current", "active", "this", "this sprint", "current sprint", "abhi wala"):
            return next((s for s in sprints if s["state"] == "active"), sprints[0])
        if t in ("last", "previous", "last sprint", "previous sprint", "pichla", "pichla sprint"):
            newest_active = next((i for i, s in enumerate(sprints) if s["state"] == "active"), -1)
            return sprints[newest_active + 1] if newest_active + 1 < len(sprints) else sprints[-1]
        norm = sprint_key
        exact = [s for s in sprints if norm(s["name"]) == norm(t)]
        if exact:
            return exact[0]
        hits = [s for s in sprints if t in norm(s["name"])]
        if hits:
            return hits[0]                           # newest first, so "sprint 3" -> the most recent Sprint 3
        raise LookupError(f"No sprint matching '{text}'. Recent sprints: " + ", ".join(s["name"] for s in sprints[:6]))

    # ------------------------------------------------------------------ one sprint
    def sprint_report(self, sprint: str | None = None) -> dict:
        sp = self.resolve_sprint(sprint)
        ended = sprint_window(sp)[2]
        return self._cached(f"sprint_report:{sp['name']}", lambda: self._build_sprint_report(sp),
                            seconds=3600 if ended else 300)        # finished sprints barely change

    def _build_sprint_report(self, sp: dict) -> dict:
        now = datetime.now(timezone.utc)
        start, end, closed, cutoff = sprint_window(sp, now)
        window_end = end if closed else now
        sf = self.jira.sprint_field()
        active_statuses = set(self.settings.active_statuses)

        this_key = sprint_key(sp["name"])
        ids = ", ".join(str(i) for i in sp["ids"])
        issues = self.jira.search(
            f"sprint in ({ids}) AND issuetype != Epic",
            ["summary", "status", "issuetype", "assignee", "priority", "resolutiondate", "created", "components",
             "project", "parent"] + ([sf] if sf else []), expand="changelog")

        rows = []
        # delivered = top-level work items (Story/Task/Bug/...). Sub-tasks are counted separately: one feature can be
        # split into 20 sub-tasks, so counting them equally would reward splitting, not delivering.
        dev = defaultdict(lambda: {"issues": 0, "delivered": 0, "subtasks_done": 0, "not_delivered": 0, "reopened": 0,
                                   "delivered_types": Counter(), "hours": 0.0, "bugs_in_their_work": 0})
        by_project: dict[str, Counter] = defaultdict(Counter)
        totals = Counter()
        reopened_total = 0
        for i in issues:
            f = i["fields"]
            outcome = classify(f, closed, cutoff, active_statuses)

            later = [s for s in (f.get(sf) or []) if sprint_key(s.get("name") or "") != this_key
                     and (s.get("startDate") or "") > (sp["start"] or "")]
            carried = outcome != "released" and bool(later)

            histories = (i.get("changelog") or {}).get("histories", [])
            total_h = (i.get("changelog") or {}).get("total", 0)
            if total_h > len(histories):
                histories = self.jira.changelog_tail(i["key"], total_h)
            added_mid = False
            reopened = 0
            for h in histories:
                when = parse_time(h.get("created"))
                if not when:
                    continue
                for it in h.get("items", []):
                    if it.get("field") == "Sprint" and this_key in _sprint_keys(it.get("toString")) \
                            and this_key not in _sprint_keys(it.get("fromString")) and when > start + timedelta(hours=12):
                        added_mid = True
                    if it.get("field") == "status" and start <= when <= cutoff and (
                            (it.get("toString") or "") == "Reopened"
                            or ((it.get("fromString") or "") in BACK_FROM and (it.get("toString") or "") in BACK_TO)):
                        reopened += 1

            project = f["project"]["key"]
            totals[outcome] += 1
            totals["carried_over"] += carried
            totals["added_mid_sprint"] += added_mid
            reopened_total += reopened
            by_project[project][outcome] += 1

            a = f.get("assignee")
            if is_human(a):
                d = dev[a["displayName"]]
                d["issues"] += 1
                d["reopened"] += reopened
                if outcome == "released" and f["issuetype"].get("subtask"):
                    d["subtasks_done"] += 1
                elif outcome == "released":
                    d["delivered"] += 1
                    d["delivered_types"][f["issuetype"]["name"]] += 1
                else:
                    d["not_delivered"] += 1
            rows.append({**self.slim(i), "outcome": outcome, "project": project, "carried_over": carried,
                         "added_mid_sprint": added_mid, "reopened": reopened})

        # hours logged during the sprint (any ticket), per person
        for name, hours in self._hours_logged(start, window_end).items():
            dev[name]["hours"] = round(hours, 1)

        # bugs found during the sprint: per reporter (testers) and per assignee of the task they're linked to
        bug_stats = self._bug_stats(start, window_end)
        for name, n in bug_stats["by_developer"].items():
            dev[name]["bugs_in_their_work"] = n

        roles = {p.name: p.role for p in self.roster().people}
        developers = []
        for name, d in dev.items():
            if not d["issues"] and not d["hours"]:
                continue
            developers.append({"name": name, "role": roles.get(name, "unknown"),
                               **{k: v for k, v in d.items() if k != "delivered_types"},
                               "delivered_types": dict(d["delivered_types"])})
        developers.sort(key=lambda r: (-r["delivered"], -r["subtasks_done"], -r["hours"]))
        for t in bug_stats["testers"]:
            t["role"] = roles.get(t["name"], "unknown")

        in_sprint = len(rows)
        released = totals["released"]
        self._cache[f"sprint_rows:{sp['name']}"] = (now.timestamp(), rows)
        return {
            "sprint": {k: sp[k] for k in ("name", "state", "start", "end", "boards", "still_open_after_end")},
            "as_of": f"sprint end ({end:%d %b})" if closed else "now (sprint still running)",
            "totals": {
                "in_sprint": in_sprint,
                **{o: totals[o] for o in OUTCOMES},
                "not_delivered": in_sprint - released,
                "carried_over": totals["carried_over"],
                "added_mid_sprint": totals["added_mid_sprint"],
                "reopened": reopened_total,
                "delivered_pct": round(100 * released / in_sprint) if in_sprint else None,
            },
            "by_project": sorted(({"project": p, **{o: c[o] for o in OUTCOMES}, "total": sum(c.values())}
                                  for p, c in by_project.items()), key=lambda r: -r["total"]),
            "developers": developers,
            "testers": bug_stats["testers"],
            "bugs_found": bug_stats["summary"],
            "highlights": self._highlights(developers, bug_stats["testers"]),
            # sprint-level notes (shown on the Sprints tab) vs notes about the per-person numbers (used by the chat)
            "notes": [
                "Delivered = Released/Done by the sprint's end date. 'Dev done, not released' still counts as not delivered.",
                "Story points aren't used in this Jira, so delivery is counted in tickets, not size.",
                "For a closed sprint, undelivered tickets show where they are NOW, which may be further along than at sprint end.",
            ],
            "people_notes": [
                "Developer 'delivered' counts top-level tickets (story/task/bug...); sub-tasks are shown separately.",
                "Bugs 'in their work' = valid bugs reported during the sprint and linked to a ticket assigned to them.",
            ],
        }

    def _hours_logged(self, start: datetime, end: datetime) -> dict[str, float]:
        issues = self.jira.search(f'worklogDate >= "{start:%Y-%m-%d}" AND worklogDate <= "{end:%Y-%m-%d}"', ["worklog"])
        hours: dict[str, float] = defaultdict(float)
        for i in issues:
            wl = i["fields"].get("worklog") or {}
            logs = wl.get("worklogs", [])
            if wl.get("total", 0) > len(logs):
                logs = self.jira.worklogs(i["key"], start)
            for w in logs:
                started = parse_time(w.get("started"))
                if is_human(w.get("author")) and started and start <= started <= end + timedelta(days=1):
                    hours[w["author"]["displayName"]] += w.get("timeSpentSeconds", 0) / 3600
        return hours

    def _bug_stats(self, start: datetime, end: datetime, project: str | None = None) -> dict:
        scope = f" AND project = {project}" if project else ""
        bugs = self.jira.search(
            f'issuetype = Bug{scope} AND created >= "{start:%Y-%m-%d}" AND created <= "{end + timedelta(days=1):%Y-%m-%d}"',
            ["reporter", "status", "priority", "resolution", "issuelinks"])
        testers = defaultdict(lambda: {"reported": 0, "valid": 0, "invalid": 0, "high_priority": 0, "fixed": 0})
        linked_to: dict[str, set[str]] = defaultdict(set)      # task key -> bug keys
        for b in bugs:
            f = b["fields"]
            invalid = _is_invalid(f)
            r = f.get("reporter")
            if is_human(r):
                t = testers[r["displayName"]]
                t["reported"] += 1
                t["invalid" if invalid else "valid"] += 1
                if not invalid and (f.get("priority") or {}).get("name") in ("Highest", "High"):
                    t["high_priority"] += 1
                if not invalid and f["status"]["statusCategory"]["key"] == "done":
                    t["fixed"] += 1
            if invalid:
                continue
            for link in f.get("issuelinks") or []:
                other = link.get("outwardIssue") or link.get("inwardIssue") or {}
                otype = ((other.get("fields") or {}).get("issuetype") or {}).get("name", "")
                if other.get("key") and otype not in ("Bug", "Epic"):
                    linked_to[other["key"]].add(b["key"])

        by_developer: Counter = Counter()
        keys = list(linked_to)
        for chunk in (keys[i:i + 100] for i in range(0, len(keys), 100)):
            for task in self.jira.search(f"key in ({', '.join(chunk)})", ["assignee"]):
                a = task["fields"].get("assignee")
                if is_human(a):
                    by_developer[a["displayName"]] += len(linked_to[task["key"]])

        rows = [{"name": n, **v, "invalid_pct": round(100 * v["invalid"] / v["reported"]) if v["reported"] else 0}
                for n, v in testers.items()]
        rows.sort(key=lambda r: (-r["valid"], -r["high_priority"]))
        return {
            "testers": rows,
            "by_developer": dict(by_developer),
            "summary": {"reported": len(bugs), "valid": sum(r["valid"] for r in rows), "invalid": sum(r["invalid"] for r in rows),
                        "linked_to_a_task": sum(len(v) for v in linked_to.values())},
        }

    @staticmethod
    def _highlights(developers: list[dict], testers: list[dict]) -> list[dict]:
        """A leader per metric, not one combined 'efficiency' score. People marked qa/pm/design in team.yaml
        don't win developer awards (until roles are set, everyone counts)."""
        out = []
        developers = [d for d in developers if d.get("role", "unknown") in ("dev", "devops", "lead", "unknown")]

        def best(rows, key, label, unit, min_value=1, reverse=True, extra=None):
            pool = [r for r in rows if r.get(key, 0) >= min_value and (extra is None or extra(r))]
            if pool:
                top = sorted(pool, key=lambda r: r[key], reverse=reverse)[0]
                out.append({"title": label, "name": top["name"], "value": top[key], "unit": unit})

        best(developers, "delivered", "Most tickets delivered", "tickets")
        clean = [r for r in developers if r["delivered"] >= 3 and r["bugs_in_their_work"] == 0 and r["reopened"] == 0]
        if clean:
            top = sorted(clean, key=lambda r: -r["delivered"])[0]
            out.append({"title": "Cleanest delivery", "name": top["name"], "value": top["delivered"],
                        "unit": "tickets, 0 bugs found, 0 reopened"})
        best(developers, "hours", "Most hours logged", "h")
        best(testers, "valid", "Top bug finder", "valid bugs")
        best(testers, "high_priority", "Most high-priority finds", "High/Highest bugs")
        return out

    # ------------------------------------------------------------------ across sprints
    def sprint_trend(self, last: int = 6) -> list[dict]:
        """Delivered % for the last N sprints, classified exactly like the sprint report's tiles."""
        def load():
            active_statuses = set(self.settings.active_statuses)
            out = []
            for sp in self.sprint_list()[:last]:
                _, _, ended, cutoff = sprint_window(sp)
                ids = ", ".join(str(i) for i in sp["ids"])
                issues = self.jira.search(f"sprint in ({ids}) AND issuetype != Epic", ["status", "resolutiondate"])
                delivered = sum(classify(i["fields"], ended, cutoff, active_statuses) == "released" for i in issues)
                out.append({"name": sp["name"], "state": sp["state"], "total": len(issues), "delivered": delivered,
                            "delivered_pct": round(100 * delivered / len(issues)) if issues else None})
            return list(reversed(out))               # oldest -> newest, for a left-to-right chart
        return self._cached(f"sprint_trend:{last}", load, seconds=900)

    def bug_reporters(self, days: int = 30, project: str | None = None) -> dict:
        """How many bugs each person reported in the last N days (valid / invalid / high priority / fixed)."""
        proj = self.resolve_project(project) if project else None
        end = datetime.now(timezone.utc)
        stats = self._cached(f"bug_reporters:{days}:{proj['key'] if proj else 'all'}",
                             lambda: self._bug_stats(end - timedelta(days=days), end, proj["key"] if proj else None), 300)
        return {"days": days, "project": proj, "reporters": stats["testers"], "summary": stats["summary"],
                "note": "Valid = not closed as Invalid/Duplicate/Won't Do. Invalid % is part of a tester's quality."}

    def sprint_tickets(self, sprint: str | None, outcome: str | None = None, project: str | None = None,
                       person: str | None = None, flag: str | None = None) -> dict:
        """Drill-down: the tickets behind one number of a sprint report."""
        sp = self.resolve_sprint(sprint)
        self.sprint_report(sp["name"])                      # builds and caches the classified rows
        rows = self._cache[f"sprint_rows:{sp['name']}"][1]
        if outcome == "not_delivered":
            rows = [r for r in rows if r["outcome"] != "released"]
        elif outcome:
            rows = [r for r in rows if r["outcome"] == outcome]
        if project:
            rows = [r for r in rows if r["project"] == project]
        if person:
            rows = [r for r in rows if r["assignee"] == person]
        if flag in ("carried_over", "added_mid_sprint"):
            rows = [r for r in rows if r[flag]]
        if flag == "reopened":
            rows = [r for r in rows if r["reopened"]]
        bits = [OUTCOME_LABELS.get(outcome or "", "Not delivered" if outcome == "not_delivered" else ""),
                {"carried_over": "Carried to a later sprint", "added_mid_sprint": "Added after the sprint started",
                 "reopened": "Reopened during the sprint"}.get(flag or "", ""), project or "", person or ""]
        title = " · ".join(b for b in [sp["name"], *bits] if b)
        ids = ", ".join(str(i) for i in sp["ids"])
        return {"title": title, "total": len(rows), "issues": rows[:200], "truncated": len(rows) > 200,
                "jql": f"sprint in ({ids})", "jira_link": f"{self.jira.base_url}/issues/?jql=" + f"sprint%20in%20({ids.replace(' ', '')})",
                "note": "Open in Jira shows the whole sprint; this list is filtered to what you clicked." if (outcome or flag or project or person) else None}
