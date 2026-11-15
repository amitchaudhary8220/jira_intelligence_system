"""STEP 1 - Answer every PM question with plain Python + Jira. NO LLM.

This proves the numbers before an LLM touches them. If a number here looks wrong,
the agent (step 2) will be wrong too - fix it here first.

Run:  make step1                                   (all reports)
      make step1 ONLY=bugs FEATURE="voter module"
      make step1 ONLY=mine WHO="Ravi"
      ONLY = mine | bugs | devs | free | inactive | naming | features
"""

import argparse
import time

from rich.console import Console
from rich.table import Table

from jira_pm import PMService

console = Console()


def table(title: str, rows: list[dict], cols: list[str]):
    t = Table(*cols, title=title, title_justify="left")
    for r in rows:
        t.add_row(*[str(r.get(c, "")) for c in cols])
    console.print(t)


def report_mine(svc: PMService, who: str):
    for scope in ("active", "open"):
        r = svc.person_issues(who, scope=scope)
        console.rule(f"[bold]{r['person']}: {scope} issues  ({r['total']})")
        console.print(f"[dim]{r['jql']}[/dim]\nby status: {r['by_status']}")
        table("", r["issues"][:10], ["key", "status", "priority", "summary"])


def report_bugs(svc: PMService, feature: str, days: int):
    r = svc.feature_bugs(feature, days)
    console.rule(f"[bold]Bugs in {', '.join(r['feature'])} - last {days} days")
    console.print(f"[dim]{r['jql']}[/dim]")
    console.print(f"reported [bold]{r['total_reported']}[/bold]: still open [bold]{r['still_open']}[/bold], fixed not released {r['fixed_not_released']}, fixed {r['fixed_released']}, invalid {r['invalid']}")
    console.print(f"by priority: {r['by_priority_all_reported']}\nby status:   {r['by_status_all_reported']}\nby component: {r['by_component']}")
    table("open bugs", r["open_bugs"][:10], ["key", "status", "priority", "assignee", "summary"])


def report_devs(svc: PMService, feature: str):
    r = svc.feature_developers(feature)
    console.rule(f"[bold]People on {', '.join(r['feature'])} - {r['window']}")
    console.print(f"people {r['people_count']}, developers {r['developer_count']}  [dim]{r['note'] or ''}[/dim]")
    table("", r["people"], ["name", "role", "issues", "active_now", "done", "types"])


def report_free(svc: PMService):
    r = svc.free_developers()
    console.rule(f"[bold]Free developers - {r['free_count']} of {r['developers_considered']} ({r['roster_source']})")
    console.print(f"[dim]{r['definition']}. {r['note']}[/dim]")
    table(f"free, nothing queued ({r['free_idle_count']})", r["free_idle"], ["name", "role", "waiting_qa_release"])
    table(f"free, has To Do in sprint ({len(r['free_with_queue'])})", r["free_with_queue"],
          ["name", "role", "queued_in_sprint", "waiting_qa_release"])
    table(f"busy ({r['busy_count']}, top {len(r['busy'])})", r["busy"][:10], ["name", "active", "queued_in_sprint"])


def report_inactive(svc: PMService, days: int):
    r = svc.inactive_people(days)
    console.rule(f"[bold]No Jira activity in {days} days - {r['inactive_count']} of {r['roster_size']} ({r['roster_source']})")
    console.print(f"[dim]scanned {r['issues_scanned']} issues. {r['note']}[/dim]")
    table("inactive", r["inactive"], ["name", "role", "open_assigned"])


def report_naming(svc: PMService, days: int):
    r = svc.naming_compliance(days)
    console.rule(f"[bold]Naming standard - last {days} days: {r['compliance_pct']}% of {r['tickets_checked']} tickets OK")
    table("problems", r["by_rule"], ["label", "count"])
    table("by issue type", [{"type": k, **v} for k, v in r["by_type"].items()], ["type", "total", "compliant_pct"])
    rows = [{**p, "example": f"{p['examples'][0]['key']}: {p['examples'][0]['title'][:60]}"} for p in r["people_not_following"][:12]]
    table("not following", rows, ["name", "created", "violations", "compliance_pct", "example"])
    w = svc.worklog_quality(7)
    console.rule(f"[bold]Worklog convention '[Category] what was done' - 7 days: {w['compliance_pct']}% of {w['worklogs_checked']} OK")
    table("problems", w["by_rule"], ["label", "count"])
    rows = [{**p, "example": p["examples"][0]["note"][:50]} for p in w["people_not_following"][:12]]
    table("not following", rows, ["name", "logs", "violations", "compliance_pct", "example"])


def report_features(svc: PMService):
    r = svc.list_features()
    console.rule(f"[bold]Features (components): {r['count']}")
    for project, names in r["features_by_project"].items():
        console.print(f"[bold]{project}[/bold]: {', '.join(names)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["mine", "bugs", "devs", "free", "inactive", "naming", "features"])
    ap.add_argument("--who", default="me")
    ap.add_argument("--feature", default="Form Builder")
    ap.add_argument("--days", type=int, default=None, help="bugs: default 90, inactive: default 7")
    args = ap.parse_args()

    svc = PMService.from_settings()
    reports = {
        "mine": lambda: report_mine(svc, args.who),
        "bugs": lambda: report_bugs(svc, args.feature, args.days or 90),
        "devs": lambda: report_devs(svc, args.feature),
        "free": lambda: report_free(svc),
        "inactive": lambda: report_inactive(svc, args.days or 7),
        "naming": lambda: report_naming(svc, args.days or 30),
        "features": lambda: report_features(svc),
    }
    for name, run in reports.items():
        if args.only in (None, name):
            start, calls = time.perf_counter(), svc.jira.calls
            run()
            console.print(f"[dim]{name}: {time.perf_counter() - start:.1f}s, {svc.jira.calls - calls} Jira calls[/dim]\n")
