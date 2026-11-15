"""Suggest roles for team.yaml from Jira activity (worklog tags, bugs reported, tickets created/assigned).

Writes team.suggested.yaml for you to review. team.yaml itself is only changed with --apply, and then only for
people whose role is still "unknown" - roles you set by hand are never overwritten.

Run:  make roles            (review team.suggested.yaml)
      make roles APPLY=1    (fill the "unknown" roles in team.yaml with high/medium-confidence suggestions)
"""

import argparse
from collections import Counter
from dataclasses import asdict

import yaml
from rich.console import Console
from rich.table import Table

from jira_pm import PMService, Settings
from jira_pm.roles import gather
from jira_pm.roster import Person, write_roster

console = Console()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--apply", action="store_true", help="fill 'unknown' roles in team.yaml (high/medium confidence only)")
    args = ap.parse_args()
    settings = Settings.from_env()
    svc = PMService.from_settings(settings)
    roster = svc.roster()
    if roster.source != "team.yaml":
        raise SystemExit("No team.yaml yet - run `make roster` first.")
    suggestions = gather(svc, args.days)

    t = Table("person", "suggested", "confidence", "evidence", title=f"Suggested roles (last {args.days} days)")
    for s in suggestions:
        t.add_row(s.name, s.role, s.confidence, s.evidence)
    console.print(t)
    console.print("counts:", dict(Counter(s.role for s in suggestions)))

    out = settings.roster_path.with_name("team.suggested.yaml")
    out.write_text("# Suggested roles from Jira activity - review, then copy into team.yaml (or run make roles APPLY=1)\n"
                   + yaml.safe_dump({"people": [asdict(s) for s in suggestions]}, sort_keys=False, allow_unicode=True))
    console.print(f"Wrote {out.name}")

    if args.apply:
        # edit the raw entries, so every person (also inactive ones) and every field (email, team) is kept
        by_id = {s.account_id: s for s in suggestions}
        raw = yaml.safe_load(settings.roster_path.read_text()) or {}
        changed = 0
        for entry in raw.get("people", []):
            s = by_id.get(entry.get("account_id"))
            if entry.get("role", "unknown") == "unknown" and s and s.role != "unknown" and s.confidence in ("high", "medium"):
                entry["role"] = s.role
                changed += 1
        write_roster([Person(**e) for e in raw.get("people", [])], settings.roster_path)
        console.print(f"Updated team.yaml: set {changed} roles (only people that were 'unknown').")
