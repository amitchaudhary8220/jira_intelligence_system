"""STEP 2 - The agent in the terminal: ask in plain English (or Hinglish).

The LLM (Inception Mercury) picks a tool, our step-1 functions do the counting,
and the LLM words the answer. The dim line under each answer shows which tools it called.

Run:  make chat                         (interactive; type 'exit' to quit)
      make chat Q="how many bugs in form builder this month?"
      make chat AS="Ravi"               (pretend to be someone else, for "my tasks")
      make demo                         (runs a fixed list of PM questions - an end-to-end check)
"""

import argparse
import asyncio
import time

from rich.console import Console
from rich.markdown import Markdown

from jira_pm import PMService, Settings
from jira_pm.agent import Chat, build_agent

console = Console()

DEMO_QUESTIONS = [
    "What tasks are assigned to me?",
    "What am I working on right now?",
    "How many bugs were reported in Form Builder in the last 30 days?",
    "How many developers are working on the voter module this sprint?",
    "How many developers are free today?",
    "Who didn't do anything in Jira in the last 7 days?",
    "Form builder me kitne open bugs hain?",
]


async def ask(chat: Chat, question: str):
    start = time.perf_counter()
    r = await chat.ask(question)
    console.print(Markdown(r["answer"] or "(no answer)"))
    tools = ", ".join(f"{t['tool']}({t['args']})" for t in r["tools"]) or "no tools"
    console.print(f"[dim]{time.perf_counter() - start:.1f}s  |  {tools}[/dim]\n")


async def main(args):
    settings = Settings.from_env()
    svc = PMService.from_settings(settings)
    me = svc.resolve_person(args.as_person) if args.as_person else svc.me()
    chat = Chat(build_agent(settings), svc, me)
    console.print(f"[dim]Model {settings.inception_model} | asking as {me.name} | roster: {svc.roster().source}[/dim]\n")

    if args.demo:
        for q in DEMO_QUESTIONS:
            console.rule(f"[bold]{q}")
            chat.history = []              # each demo question on its own
            await ask(chat, q)
        return
    if args.q:
        await ask(chat, args.q)
        return
    while True:
        try:
            q = console.input("[bold cyan]you>[/bold cyan] ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if q.lower() in ("exit", "quit", "q"):
            break
        if q:
            await ask(chat, q)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", help="ask one question and exit")
    ap.add_argument("--as-person", help="ask as this person (name) instead of the token owner")
    ap.add_argument("--demo", action="store_true")
    asyncio.run(main(ap.parse_args()))
