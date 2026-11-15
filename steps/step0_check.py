"""STEP 0 - Check access: can we reach Jira and Inception with the keys in .env?

Run:  make check
"""

import asyncio

from openai import AsyncOpenAI
from rich.console import Console

from jira_pm import JiraError, PMService, Settings

console = Console()


def main():
    s = Settings.from_env()
    svc = PMService.from_settings(s)
    try:
        me = svc.jira.myself()
        console.print(f"[green]Jira OK[/green]  logged in as [bold]{me['displayName']}[/bold] ({me.get('emailAddress', '')})")
        projects = svc.jira.projects()
        console.print(f"  can see {len(projects)} projects: {', '.join(p['key'] for p in projects)}")
        console.print(f"  sprint field: {svc.jira.sprint_field()}")
        for label, jql in [("issues updated in last 14 days", "updated >= -14d"),
                           ("open issues in current sprints", "sprint in openSprints() AND statusCategory != Done")]:
            console.print(f"  {label}: ~{svc.jira.count(jql)}")
    except JiraError as e:
        console.print(f"[red]Jira FAILED[/red]: {e}")

    if not s.inception_api_key:
        console.print("[yellow]INCEPTION_API_KEY missing - steps 2/3 (the agent) won't work[/yellow]")
        return
    try:
        client = AsyncOpenAI(base_url="https://api.inceptionlabs.ai/v1", api_key=s.inception_api_key)
        r = asyncio.run(client.chat.completions.create(
            model=s.inception_model, messages=[{"role": "user", "content": "Say OK"}], max_tokens=5,
            extra_body={"reasoning_effort": "none"}))
        console.print(f"[green]Inception OK[/green]  model {r.model}: {r.choices[0].message.content!r}")
    except Exception as e:  # noqa: BLE001 - show any API failure plainly
        console.print(f"[red]Inception FAILED[/red]: {e}")


if __name__ == "__main__":
    main()
