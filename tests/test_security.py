"""Production guard rails, tested through the real FastAPI app (fake Jira + fake LLM, no network).

Run: make test
"""

import os

os.environ["WARM_DASHBOARD"] = "0"                      # no background Jira calls in tests
os.environ.setdefault("INCEPTION_API_KEY", "test")
os.environ.setdefault("JIRA_BASE_URL", "https://example.atlassian.net")
os.environ.setdefault("JIRA_EMAIL", "a@b.c")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from jira_pm import server  # noqa: E402
from jira_pm.history import ChatStore  # noqa: E402
from jira_pm.roster import Person, Roster  # noqa: E402
from jira_pm.security import AuthConfig, make_cookie, read_cookie  # noqa: E402

GOOD_PW = "correct horse battery"


@pytest.fixture
def api(monkeypatch, tmp_path):
    server.limiter.reset()
    server.sessions.clear()
    monkeypatch.setattr(server, "store", ChatStore(tmp_path / "chats.sqlite3"))   # never the real history file
    svc = server.service
    monkeypatch.setattr(svc, "me", lambda: Person("acc-owner", "Token Owner"))
    monkeypatch.setattr(svc, "person_by_email",
                        lambda e: Person("acc-amit", "Amit") if e.startswith("amit@") else Person(f"email:{e}", e))
    monkeypatch.setattr(svc, "roster", lambda: Roster([Person("acc-amit", "Amit"), Person("acc-ravi", "Ravi")], "team.yaml"))
    monkeypatch.setattr(svc, "projects", lambda: [{"key": "FB", "name": "Form Builder"}])

    async def fake_ask(self, question):
        return {"answer": f"{self.me.name}: {question}", "tools": []}
    monkeypatch.setattr(server.Chat, "ask", fake_ask)

    defaults = AuthConfig()                              # start every test in plain development mode
    for k, v in vars(defaults).items():
        monkeypatch.setattr(server.auth, k, v)

    def set_auth(**kw):
        for k, v in kw.items():
            monkeypatch.setattr(server.auth, k, v)
    client = TestClient(server.app)
    client.set_auth = set_auth
    return client


PASSWORD_MODE = {"mode": "password", "password": GOOD_PW, "secret": b"s" * 40}


# ------------------------------------------------------------------ no login (development)
def test_development_mode_is_open_and_still_sends_safety_headers(api):
    r = api.get("/api/projects")
    assert r.status_code == 200
    assert r.headers["x-frame-options"] == "DENY" and "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert api.get("/api/session").json()["can_pick_person"] is True


# ------------------------------------------------------------------ password mode
def test_password_mode_requires_sign_in(api):
    api.set_auth(**PASSWORD_MODE)
    assert api.get("/api/projects").status_code == 401
    assert api.post("/api/login", json={"email": "amit@example.com", "password": "nope"}).status_code == 401
    r = api.post("/api/login", json={"email": "amit@example.com", "password": GOOD_PW})
    assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
    assert api.get("/api/projects").status_code == 200                       # cookie carried by the client
    people = api.get("/api/people").json()
    assert people["me"] == "acc-amit" and people["locked"] is True
    assert api.get("/api/session").json()["user"]["name"] == "Amit"
    api.post("/api/logout")
    assert api.get("/api/projects").status_code == 401


def test_tampered_or_expired_cookies_are_rejected(api):
    api.set_auth(**PASSWORD_MODE)
    good = make_cookie(server.auth, "amit@example.com")
    payload, sig = good.rsplit(".", 1)
    forged = make_cookie(server.auth, "boss@example.com").rsplit(".", 1)[0] + "." + sig
    api.cookies.set("jp_session", forged)
    assert api.get("/api/projects").status_code == 401
    api.set_auth(session_hours=-1)
    api.cookies.set("jp_session", make_cookie(server.auth, "amit@example.com"))   # already expired
    assert api.get("/api/projects").status_code == 401


def test_password_guessing_is_slowed_down(api):
    api.set_auth(**PASSWORD_MODE)
    for _ in range(5):
        assert api.post("/api/login", json={"email": "amit@example.com", "password": "guess"}).status_code == 401
    assert api.post("/api/login", json={"email": "amit@example.com", "password": GOOD_PW}).status_code == 429


def test_only_allowed_email_domains_get_in(api):
    api.set_auth(**PASSWORD_MODE, allowed_domains=["example.com"])
    assert api.post("/api/login", json={"email": "someone@gmail.com", "password": GOOD_PW}).status_code == 403


# ------------------------------------------------------------------ proxy (company SSO) mode
def test_proxy_mode_trusts_the_sso_header_only(api):
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    assert api.get("/api/projects").status_code == 401
    ok = {"X-Forwarded-Email": "amit@example.com"}
    assert api.get("/api/projects", headers=ok).status_code == 200
    iap = {"X-Forwarded-Email": "accounts.google.com:amit@example.com"}   # Google IAP's format
    assert api.get("/api/session", headers=iap).json()["user"]["name"] == "Amit"
    assert api.get("/api/projects", headers={"X-Forwarded-Email": "x@evil.com"}).status_code == 403


def test_sign_out_link_comes_from_the_gateway(api, monkeypatch):
    api.set_auth(mode="proxy", allowed_domains=["example.com"], logout_url="/oauth2/sign_out")
    assert api.get("/api/session").json()["logout_url"] == "/oauth2/sign_out"       # oauth2-proxy (Google sign-in)
    api.set_auth(mode="none")
    assert api.get("/api/session").json()["logout_url"] is None                     # no gateway, no link
    monkeypatch.setenv("AUTH_MODE", "cloudflare")
    monkeypatch.delenv("LOGOUT_URL", raising=False)
    assert AuthConfig.from_env().logout_url == "/cdn-cgi/access/logout"              # Cloudflare's default
    monkeypatch.setenv("LOGOUT_URL", "/oauth2/sign_out")
    assert AuthConfig.from_env().logout_url == "/oauth2/sign_out"


def test_chat_uses_the_signed_in_person_not_the_picker(api):
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    r = api.post("/api/chat", headers={"X-Forwarded-Email": "amit@example.com"},
                 json={"message": "my tasks", "me_account_id": "acc-ravi"})          # tries to be Ravi
    assert r.json()["answer"] == "Amit: my tasks"


def test_without_login_the_picker_decides(api):
    r = api.post("/api/chat", json={"message": "my tasks", "me_account_id": "acc-ravi"})
    assert r.json()["answer"] == "Ravi: my tasks"


# ------------------------------------------------------------------ limits
def test_chat_rate_limit_per_user(api):
    api.set_auth(chat_per_minute=2)
    for _ in range(2):
        assert api.post("/api/chat", json={"message": "hi"}).status_code == 200
    r = api.post("/api/chat", json={"message": "hi"})
    assert r.status_code == 429 and "2 questions per minute" in r.json()["detail"]


def test_general_api_rate_limit(api):
    api.set_auth(api_per_minute=3)
    assert [api.get("/api/projects").status_code for _ in range(4)] == [200, 200, 200, 429]


@pytest.mark.parametrize("request_args", [
    ("post", "/api/chat", {"json": {"message": "x" * 4001}}),
    ("post", "/api/chat", {"json": {"message": ""}}),
    ("post", "/api/chat", {"json": {"message": "hi", "history": [{"role": "user", "text": "q"}] * 41}}),
    ("get", "/api/dashboard", {"params": {"bug_days": 10000}}),
    ("post", "/api/drilldown", {"json": {"kind": "bugs_week", "params": {"week": "x" * 400}}}),
    ("post", "/api/standards/check-title", {"json": {"title": "x" * 501}}),
])
def test_oversized_or_invalid_input_is_rejected(api, request_args):
    method, path, kwargs = request_args
    assert getattr(api, method)(path, **kwargs).status_code == 422


# ------------------------------------------------------------------ health + errors
def test_health_is_public_even_with_login(api, monkeypatch):
    api.set_auth(**PASSWORD_MODE)
    monkeypatch.setattr(server.service.jira, "myself", lambda: {"accountId": "x"})
    server._health["at"] = 0
    r = api.get("/api/health")
    assert r.status_code == 200 and r.json()["jira"] == "ok" and r.json()["auth"] == "password"


def test_crashes_never_leak_details_to_the_browser(api, monkeypatch):
    def boom():
        raise RuntimeError("database password is hunter2")
    monkeypatch.setattr(server.service, "projects", boom)
    r = api.get("/api/projects")
    assert r.status_code == 500 and "hunter2" not in r.text


# ------------------------------------------------------------------ production config check
def test_production_refuses_unsafe_settings(monkeypatch):
    monkeypatch.delenv("ALLOW_NO_AUTH", raising=False)
    assert AuthConfig(env="production", mode="none").problems()
    assert AuthConfig(env="production", mode="password", password="short", secret=b"s" * 40).problems()
    assert AuthConfig(env="production", mode="password", password=GOOD_PW, secret=b"short").problems()
    assert AuthConfig(env="production", mode="proxy").problems()                       # no allowed domains
    assert AuthConfig(env="production", mode="password", password=GOOD_PW, secret=b"s" * 40).problems() == []
    assert AuthConfig(env="production", mode="proxy", allowed_domains=["example.com"]).problems() == []


def test_cookie_round_trip():
    cfg = AuthConfig(secret=b"s" * 40)
    assert read_cookie(cfg, make_cookie(cfg, "amit@example.com")) == "amit@example.com"
    assert read_cookie(AuthConfig(secret=b"other" * 10), make_cookie(cfg, "amit@example.com")) is None
    assert read_cookie(cfg, "garbage") is None and read_cookie(cfg, None) is None


# ------------------------------------------------------------------ streaming chat
def _events(text: str) -> list[dict]:
    import json
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


@pytest.fixture
def streaming(api, monkeypatch):
    async def fake_stream(self, question):
        yield {"type": "status", "text": "Counting bugs…"}
        yield {"type": "delta", "text": f"{self.me.name}: "}
        yield {"type": "done", "answer": f"{self.me.name}: {question}", "tools": []}
    monkeypatch.setattr(server.Chat, "ask_stream", fake_stream)
    return api


def test_stream_sends_start_status_text_and_done(streaming):
    r = streaming.post("/api/chat/stream", json={"message": "bugs?"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    ev = _events(r.text)
    assert [e["type"] for e in ev] == ["start", "status", "delta", "done"]
    assert ev[0]["session_id"] == ev[-1]["session_id"] and ev[-1]["answer"] == "Token Owner: bugs?"


def test_stream_uses_the_signed_in_person_and_the_same_limits(streaming):
    streaming.set_auth(mode="proxy", allowed_domains=["example.com"], chat_per_minute=1)
    h = {"X-Forwarded-Email": "amit@example.com"}
    assert streaming.post("/api/chat/stream", json={"message": "q"}).status_code == 401            # not signed in
    ev = _events(streaming.post("/api/chat/stream", headers=h, json={"message": "q", "me_account_id": "acc-ravi"}).text)
    assert ev[-1]["answer"] == "Amit: q"                                                             # not Ravi
    assert streaming.post("/api/chat/stream", headers=h, json={"message": "again"}).status_code == 429


def test_stream_errors_never_leak_details(api, monkeypatch):
    async def broken(self, question):
        yield {"type": "status", "text": "Thinking…"}
        raise RuntimeError("internal secret 42")
    monkeypatch.setattr(server.Chat, "ask_stream", broken)
    ev = _events(api.post("/api/chat/stream", json={"message": "q"}).text)
    assert ev[-1] == {"type": "error", "detail": "Something went wrong on the server"}


def test_tool_labels_read_like_status_lines():
    from jira_pm.agent import tool_label
    assert tool_label("bugs_in_feature", '{"feature": "Form Builder", "days": 30}') == "Counting bugs in Form Builder (30 days)…"
    assert tool_label("person_issues", '{"who": "me"}') == "Looking up your issues…"
    assert tool_label("person_issues", '{"who": "Ravi"}') == "Looking up Ravi's issues…"
    assert tool_label("unknown_tool", "not json") == "Checking Jira…"


# ------------------------------------------------------------------ saved chats (SQLite)
def test_chats_are_saved_listed_reopened_and_deleted(api):
    sid = api.post("/api/chat", json={"message": "bugs in form builder?"}).json()["session_id"]
    api.post("/api/chat", json={"message": "and voter?", "session_id": sid})
    assert [c["title"] for c in api.get("/api/chats").json()] == ["bugs in form builder?"]
    conv = api.get(f"/api/chats/{sid}").json()
    assert [m["role"] for m in conv["messages"]] == ["user", "bot", "user", "bot"]
    assert conv["messages"][1]["text"] == "Token Owner: bugs in form builder?"
    assert api.delete(f"/api/chats/{sid}").status_code == 200
    assert api.get("/api/chats").json() == [] and api.get(f"/api/chats/{sid}").status_code == 404


def test_streamed_answers_are_saved_too(streaming):
    ev = _events(streaming.post("/api/chat/stream", json={"message": "bugs?"}).text)
    sid = ev[0]["session_id"]
    msgs = streaming.get(f"/api/chats/{sid}").json()["messages"]
    assert msgs[0]["text"] == "bugs?" and msgs[1]["text"] == ev[-1]["answer"]


def test_after_a_restart_the_agent_gets_the_saved_chat_back(api, monkeypatch):
    sid = api.post("/api/chat", json={"message": "bugs in form builder?"}).json()["session_id"]
    server.sessions.clear()                                                   # server restarted: memory gone
    seen = {}

    async def remembering_ask(self, question):
        seen["history"] = list(self.history)
        return {"answer": "ok", "tools": []}
    monkeypatch.setattr(server.Chat, "ask", remembering_ask)
    api.post("/api/chat", json={"message": "and last week?", "session_id": sid})   # browser sends no history
    assert "bugs in form builder?" in str(seen["history"])


def test_nobody_can_read_continue_or_delete_someone_elses_chat(api):
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    amit = {"X-Forwarded-Email": "amit@example.com"}
    ravi = {"X-Forwarded-Email": "ravi@example.com"}
    sid = api.post("/api/chat", headers=amit, json={"message": "my question"}).json()["session_id"]
    assert api.get("/api/chats", headers=ravi).json() == []
    assert api.get(f"/api/chats/{sid}", headers=ravi).status_code == 404          # no hint that it exists
    assert api.delete(f"/api/chats/{sid}", headers=ravi).status_code == 404
    assert api.post("/api/chat", headers=ravi, json={"message": "x", "session_id": sid}).status_code == 403
    assert len(api.get(f"/api/chats/{sid}", headers=amit).json()["messages"]) == 2    # untouched


def test_without_login_each_picked_person_has_their_own_chats(api):
    api.post("/api/chat", json={"message": "ravi's question", "me_account_id": "acc-ravi"})
    assert [c["title"] for c in api.get("/api/chats", params={"me_account_id": "acc-ravi"}).json()] == ["ravi's question"]
    assert api.get("/api/chats", params={"me_account_id": "acc-amit"}).json() == []


def test_only_five_chats_kept_least_recently_used_goes(api):
    ids = [api.post("/api/chat", json={"message": f"q{i}"}).json()["session_id"] for i in range(5)]
    api.get(f"/api/chats/{ids[0]}")                                            # opening the oldest = using it
    api.post("/api/chat", json={"message": "q5"})
    titles = [c["title"] for c in api.get("/api/chats").json()]
    assert len(titles) == 5 and titles[:2] == ["q5", "q0"] and "q1" not in titles


# ------------------------------------------------------------------ Cloudflare Access (cloudflare mode)
import time as _time  # noqa: E402

import jwt as _jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

from jira_pm import security  # noqa: E402

TEAM, AUD = "example.cloudflareaccess.com", "aud-tag-123"
CF_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def cf_token(email="amit@example.com", key=CF_KEY, aud=AUD, iss=f"https://{TEAM}", exp_in=600):
    now = int(_time.time())
    return _jwt.encode({"email": email, "aud": [aud], "iss": iss, "iat": now, "exp": now + exp_in}, key, algorithm="RS256")


@pytest.fixture
def cf(api, monkeypatch):
    class Keys:                                    # stands in for https://<team>/cdn-cgi/access/certs
        def get_signing_key_from_jwt(self, token):
            return type("K", (), {"key": CF_KEY.public_key()})()
    monkeypatch.setattr(security, "_jwks_client", lambda team: Keys())
    api.set_auth(mode="cloudflare", cf_team_domain=TEAM, cf_aud=AUD)
    return api


def test_cloudflare_mode_accepts_a_valid_access_token(cf):
    h = {"Cf-Access-Jwt-Assertion": cf_token()}
    assert cf.get("/api/projects", headers=h).status_code == 200
    assert cf.get("/api/session", headers=h).json()["user"]["name"] == "Amit"
    cf.cookies.set("CF_Authorization", cf_token())                   # the browser cookie works too
    assert cf.get("/api/projects").status_code == 200


@pytest.mark.parametrize("bad", [
    {"key": OTHER_KEY},                       # forged: signed by someone else
    {"aud": "another-app"},                   # a token for a different Access application
    {"iss": "https://evil.cloudflareaccess.com"},
    {"exp_in": -60},                          # expired
])
def test_cloudflare_mode_rejects_bad_tokens(cf, bad):
    assert cf.get("/api/projects", headers={"Cf-Access-Jwt-Assertion": cf_token(**bad)}).status_code == 401


def test_cloudflare_mode_ignores_a_plain_email_header(cf):
    """Unlike proxy mode, a spoofed email header is worthless without Cloudflare's signature."""
    h = {"Cf-Access-Authenticated-User-Email": "boss@example.com", "X-Forwarded-Email": "boss@example.com"}
    assert cf.get("/api/projects", headers=h).status_code == 401
    assert cf.get("/api/projects", headers={"Cf-Access-Jwt-Assertion": "not.a.token"}).status_code == 401


def test_cloudflare_mode_needs_its_settings_in_production():
    cfg = AuthConfig(env="production", mode="cloudflare")
    assert any("CF_ACCESS_TEAM_DOMAIN" in p for p in cfg.problems())
    assert AuthConfig(env="production", mode="cloudflare", cf_team_domain=TEAM, cf_aud=AUD).problems() == []


def test_cloudflare_mode_still_enforces_the_company_domain(cf):
    """Second lock: even if the Access policy were loosened by mistake, only @example.com gets in."""
    cf.set_auth(allowed_domains=["example.com"])
    assert cf.get("/api/projects", headers={"Cf-Access-Jwt-Assertion": cf_token("amit@example.com")}).status_code == 200
    assert cf.get("/api/projects", headers={"Cf-Access-Jwt-Assertion": cf_token("someone@gmail.com")}).status_code == 403


# ------------------------------------------------------------------ the React page and the login gateway
def test_app_page_is_rechecked_every_time_but_hashed_assets_are_cached(api):
    """After signing out, a browser must ask again for the page (and so meet the sign-in gateway), not reuse a copy."""
    if not server.DIST.exists():
        pytest.skip("React app not built")
    page = api.get("/")
    assert page.status_code == 200 and page.headers["cache-control"] == "no-cache"
    asset = next((server.DIST / "assets").glob("*.js")).name
    assert "immutable" in api.get(f"/assets/{asset}").headers["cache-control"]


# ------------------------------------------------------------------ profile: always your own
def test_profile_is_always_the_signed_in_persons_own(api, monkeypatch):
    seen = []
    monkeypatch.setattr(server.service, "profile", lambda person, email=None: seen.append((person.account_id, email)) or {"ok": 1})
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    assert api.get("/api/profile").status_code == 401                              # no sign-in, no profile
    r = api.get("/api/profile?me_account_id=acc-ravi", headers={"X-Forwarded-Email": "amit@example.com"})
    assert r.status_code == 200 and seen[-1] == ("acc-amit", "amit@example.com")   # asking for Ravi is ignored


# ------------------------------------------------------------------ period filters reach every endpoint
def test_every_period_parameter_keeps_its_own_name(api):
    """Regression: a shared Query() made /api/bugs and /api/bug-reporters expect ?bug_days=, so ?days=7 was ignored."""
    spec = api.get("/openapi.json").json()["paths"]
    names = lambda path: [p["name"] for p in spec[path]["get"].get("parameters", [])]
    assert "bug_days" in names("/api/dashboard")
    assert "days" in names("/api/bugs") and "days" in names("/api/bug-reporters")


def test_bugs_endpoints_use_the_period_they_are_given(api, monkeypatch):
    monkeypatch.setattr(server.service, "bug_overview", lambda d, p=None: {"days": d, "project": p})
    monkeypatch.setattr(server.service, "bug_reporters", lambda d, p=None: {"days": d, "project": p})
    for d in (7, 30, 90):
        assert api.get(f"/api/bugs?days={d}&project=FB").json() == {"days": d, "project": "FB"}
        assert api.get(f"/api/bug-reporters?days={d}").json()["days"] == d


# ------------------------------------------------------------------ team-wide daily cap (keeps LLM use inside free credits)
def test_team_wide_daily_chat_cap(api):
    api.set_auth(mode="proxy", allowed_domains=["example.com"], chat_global_per_day=2)
    amit, ravi = {"X-Forwarded-Email": "amit@example.com"}, {"X-Forwarded-Email": "ravi@example.com"}
    assert api.post("/api/chat", headers=amit, json={"message": "hi"}).status_code == 200
    assert api.post("/api/chat", headers=ravi, json={"message": "hi"}).status_code == 200
    r = api.post("/api/chat", headers=amit, json={"message": "hi"})          # third question from ANYONE today
    assert r.status_code == 429 and "team's daily limit" in r.json()["detail"]
    assert api.get("/api/projects", headers=amit).status_code == 200          # the dashboard keeps working


# ------------------------------------------------------------------ time log: own data only, reasons validated
def test_time_log_is_your_own_and_reasons_are_validated(api, monkeypatch):
    from datetime import date, timedelta, timezone
    monkeypatch.setattr(server.service, "jira_tz", lambda: timezone.utc)
    today = date.today()
    weekday = next(today - timedelta(days=n) for n in range(0, 7) if (today - timedelta(days=n)).weekday() < 5)
    saturday = next(today - timedelta(days=n) for n in range(0, 7) if (today - timedelta(days=n)).weekday() == 5)
    seen = []
    def fake_log(person, days=14, start=None, end=None):
        seen.append(person.account_id)
        return {"from": (today - timedelta(days=days - 1)).isoformat(), "to": today.isoformat(),
                "rows": [{"date": weekday.isoformat(), "status": "short", "weekend": False, "short_by": 2, "extra": 0}], "summary": {}}
    monkeypatch.setattr(server.service, "time_log", fake_log)
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    amit, ravi = {"X-Forwarded-Email": "amit@example.com"}, {"X-Forwarded-Email": "ravi@example.com"}
    put = lambda h, **b: api.put("/api/timelog/reason", headers=h, json=b)
    assert put(amit, day=weekday.isoformat(), reason="half_day", note="doctor").status_code == 200
    r = api.get("/api/timelog?me_account_id=acc-ravi", headers=amit).json()       # asking for Ravi is ignored
    assert seen[-1] == "acc-amit" and r["rows"][0]["reason"] == {"reason": "half_day", "note": "doctor", "other_day": None}
    assert all(row.get("reason") is None for row in api.get("/api/timelog", headers=ravi).json()["rows"])   # not Amit's
    assert put(amit, day=saturday.isoformat(), reason="half_day").status_code == 422   # weekends are off
    assert put(amit, day=(today + timedelta(days=1)).isoformat(), reason="late").status_code == 422
    assert put(amit, day=weekday.isoformat(), reason="made_up").status_code == 422
    assert put(amit, day=weekday.isoformat(), reason="other", note="  ").status_code == 422   # Other needs a note
    assert put(amit, day=weekday.isoformat(), reason=None).status_code == 200                # clear it
    assert api.get("/api/timelog", headers=amit).json()["rows"][0]["reason"] is None


def test_time_log_month_view_and_old_days_are_read_only(api, monkeypatch):
    from datetime import date, timezone
    monkeypatch.setattr(server.service, "jira_tz", lambda: timezone.utc)
    got = {}
    def fake_log(person, days=14, start=None, end=None):
        got.update(start=start, end=end)
        return {"from": start.isoformat(), "to": end.isoformat(), "summary": {},
                "rows": [{"date": start.isoformat(), "status": "short", "weekend": False, "short_by": 2, "extra": 0}]}
    monkeypatch.setattr(server.service, "time_log", fake_log)
    today = date.today()
    this_month = today.strftime("%Y-%m")
    r = api.get(f"/api/timelog?month={this_month}").json()
    assert got["start"] == today.replace(day=1) and got["end"].month == today.month and r["month"] == this_month
    old = (today.replace(day=1) - __import__("datetime").timedelta(days=100)).strftime("%Y-%m")
    assert api.get(f"/api/timelog?month={old}").json()["rows"][0]["editable"] is False     # too old to change
    assert api.get("/api/timelog?month=2099-01").status_code == 422                         # no future months


# ------------------------------------------------------------------ made up on another day / comp off
def test_made_up_and_comp_off_point_at_a_real_extra_day(api, monkeypatch):
    from datetime import date, timedelta, timezone
    monkeypatch.setattr(server.service, "jira_tz", lambda: timezone.utc)
    today = date.today()
    days = [today - timedelta(days=n) for n in range(1, 15)]
    short_day = next(d for d in days if d.weekday() < 5)
    saturday = next(d for d in days if d.weekday() == 5)
    lazy_day = next(d for d in days if d.weekday() < 5 and d != short_day)
    hours = {short_day: 3.0, saturday: 4.0, lazy_day: 5.0}           # Saturday: 4h extra; lazy_day: exactly 5h, no extra
    def row(d):
        need = 0 if d.weekday() >= 5 else 5
        got = hours.get(d, 0.0)
        return {"date": d.isoformat(), "weekend": d.weekday() >= 5, "logged_hours": got, "short_by": max(0, need - got),
                "extra": max(0, got - need), "status": "weekend" if need == 0 else ("met" if got >= need else "short")}
    def fake_log(person, days=14, start=None, end=None):
        start = start or today - timedelta(days=days - 1); end = end or today
        n = (end - start).days + 1
        return {"from": start.isoformat(), "to": end.isoformat(), "summary": {},
                "rows": [row(end - timedelta(days=i)) for i in range(n)]}
    monkeypatch.setattr(server.service, "time_log", fake_log)
    api.set_auth(mode="proxy", allowed_domains=["example.com"])
    amit = {"X-Forwarded-Email": "amit@example.com"}
    put = lambda **b: api.put("/api/timelog/reason", headers=amit, json=b)
    assert put(day=short_day.isoformat(), reason="made_up").status_code == 422                       # which day?
    assert put(day=short_day.isoformat(), reason="made_up", other_day=short_day.isoformat()).status_code == 422
    r = put(day=short_day.isoformat(), reason="made_up", other_day=lazy_day.isoformat())
    assert r.status_code == 422 and "no extra time" in r.json()["detail"]                           # checked against Jira
    assert put(day=short_day.isoformat(), reason="made_up", other_day=saturday.isoformat()).status_code == 200
    log = api.get("/api/timelog?days=14", headers=amit).json()
    rows = {x["date"]: x for x in log["rows"]}
    assert rows[short_day.isoformat()]["reason"]["other_day"] == saturday.isoformat()
    assert rows[saturday.isoformat()]["covers"] == {"days": [short_day.isoformat()], "hours": 2.0, "over_claimed": False}
    assert log["summary"]["made_up_hours"] == 2.0 and log["summary"]["made_up_days"] == 1
