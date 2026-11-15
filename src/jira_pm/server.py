"""STEP 3 backend - FastAPI: the dashboard + chat API, and it serves the React app.

  GET  /api/health      public: is the app up, can it reach Jira (for monitors and the watchdog)
  GET  /api/session     public: login mode + who is signed in
  POST /api/login       password mode: {email, password} -> signed cookie        POST /api/logout
  GET  /api/people      roster for the "I am" picker (locked to the signed-in user when there is login)
  GET  /api/dashboard   all dashboard numbers                POST /api/chat   {message, session_id, history}
  GET  /api/chats       your saved chats (SQLite)            GET/DELETE /api/chats/{id}
  ... plus drill-downs, sprints, bugs per project, the naming guide and checkers.

Production guard rails live in security.py: login (shared password or a company SSO proxy), rate limits,
security headers, request logs, and a startup check that refuses unsafe production settings.

JS comparison: an Express app with middleware (auth, headers, logging) in front of the routes. Sessions and
caches live in memory, so run ONE server process (no --workers); swap for Redis if you ever need more.
"""

import json
import logging
import os
from contextlib import asynccontextmanager
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from datetime import date, datetime, timedelta

from pydantic import BaseModel, Field

from . import naming
from .agent import Chat, build_agent, seed_history
from .config import PROJECT_ROOT, Settings
from .history import ChatStore
from .jira_client import JiraError
from .metrics import PMService
from .roster import Person
from .security import (COOKIE, PUBLIC_API, AuthConfig, RateLimiter, email_from_request, make_cookie, password_ok,
                       security_headers)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("jira_pm")

settings = Settings.from_env()
auth = AuthConfig.from_env()
_problems = auth.problems()
if auth.production and _problems:
    raise SystemExit("Refusing to start in production:\n  - " + "\n  - ".join(_problems))
for _p in _problems:
    log.warning("not production-safe: %s", _p)

service = PMService.from_settings(settings)
agent = build_agent(settings)
limiter = RateLimiter()
# Chat history (SQLite file). In Docker it lives on the ./data volume, so it survives restarts and redeploys.
store = ChatStore(os.getenv("HISTORY_DB", str(PROJECT_ROOT / "data" / "chats.sqlite3")),
                  retention_days=int(os.getenv("HISTORY_RETENTION_DAYS", "90")))
sessions: dict[str, Chat] = {}          # insertion-ordered: oldest first
MAX_SESSIONS = 300
STARTED = time.time()
VERSION = "1.0.0"

@asynccontextmanager
async def lifespan(_app):
    """Runs once when the server starts: log the mode and start the background warm-up."""
    log.info("Jira Pulse %s starting: env=%s auth=%s", VERSION, auth.env, auth.mode)
    if os.getenv("WARM_DASHBOARD", "1") == "1":
        threading.Thread(target=_keep_dashboard_warm, daemon=True, name="dashboard-warmer").start()
    yield


app = FastAPI(title="Jira Pulse", lifespan=lifespan, docs_url=None if auth.production else "/docs", redoc_url=None, openapi_url=None if auth.production else "/openapi.json")


# ------------------------------------------------------------------ background warm-up
def _warm_sprints():
    """Rebuild the running and the last sprint every round; also pre-load ONE older sprint per round, so the
    sprint dropdown is instant for every sprint after the first hour (finished sprints are cached an hour)."""
    names = {service.resolve_sprint(which)["name"] for which in ("current", "last")}
    for name in names:
        service._cache.pop(f"sprint_report:{name}", None)
        service._cache.pop(f"sprint_rows:{name}", None)
        service.sprint_report(name)
    service._cache.pop("sprint_trend:6", None)
    service.sprint_trend()
    for sp in service.sprint_list():
        hit = service._cache.get(f"sprint_report:{sp['name']}")
        if sp["name"] not in names and (not hit or time.time() - hit[0] > 3000):
            service.sprint_report(sp["name"])
            break


LIVE_PARTS = ("free_developers", "sprint_overview")   # what people change all day (status moves): re-read every minute
WARM_EVERY_S = 60
FULL_EVERY_ROUNDS = 4                                  # the heavier parts (bugs, naming, worklogs, inactivity): 4 minutes


def _keep_dashboard_warm():
    """Recompute all three periods in the background, so the period filter is instant and numbers stay current:
    availability + sprint progress are re-read from Jira every minute, everything else every 4 minutes."""
    rounds = 0
    while True:
        if rounds % FULL_EVERY_ROUNDS == 0:
            service.clear_dashboard_parts()      # re-read everything from Jira...
        else:
            for k in [k for k in list(service._cache) if k.startswith(LIVE_PARTS)]:
                service._cache.pop(k, None)      # ...or just the fast-changing parts
        rounds += 1
        for days in (30, 7, 90):                 # then build each period from those parts
            try:
                service.dashboard(days, force=True)
            except Exception as e:  # noqa: BLE001 - never let the warmer die; log and retry next round
                log.warning("warm dashboard %sd failed: %s", days, e)
        if rounds % FULL_EVERY_ROUNDS == 1:      # once per full round
            try:
                _warm_sprints()
            except Exception as e:  # noqa: BLE001
                log.warning("warm sprint report failed: %s", e)
            try:
                if (n := store.purge_old()):
                    log.info("deleted %s chats older than %s days", n, store.retention_days)
            except Exception as e:  # noqa: BLE001
                log.warning("chat retention purge failed: %s", e)
        time.sleep(WARM_EVERY_S)




# ------------------------------------------------------------------ who is calling
def client_key(request: Request) -> str:
    user = getattr(request.state, "email", None)
    return user or (request.client.host if request.client else "unknown")


def current_person(request: Request) -> Person | None:
    """The signed-in user's Jira person, or None when there is no login (AUTH_MODE=none)."""
    email = getattr(request.state, "email", None)
    return service.person_by_email(email) if email else None


@app.middleware("http")
async def guard(request: Request, call_next):
    """Login check, general rate limit, safety headers and one log line per API call (no chat text logged)."""
    started = time.perf_counter()
    path = request.url.path
    request.state.email = None
    if path.startswith("/api/") and path not in PUBLIC_API and auth.mode != "none":
        email = email_from_request(auth, request.headers, request.cookies)
        if not email:
            response = JSONResponse(status_code=401, content={"detail": "Please sign in", "auth": auth.mode})
            return _finish(request, response, started)
        if not auth.domain_ok(email):
            response = JSONResponse(status_code=403, content={"detail": f"{email} is not allowed to use this app"})
            return _finish(request, response, started)
        request.state.email = email
    if path.startswith("/api/") and path != "/api/health":
        wait = limiter.hit(f"api:{client_key(request)}", auth.api_per_minute, 60)
        if wait:
            return _finish(request, JSONResponse(status_code=429, content={"detail": f"Too many requests - try again in {wait}s"}), started)
    try:
        response = await call_next(request)
    except Exception:  # log it, never leak a stack trace to the browser
        log.exception("unhandled error on %s %s", request.method, path)
        response = JSONResponse(status_code=500, content={"detail": "Something went wrong on the server"})
    return _finish(request, response, started)


def _finish(request: Request, response: Response, started: float) -> Response:
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    for k, v in security_headers(auth.production, https).items():
        response.headers.setdefault(k, v)
    if request.url.path.startswith("/api/"):
        log.info("%s %s %s %.0fms user=%s", request.method, request.url.path, response.status_code,
                 (time.perf_counter() - started) * 1000, getattr(request.state, "email", None) or "-")
    return response


@app.exception_handler(JiraError)
async def jira_error(_request: Request, exc: JiraError):
    # Show "401 Unauthorized - check JIRA_API_TOKEN" in the UI instead of a bare 500.
    return JSONResponse(status_code=502, content={"detail": f"Jira error: {exc}"})


# ------------------------------------------------------------------ public: health + login
_health = {"at": 0.0, "jira": "unknown"}


@app.get("/api/health")
def health():
    """For uptime monitors and the watchdog. Checks Jira at most once a minute."""
    if time.time() - _health["at"] > 60:
        try:
            service.jira.myself()
            _health["jira"] = "ok"
        except Exception as e:  # noqa: BLE001
            _health["jira"] = f"error: {str(e)[:120]}"
        _health["at"] = time.time()
    return {"ok": True, "version": VERSION, "env": auth.env, "auth": auth.mode, "jira": _health["jira"],
            "llm": bool(settings.inception_api_key), "uptime_s": int(time.time() - STARTED)}


@app.get("/api/session")
def session_info(request: Request):
    email = email_from_request(auth, request.headers, request.cookies)
    if email and not auth.domain_ok(email):
        email = None
    person = service.person_by_email(email) if email else None
    return {"auth": auth.mode, "env": auth.env,
            "user": {"email": email, "name": person.name if person else None,
                     "account_id": person.account_id if person and not person.account_id.startswith("email:") else None,
                     "jira_linked": bool(person and not person.account_id.startswith("email:"))} if email else None,
            "can_pick_person": auth.mode == "none",
            "logout_url": auth.logout_url if auth.mode in ("proxy", "cloudflare") else None}


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    if auth.mode != "password":
        raise HTTPException(400, "Password sign-in is not enabled")
    ip = request.client.host if request.client else "unknown"
    wait = limiter.hit(f"login:{ip}", 5, 300)                    # 5 tries per 5 minutes per address
    if wait:
        raise HTTPException(429, f"Too many sign-in attempts - try again in {wait}s")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Enter your work email")
    if not auth.domain_ok(email):
        raise HTTPException(403, f"{email} is not allowed to use this app")
    if not password_ok(auth, body.password):
        raise HTTPException(401, "Wrong password")
    response.set_cookie(COOKIE, make_cookie(auth, email), max_age=auth.session_hours * 3600, httponly=True,
                        samesite="lax", secure=auth.production, path="/")
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


# ------------------------------------------------------------------ data
@app.get("/api/people")
def people(request: Request):
    me = current_person(request) or service.me()
    roster = service.roster()
    return {"me": me.account_id, "me_name": me.name, "source": roster.source, "locked": auth.mode != "none",
            "people": [{"account_id": p.account_id, "name": p.name, "role": p.role} for p in roster.people]}


@app.get("/api/profile")
def my_profile(request: Request, me_account_id: str | None = None):
    """The signed-in person's OWN profile (Jira identity + their Jira activity). Nobody can open someone else's here.
    Without login (local development) it's the "I am" person."""
    signed_in = current_person(request)
    if signed_in is not None:
        return service.profile(signed_in, request.state.email)
    me = service.me()
    if me_account_id and me_account_id != me.account_id:
        me = service.roster().by_id().get(me_account_id, me)
    return service.profile(me)


DAY_REASONS = {"half_day": "Half day", "arrived_late": "Arrived late", "no_active_story": "No active story",
               "on_leave": "On leave / holiday", "made_up": "Made up on another day",
               "comp_off": "Comp off (worked another day)", "other": "Other"}
LINKED_REASONS = {"made_up", "comp_off"}         # these point at the day the extra time was worked


REASON_WINDOW_DAYS = 62          # reasons can be added/changed for today and the last 62 days


@app.get("/api/timelog")
def my_time_log(request: Request, days: int = Query(14, ge=7, le=62),
                month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"), me_account_id: str | None = None):
    """The signed-in person's OWN daily time log (worklogs per day vs the requirement) with their saved reasons.
    month=YYYY-MM gives one calendar month (the calendar view); otherwise the last `days` days."""
    owner, me = chat_owner(request, me_account_id)
    if me.account_id.startswith("email:"):
        return {"linked": False, "reasons": DAY_REASONS, "rows": [],
                "note": "No Jira account was found for your email, so there are no worklogs to show."}
    today = datetime.now(service.jira_tz()).date()
    if month:
        first = date.fromisoformat(month + "-01")
        if first > today or (today - first).days > 400:
            raise HTTPException(422, "Pick a month from the last year.")
        last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        log = service.time_log(me, start=first, end=last)
        log["month"] = month
    else:
        log = service.time_log(me, days)
    saved = store.day_reasons(owner, log["from"], log["to"])
    covers: dict[str, list] = {}                 # extra-time day -> the short days it made up for
    for c in store.days_covered_by(owner, log["from"], log["to"]):
        covers.setdefault(c["other_day"], []).append(c["day"])
    short_by = {r["date"]: r["short_by"] for r in log["rows"]}
    extra_short = {d: service.time_log(me, start=date.fromisoformat(d), end=date.fromisoformat(d))["rows"][0]["short_by"]
                   for days in covers.values() for d in days if d not in short_by}     # covered days in another month
    rows = []
    for r in log["rows"]:
        row = {**r, "reason": saved.get(r["date"]),
               "editable": not r["weekend"] and (today - date.fromisoformat(r["date"])).days <= REASON_WINDOW_DAYS}
        if r["date"] in covers:
            claimed = round(sum(short_by.get(d, extra_short.get(d, 0)) for d in covers[r["date"]]), 4)
            row["covers"] = {"days": covers[r["date"]], "hours": claimed, "over_claimed": claimed > r["extra"] + 1e-6}
        rows.append(row)
    made_up = [r for r in rows if r["status"] == "short" and (r["reason"] or {}).get("reason") in LINKED_REASONS]
    summary = {**(log.get("summary") or {}), "made_up_days": len(made_up),
               "made_up_hours": round(sum(r["short_by"] for r in made_up), 2)}
    return {**log, "linked": True, "rows": rows, "reasons": DAY_REASONS, "summary": summary}


class DayReasonIn(BaseModel):
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    reason: str | None = None                    # None = remove the saved reason
    note: str = Field("", max_length=300)
    other_day: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")   # made_up / comp_off: where the time was worked
    me_account_id: str | None = None


@app.put("/api/timelog/reason")
def save_day_reason(body: DayReasonIn, request: Request):
    """Why I logged less than required on one working day. Saved in the app (never written to Jira)."""
    owner, me = chat_owner(request, body.me_account_id)
    try:
        day = date.fromisoformat(body.day)
    except ValueError as e:
        raise HTTPException(422, "day must be YYYY-MM-DD") from e
    today = datetime.now(service.jira_tz()).date()
    if day > today or (today - day).days > REASON_WINDOW_DAYS:
        raise HTTPException(422, f"You can add a reason for today or the last {REASON_WINDOW_DAYS} days only.")
    if day.weekday() >= 5:
        raise HTTPException(422, "Saturday and Sunday are off - no reason needed.")
    if body.reason is not None and body.reason not in DAY_REASONS:
        raise HTTPException(422, f"reason must be one of: {', '.join(DAY_REASONS)}")
    note = " ".join(body.note.split())
    if body.reason == "other" and not note:
        raise HTTPException(422, "Please write the reason when you choose Other.")
    other = None
    if body.reason in LINKED_REASONS:
        if not body.other_day:
            raise HTTPException(422, "Pick the day you worked the extra time.")
        other = date.fromisoformat(body.other_day)
        if other == day or other > today or (today - other).days > REASON_WINDOW_DAYS + 31:
            raise HTTPException(422, "Pick a different, past day (within the last three months).")
        # Only a day that really has time over the requirement can make up for another (checked in Jira).
        extra = service.time_log(me, start=other, end=other)["rows"][0]["extra"]
        if extra <= 0:
            raise HTTPException(422, f"{other:%a %d %b} has no extra time logged in Jira, so it can't make up for this day.")
        other = other.isoformat()
    store.set_day_reason(owner, day.isoformat(), body.reason, note, other)
    return {"day": day.isoformat(), "reason": body.reason, "note": note, "other_day": other}


def days_param():
    """A period in days (1-365, default 30). A NEW Query object per endpoint: FastAPI binds a shared one to the
    first parameter name it sees ("bug_days"), and the other endpoints then silently ignored ?days=."""
    return Query(30, ge=1, le=365)


@app.get("/api/dashboard")
def dashboard(bug_days: int = days_param(), refresh: bool = False):
    """Numbers for the dashboard page. Cached 5 minutes; refresh=true forces a reload from Jira."""
    return service.dashboard(bug_days=bug_days, refresh=refresh)


class TitleIn(BaseModel):
    title: str = Field(max_length=500)
    issue_type: str = Field("Task", max_length=40)


class WorklogIn(BaseModel):
    note: str = Field(max_length=2000)


class DrillIn(BaseModel):
    kind: str = Field(max_length=40)
    params: dict = Field(default_factory=dict, max_length=10)


@app.post("/api/drilldown")
def drilldown(body: DrillIn):
    """The tickets behind a clicked chart bar / segment / week."""
    if any(isinstance(v, str) and len(v) > 300 for v in body.params.values()):
        raise HTTPException(422, "parameter too long")
    try:
        return service.drilldown(body.kind, **body.params)
    except (LookupError, ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/sprints")
def sprints():
    return service.sprint_list()


@app.get("/api/sprint-report")
def sprint_report(sprint: str = Query("", max_length=120)):
    """What a sprint delivered, what slipped, per-person stats, and the delivery trend. Cached 5 minutes."""
    try:
        report = service.sprint_report(sprint or None)
    except LookupError as e:
        raise HTTPException(400, str(e)) from e
    return {**report, "trend": service.sprint_trend()}


@app.get("/api/bug-reporters")
def bug_reporters(days: int = days_param(), project: str | None = Query(None, max_length=120)):
    try:
        return service.bug_reporters(days, project or None)
    except LookupError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/projects")
def projects():
    return service.projects()


@app.get("/api/bugs")
def bugs(days: int = days_param(), project: str | None = Query(None, max_length=120)):
    """Bug overview for one project (the Bugs tab's project filter). Cached 5 minutes."""
    try:
        return service.bug_overview(days, project or None)
    except LookupError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/standards/guide")
def standards_guide():
    """Everything the Guide page shows: formats per issue type, rules, verbs, worklog convention."""
    return naming.guide(settings.worklog_tags)


@app.post("/api/standards/check-title")
def check_title(body: TitleIn):
    findings = naming.check_title(body.title, body.issue_type)
    return {"ok": naming.is_compliant(findings), "findings": [vars(f) for f in findings]}


@app.post("/api/standards/check-worklog")
def check_worklog(body: WorklogIn):
    findings = naming.check_worklog(body.note, settings.worklog_tags)
    return {"ok": naming.is_compliant(findings), "findings": [vars(f) for f in findings]}


# ------------------------------------------------------------------ chat
class HistoryTurn(BaseModel):
    role: str = Field(max_length=10)
    text: str = Field(max_length=8000)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str | None = Field(None, max_length=100)
    me_account_id: str | None = Field(None, max_length=128)
    # Earlier turns of this conversation, kept by the browser's chat history. Only used when the server no
    # longer has the conversation in memory (e.g. after a restart).
    history: list[HistoryTurn] = Field(default_factory=list, max_length=40)


def chat_owner(request: Request, me_account_id: str | None) -> tuple[str, Person]:
    """Who owns these chats: the signed-in email, or (no login, development) the "I am" person."""
    me = current_person(request)
    if me is not None:
        return request.state.email, me
    me = service.me()
    if me_account_id and me_account_id != me.account_id:
        me = service.roster().by_id().get(me_account_id, me)
    return f"acct:{me.account_id}", me


def _chat_session(body: ChatIn, request: Request) -> tuple[str, Chat, Person]:
    """Rate limits, who is asking, and the conversation to continue (or start). Shared by both chat endpoints."""
    key = client_key(request)
    for window, limit, label in ((60, auth.chat_per_minute, "per minute"), (86400, auth.chat_per_day, "per day")):
        wait = limiter.hit(f"chat{window}:{key}", limit, window)
        if wait:
            raise HTTPException(429, f"You've reached {limit} questions {label}. Try again in "
                                     f"{wait if wait < 120 else wait // 60} {'seconds' if wait < 120 else 'minutes'}.")
    if auth.chat_global_per_day and limiter.hit("chat-global", auth.chat_global_per_day, 86400):
        # A hard daily cap for the whole team: every chat question is a paid LLM call once free credits run out.
        raise HTTPException(429, "The team's daily limit for Ask Jira questions has been reached. It resets within "
                                 "24 hours. The dashboard and lists still work.")
    owner, me = chat_owner(request, body.me_account_id)
    sid = body.session_id or uuid.uuid4().hex
    if store.owner_of(sid) not in (None, owner):                   # someone else's conversation id
        raise HTTPException(403, "That conversation belongs to someone else")
    session = sessions.get(sid)
    if session is None or session.me.account_id != me.account_id:   # new / reopened chat, or another person
        session = sessions[sid] = Chat(agent, service, me)
        # reopened old chat: give the agent its context back - from the database, else what the browser sent
        saved = store.turns(owner, sid)
        session.history = seed_history(saved or [t.model_dump() for t in body.history])
        while len(sessions) > MAX_SESSIONS:                         # keep memory bounded
            sessions.pop(next(iter(sessions)))
    session.owner = owner
    return sid, session, me


def _save(session: Chat, sid: str, question: str, answer: str, tools: list, started: float) -> None:
    try:
        store.add_exchange(session.owner, sid, question, answer, tools, round(time.perf_counter() - started, 2))
    except Exception:  # a history hiccup must never cost the user their answer
        log.exception("saving chat history failed")


@app.post("/api/chat")
async def chat(body: ChatIn, request: Request):
    sid, session, me = _chat_session(body, request)
    started = time.perf_counter()
    result = await session.ask(body.message)
    _save(session, sid, body.message, result["answer"], result["tools"], started)
    return {"session_id": sid, "answer": result["answer"], "tools": result["tools"], "as": me.name}


@app.post("/api/chat/stream")
async def chat_stream(body: ChatIn, request: Request):
    """The same answer as /api/chat, streamed as Server-Sent Events: live status, text as it arrives, then done."""
    sid, session, me = _chat_session(body, request)

    started = time.perf_counter()

    async def events():
        yield _sse({"type": "start", "session_id": sid, "as": me.name})
        try:
            async for ev in session.ask_stream(body.message):
                if ev["type"] == "done":
                    _save(session, sid, body.message, ev["answer"], ev.get("tools", []), started)
                yield _sse(ev if ev["type"] != "done" else {**ev, "session_id": sid, "as": me.name})
        except JiraError as e:
            yield _sse({"type": "error", "detail": f"Jira error: {e}"})
        except Exception:  # never leak details into the stream
            log.exception("chat stream failed")
            yield _sse({"type": "error", "detail": "Something went wrong on the server"})

    # no-transform / X-Accel-Buffering: ask proxies (nginx etc.) not to hold the stream back
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/chats")
def list_chats(request: Request, me_account_id: str | None = Query(None, max_length=128)):
    """Your newest chats (sidebar). me_account_id only matters without login (the "I am" picker)."""
    owner, _ = chat_owner(request, me_account_id)
    return store.recent(owner)


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str, request: Request, me_account_id: str | None = Query(None, max_length=128)):
    owner, _ = chat_owner(request, me_account_id)
    conv = store.get(owner, chat_id[:100], touch=True)          # opening a chat counts as using it (LRU)
    if not conv:
        raise HTTPException(404, "Chat not found")                 # also for someone else's chat: no hint it exists
    return conv


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str, request: Request, me_account_id: str | None = Query(None, max_length=128)):
    owner, _ = chat_owner(request, me_account_id)
    if not store.delete(owner, chat_id[:100]):
        raise HTTPException(404, "Chat not found")
    sessions.pop(chat_id, None)
    return {"ok": True}


@app.post("/api/reset")
def reset(body: dict):
    sessions.pop(str(body.get("session_id") or ""), None)
    return {"ok": True}


# ------------------------------------------------------------------ the React app
# After `make build` FastAPI serves it at "/", so production is one server.
# During development use `make dev` instead: Vite on :5173 with hot reload, proxying /api here.
DIST = PROJECT_ROOT / "frontend" / "dist"


class AppFiles(StaticFiles):
    """The built React app. The page itself (index.html): browsers must re-check it every time, so after signing out
    they ask the login gateway again (and get the sign-in page) instead of starting a saved copy. The /assets files
    have a content hash in their names, so they can be cached for a year."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        hashed = "/assets/" in str(full_path).replace("\\", "/")
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return response


if DIST.exists():
    app.mount("/", AppFiles(directory=DIST, html=True), name="frontend")
else:
    @app.get("/")
    def no_frontend():
        return {"hint": "React app not built. Run `make build`, or `make dev` and open http://localhost:5173"}
