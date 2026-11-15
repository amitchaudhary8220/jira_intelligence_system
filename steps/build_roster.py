"""Write team.yaml: everyone who was assignee on an issue in the last N days.

Then OPEN team.yaml and set each person's role (dev / qa / pm / design / devops / lead / other)
and `active: false` for people who left. Without roles, "free developers" also counts QA and PMs.

Run:  make roster            (last 60 days)
      make roster DAYS=90
"""

import argparse

from rich.console import Console

from jira_pm import PMService, Settings
from jira_pm.roster import discover_people, write_roster

console = Console()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--force", action="store_true", help="overwrite an existing team.yaml")
    args = ap.parse_args()
    s = Settings.from_env()
    if s.roster_path.exists() and not args.force:
        raise SystemExit(f"{s.roster_path.name} already exists (your edits would be lost). Use --force / make roster FORCE=1")
    people = discover_people(PMService.from_settings(s).jira, args.days)
    write_roster(people, s.roster_path)
    console.print(f"Wrote [bold]{len(people)}[/bold] people to {s.roster_path}")
    console.print("Next: open team.yaml and set each person's [bold]role[/bold].")
