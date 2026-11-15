"""Checks ticket titles against the company's "Jira Ticket Naming Convention Standard".

Rules come straight from that document:
  - Base format:  [Work Type] [Module or Area] Action or outcome   (module separated with " | ")
  - Start with a clear action word: Add, Fix, Update, Remove, Improve, Create, Design, Configure,
    Migrate, Refactor, Validate, Automate (+ the verbs its own good examples use).
  - Name the module/area.  Bugs: "[Module] | Broken behavior" (no verb needed).
  - No past tense.  No filler / bucket words (misc, changes, fixes, improvements, "update - update").
  - No code shorthand: true, false, null, =, _id, raw field / variable names.
  - One piece of work per title ("and also", "+", two actions -> split).
  - Epics: "[Q3 FY26] Area outcome", never a weekly bucket ("Week 4", "Misc Tasks").
  - Sub-tasks: "[Verb] [specific change] [module or context]" - must start with a verb.
  - Sentence case or title case (a title starting in lowercase is neither).
  - Section 7 automation checks: too short, no approved verb, code patterns, vague bucket words.

Each check is a plain function, so the rules are easy to read and change. Severity:
  "error"   = breaks the standard (counts as non-compliant)
  "warning" = probably needs a look (shown, but the ticket still counts as compliant)
"""

import re
from dataclasses import dataclass

# Verbs the standard names, plus the ones its own good examples use.
APPROVED_VERBS = {
    "add", "fix", "update", "remove", "improve", "create", "design", "configure", "migrate",
    "refactor", "validate", "automate",
    "enable", "disable", "log", "support", "evaluate", "reduce", "simplify", "split", "implement",
    "integrate", "build", "show", "display", "allow", "prevent", "handle", "restrict", "optimize",
    "optimise", "upgrade", "replace", "rename", "move", "test", "document", "deploy", "setup", "set",
    "investigate", "research", "audit", "monitor", "track", "sync", "send", "notify", "export", "import",
    "redesign", "revamp", "introduce", "integrate", "hide", "change", "convert", "standardize", "clean",
    "make", "open", "check", "generate", "include", "preserve", "resolve", "bump", "secure", "dockerize",
    "debug", "verify", "ensure", "expose", "fetch", "store", "extend", "merge", "cleanup", "reuse", "restore",
    "apply", "enhance", "revert", "release", "schedule", "calculate", "map", "block", "limit", "persist",
    "retry", "provide", "write", "run", "review", "analyze", "analyse", "prepare", "define", "connect",
}

PAST_TENSE = {
    "added", "fixed", "updated", "removed", "improved", "created", "designed", "configured",
    "migrated", "refactored", "validated", "automated", "developed", "implemented", "integrated",
    "built", "changed", "enabled", "disabled", "deployed", "completed", "done", "made", "tested",
}

# Bucket / filler words the standard bans when used without context.
VAGUE = re.compile(
    r"\b(misc|miscellaneous|changes|fixes|improvements|improves|bugfixes|bug-fixes|bug fix(es)?|"
    r"tweaks|stuff|various|multiple issues|minor issues)\b", re.I)
VAGUE_WHOLE = re.compile(r"^\s*(fix issue|update data|changes|task|bug|bug fix|update|fix|testing|misc)\s*$", re.I)
WEEKLY_BUCKET = re.compile(r"\b(week\s*\d+|wk\s*\d+|weekly|intern tasks|misc tasks)\b", re.I)
EPIC_PREFIX = re.compile(r"^\s*\[\s*Q[1-4]\s*FY\s*\d{2}\s*\]", re.I)
FILLER_REPEAT = re.compile(r"\b(\w+)\s*[-–]\s*\1\b", re.I)          # "update - update"

# Code-level shorthand (section 7): booleans, null, '=', *_id, snake_case, camelCase identifiers.
CODE_TOKENS = re.compile(r"(\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|==?|!=|\w+_id\b|\b[a-z]+_[a-z_]+\b|\b[a-z]{2,}[A-Z][a-z]+[A-Za-z]*\b)")
BRAND_WORDS = {"ios", "macos", "iphone", "ipad", "ekyc", "javascript", "github", "youtube", "whatsapp"}

TYPES_NEEDING_MODULE = {"story", "task", "bug", "design", "devops", "automation", "project roadmap", "poc task"}
SUBTASK_TYPES = {"sub-task", "subtask", "custom subtask"}


@dataclass
class Finding:
    rule: str
    severity: str        # error | warning
    message: str


RULE_LABELS = {
    "too_short": "Too short to be meaningful",
    "no_action_verb": "Doesn't start with an action verb",
    "missing_module": "No module / area ( Module | ... )",
    "past_tense": "Written in past tense",
    "vague_words": "Vague bucket words (misc, changes, fixes...)",
    "code_shorthand": "Code shorthand (true/false/null/_id/variable names)",
    "multiple_actions": "Two pieces of work in one title",
    "epic_format": "Epic not '[Qx FYyy] Area outcome' or is a weekly bucket",
    "capitalization": "Starts in lowercase (not sentence/title case)",
    "formatting": "Formatting ('||', ALL CAPS, trailing dot)",
}


def _words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z][A-Za-z'\-]*", text)


def _action_part(title: str) -> str:
    """Text after the module prefix: 'iOS | Global Search | Add shimmer' -> 'Add shimmer'."""
    parts = [p.strip() for p in re.split(r"\s*\|+\s*", title) if p.strip()]
    return parts[-1] if parts else title.strip()


def check_title(title: str, issue_type: str) -> list[Finding]:
    t = (title or "").strip()
    itype = (issue_type or "").strip().lower()
    out: list[Finding] = []
    words = _words(t)

    if len(words) < 4 or len(t) < 15:
        out.append(Finding("too_short", "error", f"Only {len(words)} words - QA/Product can't tell what changes"))

    if VAGUE_WHOLE.match(t) or FILLER_REPEAT.search(t):
        out.append(Finding("vague_words", "error", "Filler title (e.g. 'fix issue', 'update - update')"))
    elif m := VAGUE.search(t):
        out.append(Finding("vague_words", "error", f"Bucket word '{m.group(0)}' - name the specific change"))

    code = [m.group(0) for m in CODE_TOKENS.finditer(t) if m.group(0).lower() not in BRAND_WORDS]
    if code:
        out.append(Finding("code_shorthand", "error", f"Code-level wording: {', '.join(sorted(set(code))[:3])}"))

    action_words = [w.lower() for w in _words(_action_part(t))]
    if (action_words[:1] and action_words[0] in PAST_TENSE) or re.search(
            r"\b\w+ and (" + "|".join(sorted(PAST_TENSE)) + r")\b", t, re.I):
        out.append(Finding("past_tense", "error", "Past tense - a ticket is work to be done"))

    if itype == "epic":
        if not EPIC_PREFIX.match(t):
            out.append(Finding("epic_format", "error", "Epic should start with [Qx FYyy]"))
        if WEEKLY_BUCKET.search(t):
            out.append(Finding("epic_format", "error", "Epic looks like a weekly bucket"))
        return out

    action = _action_part(t)
    action_first = (_words(action)[:1] or [""])[0].lower()
    if action_first.startswith("auto-"):          # "Auto-label", "Auto-remind" are the standard's own examples
        action_first = "automate"
    has_module = "|" in t

    if itype in SUBTASK_TYPES:
        if action_first not in APPROVED_VERBS:
            out.append(Finding("no_action_verb", "error", f"Sub-task should start with a verb (Add, Fix, Update...), not '{action_first or '?'}'"))
    elif itype in TYPES_NEEDING_MODULE:
        if not has_module:
            out.append(Finding("missing_module", "error", "Missing 'Module | ' prefix"))
        if itype != "bug" and action_first not in APPROVED_VERBS:
            out.append(Finding("no_action_verb", "error", f"Action should start with a verb (Add, Fix, Update...), not '{action_first or '?'}'"))

    if re.search(r"\band also\b|\s\+\s", t, re.I):
        out.append(Finding("multiple_actions", "warning", "Looks like two pieces of work - consider splitting"))
    elif re.search(r"\band\s+(" + "|".join(sorted(APPROVED_VERBS)) + r")\b", action, re.I) and itype in SUBTASK_TYPES:
        out.append(Finding("multiple_actions", "warning", "Two actions in one sub-task - consider splitting"))

    first = (t.split() or [""])[0].strip("[|").lower()
    if t[:1].islower() and first not in BRAND_WORDS:          # "iOS | ..." is fine
        out.append(Finding("capitalization", "error", "Starts in lowercase - use sentence case or title case"))
    if "||" in t or t.endswith(".") or (len(t) > 12 and t.isupper()):
        out.append(Finding("formatting", "warning", "Use a single ' | ' separator, no trailing dot, no ALL CAPS"))

    return out


def is_compliant(findings: list[Finding]) -> bool:
    return not any(f.severity == "error" for f in findings)


# ---------------------------------------------------------------------- worklog convention
# Not in the PDF: inferred from the team's own worklogs (98% of 1,390 in Oct-Nov 2026 used it):
#     [Category] what you did      e.g.  "[Dev] Add form version selection for submissions"
DEFAULT_WORKLOG_TAGS = ["Dev", "Testing", "Discussion", "Code Review", "Bug Verification", "Design",
                        "Automation", "DevOps", "Debug", "Review", "Research", "Test Setup", "Documentation",
                        "Meeting", "Planning", "Deployment", "Support", "Learning"]
WORKLOG_TAG = re.compile(r"^\s*\[([^\]]+)\]\s*[:\-–]?\s*(.*)$", re.S)

WORKLOG_LABELS = {
    "no_tag": "No [Category] tag",
    "unknown_tag": "Tag not in the team's list",
    "no_description": "Tag only, no description of the work",
    "short_description": "Description too short",
    "tag_case": "Tag spelled differently (e.g. [dev] vs [Dev])",
}


def check_worklog(note: str, tags: list[str] = DEFAULT_WORKLOG_TAGS, min_words: int = 3) -> list[Finding]:
    text = " ".join((note or "").split())
    m = WORKLOG_TAG.match(text)
    if not m:
        return [Finding("no_tag", "error", "Start with a [Category] tag, e.g. [Dev] or [Testing]")]
    tag, desc = m.group(1).strip(), m.group(2).strip()
    out = []
    canonical = {t.lower(): t for t in tags}
    if tag.lower() not in canonical:
        out.append(Finding("unknown_tag", "warning", f"[{tag}] isn't one of: {', '.join(tags[:8])}..."))
    elif tag != canonical[tag.lower()]:
        out.append(Finding("tag_case", "warning", f"Write [{canonical[tag.lower()]}], not [{tag}]"))
    words = re.findall(r"[A-Za-z]{2,}", desc)
    if not words:
        out.append(Finding("no_description", "error", f"Only the tag [{tag}] - say what was done"))
    elif len(words) < min_words:
        out.append(Finding("short_description", "error", f"'{desc}' is too short to tell what was done"))
    return out


# ---------------------------------------------------------------------- the readable guide (one source of truth)
# Shown on the dashboard's Guide tab. Condensed from "Jira Ticket Naming Convention Standard" (company PDF).
GUIDE = {
    "source": "Jira Ticket Naming Convention Standard (company document)",
    "core_rule": "If QA or Product can't tell what to test or review from the title alone, the title isn't acceptable.",
    "formula": "Verb + what is changing + where",
    "base_format": "[Work Type] [Module or Area] Action or outcome",
    "formats": [
        {"type": "Epic", "format": "[Quarter] Area outcome", "purpose": "A measurable outcome or initiative, never a weekly bucket",
         "good": "[Q3 FY26] Calling improve assignment reliability", "avoid": "DevOps Work June Week 4"},
        {"type": "Story", "format": "Platform | Module | Capability", "purpose": "A user-visible feature or product increment",
         "good": "iOS | Global Search | Add shimmer loading state", "avoid": "Generic Voter Module | Backend Improvements"},
        {"type": "Task", "format": "Module | Action and outcome", "purpose": "A bounded piece of work with an obvious result",
         "good": "Login | Add recent searches to global search", "avoid": "iOS || Inbox UI + Functionality impovements"},
        {"type": "Bug", "format": "Module | What is broken", "purpose": "The observed failure and where, so QA can retest",
         "good": "Magazine | Shared link opens unpublished magazine", "avoid": "Something went wrong error on banner click"},
        {"type": "Design", "format": "Module | Design deliverable", "purpose": "The artifact reviewers should expect",
         "good": "Toast Messages | Design Android and iOS variants", "avoid": "Mann Ki Baat Geolocation"},
        {"type": "DevOps", "format": "System or environment | Action", "purpose": "One operational or reliability change",
         "good": "Production Domains | Add PagerDuty availability monitoring", "avoid": "DevOps Misc Tasks Week 3"},
        {"type": "Automation", "format": "Tool or workflow | Automated result", "purpose": "What gets automated and the result",
         "good": "Jira Sprint Rollover | Auto-label rolled issues by reason", "avoid": "Automation work"},
        {"type": "Project Roadmap", "format": "Area | Initiative", "purpose": "Strategic direction in leadership language",
         "good": "Membership | Improve assisted onboarding journey", "avoid": "Membership stuff Q3"},
        {"type": "POC Task", "format": "Area | Validate approach", "purpose": "Exactly what is being tested",
         "good": "Bulk Notifications | Validate safe send-rate thresholds", "avoid": "POC for notifications"},
        {"type": "Sub-task", "format": "Verb + specific change + context", "purpose": "A small slice anyone on the team can read",
         "good": "Add API validation for duplicate voter ID in upload flow", "avoid": "is_disabled false check"},
    ],
    "do": [
        "Start with an action word: Add, Fix, Update, Remove, Improve, Create, Design, Configure, Migrate, Refactor, Validate, Automate",
        "Name the module or area: Admin Panel, Calling, Reports, Inbox, Dashboard, Login…",
        "Describe the outcome in plain language QA and Product understand",
        "Use sentence case or title case consistently",
        "Keep one piece of work per ticket",
        "Prefer business-readable words over code-level words",
    ],
    "dont": [
        "Past tense (“Designed and Developed…”): a ticket is work to be done",
        "Filler or buckets: misc, changes, fixes, improvements, “update - update”, “task”, “bug fix” without context",
        "Variable names, booleans, DB fields: true, false, null, =, _id, is_disabled",
        "Two different actions joined by “and”: usually two tickets",
        "A title that only makes sense after opening the code",
    ],
    "examples": [
        {"do": "Fix carousel timezone handling in list view", "dont": "carousel list fix time zone issue"},
        {"do": "Add share button and enable link sharing on Android", "dont": "Add share button and enable link sharing"},
        {"do": "Design birthday dashboard home page", "dont": "Design and Developed Birthday Dashboard Home Page"},
        {"do": "Update campaign structure based on demo feedback", "dont": "changes in campaign structure after demo"},
        {"do": "Add dynamic date-range filter to PM report", "dont": "Add Dynamic to and from date and resolved by number"},
    ],
    "subtask_checklist": [
        "Starts with a clear verb", "Describes one change only", "Includes the module or context",
        "Avoids code shorthand and variable names", "QA and Product understand it without extra explanation",
    ],
    "worklog": {
        "format": "[Category] what you did",
        "note": "Team convention (not in the naming PDF): 98% of the team's worklogs already start with a [Category] tag.",
        "good": ["[Dev] Add version filter to submissions report", "[Testing] Verify Hindi translations on the event form",
                 "[Code Review] Review PR #4313 for the location summary API"],
        "bad": ["[Dev]", "[Code Review]", "Fixed the login page"],
    },
}


def guide(worklog_tags: list[str] | None = None) -> dict:
    """The guide plus the live lists the checker uses, so the page and the checks never disagree."""
    out = dict(GUIDE)
    out["verbs"] = sorted(v.capitalize() for v in APPROVED_VERBS)
    out["rules"] = RULE_LABELS
    out["worklog"] = {**GUIDE["worklog"], "categories": worklog_tags or DEFAULT_WORKLOG_TAGS, "rules": WORKLOG_LABELS}
    out["issue_types"] = [f["type"] for f in GUIDE["formats"]]
    return out
