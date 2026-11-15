"""The agent: OpenAI Agents SDK + Inception Mercury, with the metrics as tools.

The LLM never counts anything itself. It picks a tool, our Python does the counting
against Jira, and the LLM turns the numbers into a short answer.

JS comparison: like Vercel AI SDK `generateText({ model, tools, maxSteps })`, where each
tool is an async function with a schema. Here the schema comes from the type hints +
docstring of each function (that's what @function_tool reads).
"""

import asyncio
import json
import re
from urllib.parse import quote
from dataclasses import dataclass, field, replace
from datetime import date

from agents import (Agent, ModelSettings, OpenAIChatCompletionsModel, RunContextWrapper, Runner,
                    function_tool, set_tracing_disabled)
from agents.exceptions import MaxTurnsExceeded
from agents.items import ToolCallItem, ToolCallOutputItem
import openai
from openai import AsyncOpenAI

from .config import Settings
from .jira_client import jql_quote
from .metrics import PMService
from .roster import Person

set_tracing_disabled(True)   # tracing uploads runs to OpenAI's dashboard; we don't use OpenAI


@dataclass
class AppContext:
    """Passed to every tool. Not sent to the LLM."""
    service: PMService
    me: Person                                  # who is asking ("my tasks" = this person)
    trace: list[dict] = field(default_factory=list)
    question: str = ""                          # the user's words this turn (decides which list person_issues gives)


# Which list a question about a person's tickets wants. Decided from the user's own words, not left to the model:
#   "have to do" -> todo  |  "working on / doing now" -> active  |  sprint / finished -> as the model chose
#   anything else ("tasks", "work", "pending work", "what is assigned", "stories") -> all = EVERYTHING assigned
_TODO_WORDS = re.compile(r"\b(have|has|need|needs) to do\b|karna (hai|h|baaki|baki)|करना (है|बाकी)", re.I)
_ACTIVE_WORDS = re.compile(r"working on|doing (right )?now|currently doing|busy with|kar (raha|rahi|rhe|rahe)|"
                           r"kya kar (raha|rahi)|कर (रहा|रही)", re.I)
_KEEP_WORDS = re.compile(r"\bsprint\b|\b(done|finish\w*|complet\w*|closed|releas\w*|resolv\w*|deliver\w*)\b", re.I)


def scope_for(question: str, model_scope: str) -> str:
    """The person_issues scope the user's words ask for (see the rules above)."""
    q = question or ""
    if _TODO_WORDS.search(q):
        return "todo"
    if _ACTIVE_WORDS.search(q):
        return "active"
    if _KEEP_WORDS.search(q) and model_scope in ("sprint", "done_recent"):
        return model_scope
    return "all"


async def _run(ctx: RunContextWrapper[AppContext], name: str, fn, **kwargs) -> str:
    """Run a blocking metrics function in a thread and return JSON (or a readable error)."""
    try:
        result = await asyncio.to_thread(fn, **kwargs)
    except (LookupError, ValueError) as e:      # "which Ravi?" / unknown feature -> let the LLM ask
        result = {"error": str(e)}
    ctx.context.trace.append({"tool": name, "args": kwargs})
    return json.dumps(result, ensure_ascii=False, default=str)


def _clean(value: str | None) -> str | None:
    """Treat empty / junk arguments ("", "\n</", "everyone", "all") as 'not given'."""
    v = (value or "").strip()
    if not re.search(r"[A-Za-z]{2,}", v) or v.lower() in ("all", "everyone", "anyone", "team", "none", "null"):
        return None
    return v


# ---------------------------------------------------------------------- tools
@function_tool
async def person_issues(ctx: RunContextWrapper[AppContext], who: str = "me", scope: str = "all",
                        relation: str = "assignee", issue_type: str = "") -> str:
    """List Jira issues for a person: what is assigned to them, what they still have to do, or what they work on now.

    Args:
        who: "me" for the person asking, or a person's name (e.g. "Ravi").
        scope: pick by the question:
            "all"    = EVERYTHING assigned, any status (also finished) - "what is assigned to X / me", "my tickets",
                       "X's tasks", "my work", "his/her work", "pending work", "stories assigned to me",
                       "X ko kya assign hai", "mera kaam". Give the count per stage/status. When unsure, use "all".
            "todo"   = ONLY for the exact words "HAVE TO DO" ("what does X have to do", "what do I have to do",
                       "kya karna hai"): every ticket not yet Deployed on Staging and not Released/Done.
                       NOT for "pending", "tasks" or "work" - those use "all".
            "active" = ONLY for "what is X WORKING ON / doing right now" / "abhi kya kar raha hai":
                       In Progress / In Review / Ready to merge / In QA.
            "sprint" = everything in the current sprint; "done_recent" = finished in the last 14 days;
            "open"   = everything not finished.
        relation: "assignee" = work assigned to them, "reporter" = tickets they created (typical for product managers).
        issue_type: "Bug" ONLY when the question is about bugs ("bugs assigned to me", "mere bugs", "Ravi's bugs").
            Leave EMPTY for "what is assigned to me", "stories / tickets / tasks assigned to me": those mean everything.
    """
    c = ctx.context
    scope = scope_for(c.question, scope) if c.question else scope
    return await _run(ctx, "person_issues", c.service.person_issues, who=who, scope=scope, relation=relation, me=c.me,
                      issue_type=_clean(issue_type))


@function_tool
async def bugs_in_feature(ctx: RunContextWrapper[AppContext], feature: str, days: int = 90) -> str:
    """Count and list bugs reported in a feature (Jira component), with open/closed and priority breakdown.

    Args:
        feature: feature name as the user said it, e.g. "form builder", "voter module", "stats dashboard".
        days: look-back window in days (default 90). Use 7 for "this week", 30 for "this month".
    """
    return await _run(ctx, "bugs_in_feature", ctx.context.service.feature_bugs, feature=feature, days=days)


@function_tool
async def developers_on_feature(ctx: RunContextWrapper[AppContext], feature: str, days: int = 0) -> str:
    """Who works on a feature and how many developers, with each person's issue counts.

    Args:
        feature: feature name, e.g. "form builder".
        days: 0 = the current sprint (default). A number like 30 = anyone who touched it in the last 30 days.
    """
    return await _run(ctx, "developers_on_feature", ctx.context.service.feature_developers,
                      feature=feature, days=days or None)


@function_tool
async def free_developers(ctx: RunContextWrapper[AppContext]) -> str:
    """Which developers and QA are free right now (nothing assigned In Progress / In Review / Ready to merge / In QA),
    who is busy, and
    workload: the `busy` list is sorted by ACTIVE issues, so its first entry is the busiest developer.
    Use for "who is free", "who is busiest", "who has the most work", "workload"."""
    return await _run(ctx, "free_developers", ctx.context.service.free_developers)


@function_tool
async def inactive_people(ctx: RunContextWrapper[AppContext], days: int = 7) -> str:
    """People with NO Jira activity (no work logged, no status change, no comment, no new issue) in the last N days.

    Args:
        days: look-back window in days (default 7).
    """
    return await _run(ctx, "inactive_people", ctx.context.service.inactive_people, days=days)


@function_tool
async def naming_violations(ctx: RunContextWrapper[AppContext], days: int = 30, person: str = "", feature: str = "") -> str:
    """Who is NOT following the company's Jira ticket naming standard ("[Module] | Action or outcome").
    Checks titles of tickets created in the last N days, charged to the ticket creator, with examples and reasons.

    Args:
        days: look-back window in days (default 30).
        person: leave EMPTY for "who is not following..." questions (checks everyone). Only fill it when the
            user names one person, e.g. "Ravi", or says "my" / "me".
        feature: optional feature/component to check only that area. Empty = all.
    """
    c = ctx.context
    return await _run(ctx, "naming_violations", c.service.naming_compliance, days=days,
                      who=_clean(person), feature=_clean(feature), me=c.me)


@function_tool
async def worklog_violations(ctx: RunContextWrapper[AppContext], days: int = 7, person: str = "") -> str:
    """Who logs time without following the worklog convention "[Category] what was done"
    (missing [Dev]/[Testing]/... tag, or a tag with no description).

    Args:
        days: look-back window in days (default 7).
        person: leave EMPTY for "who is not following..." questions (checks everyone). Only fill it when the
            user names one person or says "my" / "me".
    """
    c = ctx.context
    return await _run(ctx, "worklog_violations", c.service.worklog_quality, days=days, who=_clean(person), me=c.me)


@function_tool
async def list_features(ctx: RunContextWrapper[AppContext], query: str = "") -> str:
    """List feature (component) names per project. Use when a feature name is unclear or the user asks what features exist.

    Args:
        query: optional text filter, e.g. "voter". Empty = all.
    """
    return await _run(ctx, "list_features", ctx.context.service.list_features, query=query or None)


@function_tool
async def team_members(ctx: RunContextWrapper[AppContext]) -> str:
    """The team roster: everyone tracked, with roles. Use for "how many people are in the team"."""
    return await _run(ctx, "team_members", ctx.context.service.team)


@function_tool
async def search_jira(ctx: RunContextWrapper[AppContext], jql: str) -> str:
    """Run any read-only JQL query. Only use when no other tool fits.

    Args:
        jql: a JQL query, e.g. 'project = VO AND priority = Highest AND statusCategory != Done'.
    """
    try:
        jql = as_asker(jql, ctx.context.me)
    except LookupError as e:
        return json.dumps({"error": str(e)})
    return await _run(ctx, "search_jira", ctx.context.service.search_issues, jql=jql)


_CURRENT_USER = re.compile(r"currentUser\s*\(\s*\)", re.IGNORECASE)


def as_asker(jql: str, me: Person | None) -> str:
    """Jira reads currentUser() as the TOKEN OWNER (one shared token for everyone). Swap it for the person asking,
    so "my bugs" means the asker's bugs. If we don't know the asker's Jira account, refuse instead of guessing."""
    if not _CURRENT_USER.search(jql):
        return jql
    if me is None or me.account_id.startswith("email:"):
        raise LookupError("I couldn't find a Jira account for you, so I can't look up 'your' issues. "
                          "Ask with a person's name instead.")
    return _CURRENT_USER.sub(jql_quote(me.account_id), jql)


@function_tool
async def sprint_summary(ctx: RunContextWrapper[AppContext]) -> str:
    """Live snapshot of the TEAM's running sprint right now: total / done / open issues, where open work is sitting by status,
    the biggest queue, open issues by type, open high-priority count. Use for "how is the sprint going",
    "what is stuck", "how many issues in <status>". For delivered / not delivered / per-person results use sprint_report."""
    return await _run(ctx, "sprint_summary", ctx.context.service.sprint_overview)


@function_tool
async def bug_hotspots(ctx: RunContextWrapper[AppContext], days: int = 30, project: str = "") -> str:
    """Bugs across ALL features at once: which features have the most bugs, totals (open / fixed / invalid),
    8-week weekly trend, open high-priority bugs. Use for "which feature has the most bugs", "bug trend",
    "overall bug count". For ONE named feature use bugs_in_feature instead.

    Args:
        days: look-back window in days (default 30). 7 = this week, 90 = this quarter.
        project: optional project key or name (e.g. "VO" or "Voter Outreach") to look at one project. Empty = all.
    """
    return await _run(ctx, "bug_hotspots", ctx.context.service.bug_overview, days=days, project=_clean(project))


@function_tool
async def sprint_report(ctx: RunContextWrapper[AppContext], sprint: str = "") -> str:
    """How a sprint went: how many tickets were delivered (released by the end date) vs NOT delivered, finished
    after the sprint, carried to the next sprint, added mid-sprint, reopened; per developer (delivered, sub-tasks,
    hours logged, bugs found in their work, reopened) and per tester (bugs found); highlights; delivery % trend.
    Use for "what did we deliver in sprint 3", "what failed to deliver", "last sprint report", "who did best".

    Args:
        sprint: "" or "current" = running sprint, "last" = previous sprint, or a name like "Sprint 3".
    """
    def run(sprint):
        r = ctx.context.service.sprint_report(sprint or None)
        return {**r, "developers": r["developers"][:15], "testers": r["testers"][:10],
                "trend": ctx.context.service.sprint_trend()}
    return await _run(ctx, "sprint_report", run, sprint=_clean(sprint) or "")


@function_tool
async def bugs_by_reporter(ctx: RunContextWrapper[AppContext], days: int = 30, project: str = "") -> str:
    """How many bugs each person (tester) reported in the last N days: valid, invalid, high-priority, fixed.
    Use for "which tester found the most bugs", "how many bugs did each tester report".

    Args:
        days: look-back window (default 30).
        project: optional project key or name. Empty = all projects.
    """
    return await _run(ctx, "bugs_by_reporter", ctx.context.service.bug_reporters, days=days, project=_clean(project))


TOOLS = [person_issues, bugs_in_feature, bug_hotspots, sprint_summary, sprint_report, bugs_by_reporter,
         developers_on_feature, free_developers, inactive_people, naming_violations, worklog_violations,
         list_features, team_members, search_jira]


def _project_list(service: PMService) -> str:
    try:
        seen = {f["project"]: f["project_name"] for f in service.features()}
    except Exception:  # noqa: BLE001 - the prompt must still build if Jira is slow
        return "(unavailable)"
    return ", ".join(f"{k} = {v}" for k, v in sorted(seen.items()))


def instructions(ctx: RunContextWrapper[AppContext], agent) -> str:
    """The system prompt. A function, so it can include today's date and who is asking."""
    s = ctx.context.service.settings
    return f"""You are a Jira assistant for product managers at this company. Today is {date.today():%A %d %B %Y}.
The person asking is {ctx.context.me.name}. "me", "my", "I" mean them.

How this company uses Jira:
- Projects (key = name), use the KEY in JQL: {_project_list(ctx.context.service)}
- A feature = a Jira component (e.g. "Form Builder", "Voter Module User Portal"). Projects are bigger modules.
  If the user names a project (e.g. "Analytics Hub", "Voter Outreach"), use project = KEY in JQL, not component.
- Epics usually have NO component: find a feature's epics with project = KEY (e.g. Form Builder epics:
  project = FB AND issuetype = Epic), never with component.
- Epics are quarterly initiatives named like "[Q4 FY26] ...". Sprints are named like "Q4 FY26 - Sprint 4".
- Workflow: To Do -> In Progress -> In Review -> Ready to merge -> Deployed on Staging -> In QA -> Ready to deploy -> Released.
- "Working on" / busy means status {", ".join(s.active_statuses)}.
- Ticket naming standard (company PDF). Write suggested titles EXACTLY in these shapes, with " | " and no brackets:
    Task/Story/Design/DevOps:  Module | Verb + outcome        e.g. "Data Entry | Fix XPath selectors in data entry flow"
    Bug:                       Module | What is broken        e.g. "Magazine | Shared link opens unpublished magazine"
    Sub-task:                  Verb + change + context        e.g. "Add duplicate voter ID validation in upload API"
    Epic:                      [Qx FYyy] Area outcome         e.g. "[Q3 FY26] Calling improve assignment reliability"
  Rules: start the action with a verb (Add, Fix, Update, Remove, Improve, Create, Design, Configure, Migrate,
  Refactor, Validate, Automate), no past tense, no misc/changes/fixes buckets, no code shorthand.
  Only suggest a title you can make specific from the original; don't invent features.
- Worklog convention: "[Category] what was done", e.g. "[Dev] Add version filter to submissions report".

Rules:
- ALWAYS use a tool for any number, name or issue. Never guess or make up issues, people or counts.
- Repeat numbers exactly as the tool returned them. Never compute totals or percentages yourself; if a list
  is shorter than its count field (e.g. people_listed < people_with_bad_titles), say "top N shown".
- If a tool returns an "error" (e.g. several people match a name), ask the user to clarify.
- Reply in the same language AND script as the question. Hinglish written in English letters
  ("kitne open bugs hain?") gets a Hinglish reply in English letters ("Form Builder me 3 open bugs hain"),
  never Devanagari. English gets English. Only use Devanagari if the user wrote in Devanagari.
- Names may be misspelled: pass them to tools exactly as typed - the tools fix typos. NEVER say someone isn't in
  the team, or suggest other names, without calling a tool first - in every turn, even if you said so earlier
  in this conversation (people get added; spellings differ).
- In search_jira, write currentUser() for the person asking ("my tickets in VO" -> assignee = currentUser()); the app
  replaces it with their own Jira account. For anyone else use person_issues, or quote the name: assignee = "Ravi Kumar".
- The "person" field in a result says whose data it is. Only say "you"/"your" when that person IS the one
  asking ({ctx.context.me.name}); otherwise use their name ("Karan Bose has 13 active issues").
- If a tool says several people match a name, ask "Which one do you mean?" and list them.
- A person's tickets are "assigned to <name>" (or "created by"), never "open issues": to people, "open" sounds like
  nobody has picked it up. Use by_stage, e.g. "Mayank Bharti has 42 tickets assigned: 3 being worked on, 2 not
  started, 1 waiting for release, 36 done" (scope all) or "Mayank Bharti still has 5 to do: 3 being worked on,
  2 not started" (scope todo). "Open" is fine only for team-wide counts (e.g. "42 open bugs in Form Builder").
- When showing issues, use markdown links: [KEY](url) - summary (status). Show at most 10 unless asked.
- Keep answers short: lead with the number or answer, then a few bullets or a small table.
- If the tool result has a "note" about how it was measured, mention it in one short line.
- You are read-only: you cannot create, edit or assign issues. Say so if asked, without calling tools.
- Only answer questions about this company's Jira work. Politely decline anything else (weather, salaries,
  personal data, opinions about people) in one line."""


def build_agent(settings: Settings) -> Agent[AppContext]:
    if not settings.inception_api_key:
        raise SystemExit("INCEPTION_API_KEY missing in .env")
    model = OpenAIChatCompletionsModel(
        model=settings.inception_model,
        openai_client=AsyncOpenAI(base_url="https://api.inceptionlabs.ai/v1", api_key=settings.inception_api_key),
    )
    return Agent[AppContext](
        name="Jira PM assistant",
        instructions=instructions,
        tools=TOOLS,
        model=model,
        model_settings=ModelSettings(
            temperature=0,                                            # same question -> same tool choice
            max_tokens=1500,
            extra_args={"reasoning_effort": settings.llm_reasoning},  # Mercury thinking: none/low/medium/high
        ),
    )


def seed_history(turns: list[dict], keep: int = 20) -> list[dict]:
    """Rebuild agent context from the browser's saved transcript: [{role: "user"|"bot", text}] -> chat messages.
    Only plain text is kept (no tool calls); that is enough for follow-ups like "and in voter module?"."""
    out = []
    for t in turns[-keep:]:
        text = str(t.get("text") or "").strip()[:4000]
        if text and t.get("role") in ("user", "bot"):
            out.append({"role": "user" if t["role"] == "user" else "assistant", "content": text})
    return out


def _trim(items: list, keep: int = 40) -> list:
    """Keep the prompt small, but only cut at a user message - cutting between a tool call
    and its result would make the API reject the conversation."""
    if len(items) <= keep:
        return items
    for i in range(len(items) - keep, len(items)):
        if isinstance(items[i], dict) and items[i].get("role") == "user":
            return items[i:]
    return items[-1:]


# "I don't see X in the roster" / "couldn't find X" without asking Jira is a made-up answer too
_NOT_FOUND = re.compile(r"\b(don't|do not|didn't|did not|couldn't|could not|can't|cannot|unable to) "
                        r"(see|find|locate|identify)\b|not (in|on) the (team )?(roster|list)|no (one|person|user) "
                        r"(named|called)|isn't (in|on|part of)|is not (in|on|part of)", re.I)


def _looks_made_up(result) -> bool:
    """True when no tool was called this turn but the answer states facts: numbers, or "X isn't in the team"."""
    called = any(isinstance(i, ToolCallItem) for i in result.new_items)
    out = result.final_output or ""
    return not called and bool(re.search(r"\d", out) or _NOT_FOUND.search(out))


def _assumed_names(items: list) -> list[str]:
    """Names the tools corrected from a typo during this turn (from 'name_match_note' in tool outputs)."""
    names: list[str] = []
    for i in items:
        if not isinstance(i, ToolCallOutputItem):
            continue
        try:
            out = json.loads(i.output) if isinstance(i.output, str) else i.output
        except (TypeError, ValueError):
            continue
        if isinstance(out, dict) and out.get("name_match_note") and out.get("person") not in names:
            names.append(out["person"])
    return names


def _jira_lists(items: list, base_url: str) -> list[str]:
    """Jira search links for the lists the tools returned this turn ("open this list in Jira"), newest last."""
    links: list[str] = []
    for i in items:
        if not isinstance(i, ToolCallOutputItem):
            continue
        try:
            out = json.loads(i.output) if isinstance(i.output, str) else i.output
        except (TypeError, ValueError):
            continue
        if not isinstance(out, dict) or out.get("error"):
            continue
        link = out.get("jira_link") or (f"{base_url}/issues/?jql={quote(out['jql'])}" if out.get("jql") else None)
        if link and link not in links:
            links.append(link)
    return links


def with_jira_links(answer: str, links: list[str]) -> str:
    """Add "Open this list in Jira" under an answer (code, not the model: always there, always the same query)."""
    if not links or "/issues/?jql=" in answer:
        return answer
    if len(links) == 1:
        return f"{answer}\n\n[Open this list in Jira ↗]({links[0]})"
    shown = links[-3:]
    return answer + "\n\nOpen in Jira: " + " · ".join(f"[list {n} ↗]({u})" for n, u in enumerate(shown, 1))


TOOL_LABELS = {
    "person_issues": lambda a: f"Looking up {('your' if a.get('who', 'me') in ('me', '') else a.get('who') + chr(39) + 's')} issues",
    "bugs_in_feature": lambda a: f"Counting bugs in {a.get('feature', 'that feature')} ({a.get('days', 90)} days)",
    "bug_hotspots": lambda a: f"Comparing bugs across features ({a.get('days', 30)} days)",
    "sprint_summary": lambda a: "Reading the current sprint",
    "sprint_report": lambda a: f"Building the {a.get('sprint') or 'current'} sprint report",
    "bugs_by_reporter": lambda a: "Counting bugs per tester",
    "developers_on_feature": lambda a: f"Finding who works on {a.get('feature', 'that feature')}",
    "free_developers": lambda a: "Checking who is free",
    "inactive_people": lambda a: f"Scanning Jira activity ({a.get('days', 7)} days)",
    "naming_violations": lambda a: "Checking ticket titles against the naming standard",
    "worklog_violations": lambda a: "Checking worklogs",
    "list_features": lambda a: "Listing features",
    "team_members": lambda a: "Reading the team list",
    "search_jira": lambda a: "Searching Jira",
}


def tool_label(name: str, arguments: str) -> str:
    """'bugs_in_feature', '{"feature": "Form Builder", "days": 30}' -> 'Counting bugs in Form Builder (30 days)'."""
    try:
        args = json.loads(arguments or "{}")
    except ValueError:
        args = {}
    try:
        return TOOL_LABELS[name](args) + "…"
    except (KeyError, TypeError, AttributeError):
        return "Checking Jira…"


POLITE = {
    "blocked": "I can't help with that. I can answer questions about Jira tasks, bugs, features, sprints, people "
               "and process standards.",
    "llm": "The AI service is busy or unreachable right now - please try again in a moment.",
    "turns": "That question needed too many Jira lookups. Try narrowing it (one feature, one person, or a shorter "
             "time window).",
}


class Chat:
    """One conversation (keeps history between questions). Used by the terminal and web chat."""

    def __init__(self, agent: Agent[AppContext], service: PMService, me: Person):
        self.agent, self.service, self.me = agent, service, me
        self.history: list = []
        self.owner: str | None = None        # whose chat history this conversation is saved under

    async def ask(self, question: str) -> dict:
        try:
            return await self._ask(question)
        except openai.BadRequestError:
            # Inception's own safety filter rejects some prompts (e.g. "ignore your rules...") with a 400.
            return {"answer": POLITE["blocked"], "tools": [], "tool_outputs": 0}
        except (openai.APIConnectionError, openai.APITimeoutError, openai.RateLimitError, openai.InternalServerError):
            return {"answer": POLITE["llm"], "tools": [], "tool_outputs": 0, "error": "llm_unavailable"}
        except MaxTurnsExceeded:
            return {"answer": POLITE["turns"], "tools": [], "tool_outputs": 0}

    def _strict(self):
        # tool call REQUIRED on the first step (the SDK then resets it to "auto" so the model can still answer)
        return self.agent.clone(model_settings=replace(self.agent.model_settings, tool_choice="required"))

    async def _ask(self, question: str) -> dict:
        ctx = AppContext(service=self.service, me=self.me, question=question)
        conversation = self.history + [{"role": "user", "content": question}]
        result = await Runner.run(self.agent, conversation, context=ctx, max_turns=8)
        if _looks_made_up(result):
            # Guard against invented numbers: the model answered with figures but never asked Jira.
            result = await Runner.run(self._strict(), conversation, context=ctx, max_turns=8)
        return self._finish(result)

    def _finish(self, result) -> dict:
        self.history = _trim(result.to_input_list())
        tools = [{"tool": i.raw_item.name, "args": i.raw_item.arguments}
                 for i in result.new_items if isinstance(i, ToolCallItem)]
        answer = result.final_output or ""
        # Typo corrections are added by code, not left to the model: always visible, always correct.
        assumed = _assumed_names(result.new_items)
        if assumed and not answer.lower().startswith("assuming"):
            answer = f"_Assuming you meant **{', '.join(assumed)}**._\n\n{answer}"
        answer = with_jira_links(answer, _jira_lists(result.new_items, self.service.jira.base_url))
        return {"answer": answer, "tools": tools,
                "tool_outputs": sum(isinstance(i, ToolCallOutputItem) for i in result.new_items)}

    async def ask_stream(self, question: str):
        """Like ask(), but yields events as they happen:
            {"type": "status", "text"}        what the agent is doing ("Counting bugs in Form Builder…")
            {"type": "delta", "text"}         answer text as the model writes it
            {"type": "retry", "text"}         the streamed text is being replaced (made-up-numbers guard)
            {"type": "done", "answer", "tools"}  the final answer (always the source of truth)
        """
        ctx = AppContext(service=self.service, me=self.me, question=question)
        conversation = self.history + [{"role": "user", "content": question}]
        yield {"type": "status", "text": "Thinking…"}
        try:
            result = Runner.run_streamed(self.agent, conversation, context=ctx, max_turns=8)
            async for ev in result.stream_events():
                if ev.type == "run_item_stream_event" and ev.name == "tool_called":
                    raw = ev.item.raw_item
                    yield {"type": "status", "text": tool_label(raw.name, raw.arguments)}
                elif ev.type == "run_item_stream_event" and ev.name == "tool_output":
                    yield {"type": "status", "text": "Writing the answer…"}
                elif ev.type == "raw_response_event" and getattr(ev.data, "type", "") == "response.output_text.delta":
                    yield {"type": "delta", "text": ev.data.delta}
            if _looks_made_up(result):
                yield {"type": "retry", "text": "Double-checking with Jira…"}
                result = await Runner.run(self._strict(), conversation, context=ctx, max_turns=8)
            out = self._finish(result)
            yield {"type": "done", "answer": out["answer"], "tools": out["tools"]}
        except openai.BadRequestError:
            yield {"type": "done", "answer": POLITE["blocked"], "tools": []}
        except (openai.APIConnectionError, openai.APITimeoutError, openai.RateLimitError, openai.InternalServerError):
            yield {"type": "done", "answer": POLITE["llm"], "tools": [], "error": "llm_unavailable"}
        except MaxTurnsExceeded:
            yield {"type": "done", "answer": POLITE["turns"], "tools": []}
