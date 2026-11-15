"""Production guard rails: who is calling (login), how much they may call (rate limits), safe headers, logs.

Login modes (AUTH_MODE in .env):
  none      Local development only. Anyone can pick any person in "I am".
  password  A shared password + the user types their work email. Quick for a pilot. The email isn't verified,
            so treat this as a gate, not real identity.
  proxy     Recommended for production. Put the app behind your company's SSO gateway (Cloudflare Access,
            Google IAP, oauth2-proxy, ...). The gateway logs people in and passes their email in a header
            (AUTH_HEADER, default X-Forwarded-Email). That email is the user's identity; "I am" is locked to it.
            The deploy ships one: Caddy (HTTPS) + oauth2-proxy ("Sign in with Google", company domain only).
            LOGOUT_URL is the gateway's sign-out page (oauth2-proxy: /oauth2/sign_out).
  cloudflare  Cloudflare Access in front (Cloudflare Tunnel). Stronger than proxy: instead of trusting a header,
            the app checks the token Cloudflare signs for every request (Cf-Access-Jwt-Assertion): signature
            against your team's public keys, audience (CF_ACCESS_AUD), issuer and expiry. Who may sign in is set
            in the Access policy (and optionally narrowed again by ALLOWED_EMAIL_DOMAINS).

In production (APP_ENV=production) the server refuses to start without a login mode and a strong secret.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

import jwt

log = logging.getLogger("jira_pm.access")

COOKIE = "jp_session"
PUBLIC_API = {"/api/health", "/api/session", "/api/login", "/api/logout"}


def _list(value: str) -> list[str]:
    return [v.strip().lower() for v in value.split(",") if v.strip()]


@dataclass
class AuthConfig:
    env: str = "development"                 # development | production
    mode: str = "none"                       # none | password | proxy | cloudflare
    password: str = ""
    secret: bytes = b""
    header: str = "X-Forwarded-Email"
    allowed_domains: list[str] = field(default_factory=list)   # e.g. ["example.com"]; empty = any
    chat_per_minute: int = 15
    chat_per_day: int = 300
    chat_global_per_day: int = 0             # whole team, all users together (0 = no cap). Keeps LLM use inside a free tier.
    api_per_minute: int = 240
    session_hours: int = 12
    cf_team_domain: str = ""                 # cloudflare mode: e.g. "yourteam.cloudflareaccess.com"
    cf_aud: str = ""                         # cloudflare mode: the Access application's "Application Audience (AUD) tag"
    logout_url: str = ""                     # where "Sign out" goes when a gateway owns the login

    @classmethod
    def from_env(cls) -> "AuthConfig":
        env = os.getenv("APP_ENV", "development").lower()
        # Strict limits in production; relaxed in development so test suites (which run at machine speed) work.
        prod = env == "production"
        return cls(
            env=env,
            chat_per_minute=int(os.getenv("CHAT_PER_MINUTE", "15" if prod else "120")),
            chat_per_day=int(os.getenv("CHAT_PER_DAY", "300" if prod else "5000")),
            chat_global_per_day=int(os.getenv("CHAT_GLOBAL_PER_DAY", "1000" if prod else "0")),
            api_per_minute=int(os.getenv("API_PER_MINUTE", "240" if prod else "6000")),
            **cls._login_from_env(),
        )

    @staticmethod
    def _login_from_env() -> dict:
        return dict(
            mode=os.getenv("AUTH_MODE", "none").lower(),
            password=os.getenv("APP_PASSWORD", ""),
            secret=os.getenv("SECRET_KEY", "").encode(),
            header=os.getenv("AUTH_HEADER", "X-Forwarded-Email"),
            allowed_domains=_list(os.getenv("ALLOWED_EMAIL_DOMAINS", "")),
            session_hours=int(os.getenv("SESSION_HOURS", "12")),
            cf_team_domain=os.getenv("CF_ACCESS_TEAM_DOMAIN", "").strip().removeprefix("https://").rstrip("/"),
            cf_aud=os.getenv("CF_ACCESS_AUD", "").strip(),
            logout_url=os.getenv("LOGOUT_URL", "").strip()
                       or ("/cdn-cgi/access/logout" if os.getenv("AUTH_MODE", "").lower() == "cloudflare" else ""),
        )

    @property
    def production(self) -> bool:
        return self.env == "production"

    def problems(self) -> list[str]:
        """What makes this config unsafe for production (empty list = fine)."""
        out = []
        if self.mode not in ("none", "password", "proxy", "cloudflare"):
            out.append(f"AUTH_MODE must be none, password, proxy or cloudflare (got {self.mode!r})")
        if self.mode == "cloudflare" and not (self.cf_team_domain and self.cf_aud):
            out.append("cloudflare mode needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (Zero Trust > Access > your app)")
        if self.mode == "none" and os.getenv("ALLOW_NO_AUTH") != "1":
            out.append("AUTH_MODE=none: anyone could see everyone's data. Use proxy (company SSO) or password")
        if self.mode == "password" and len(self.password) < 12:
            out.append("APP_PASSWORD must be at least 12 characters")
        if self.mode == "password" and len(self.secret) < 32:
            out.append("SECRET_KEY must be at least 32 characters (it signs login cookies)")
        if self.mode == "proxy" and not self.allowed_domains:
            out.append("set ALLOWED_EMAIL_DOMAINS (e.g. your-company.com) so only your company's accounts get in")
        return out

    def domain_ok(self, email: str) -> bool:
        return not self.allowed_domains or email.rsplit("@", 1)[-1].lower() in self.allowed_domains


# ------------------------------------------------------------------ signed session cookie (password mode)
def make_cookie(cfg: AuthConfig, email: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"email": email, "exp": int(time.time()) + cfg.session_hours * 3600}).encode()).decode()
    sig = hmac.new(cfg.secret, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def read_cookie(cfg: AuthConfig, value: str | None) -> str | None:
    """The email in a valid, unexpired, untampered cookie - else None."""
    if not value or "." not in value or not cfg.secret:
        return None
    payload, sig = value.rsplit(".", 1)
    good = hmac.new(cfg.secret, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
    except (ValueError, json.JSONDecodeError):
        return None
    return data.get("email") if data.get("exp", 0) > time.time() else None


# ------------------------------------------------------------------ Cloudflare Access token (cloudflare mode)
_jwks: dict[str, jwt.PyJWKClient] = {}
_jwks_lock = threading.Lock()


def _jwks_client(team_domain: str) -> jwt.PyJWKClient:
    with _jwks_lock:
        if team_domain not in _jwks:      # keys are cached; Cloudflare rotates them, PyJWKClient refetches unknown ones
            _jwks[team_domain] = jwt.PyJWKClient(f"https://{team_domain}/cdn-cgi/access/certs", cache_keys=True, lifespan=3600)
        return _jwks[team_domain]


def cloudflare_email(cfg: AuthConfig, token: str | None, signing_key=None) -> str | None:
    """The email inside a valid Cloudflare Access token, else None. signing_key is for tests."""
    if not token:
        return None
    try:
        key = signing_key or _jwks_client(cfg.cf_team_domain).get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=cfg.cf_aud,
                            issuer=f"https://{cfg.cf_team_domain}", options={"require": ["exp", "iat", "aud", "iss"]})
    except Exception as e:  # noqa: BLE001 - bad signature, expired, wrong audience, key fetch failed: all = not signed in
        log.warning("rejected Cloudflare Access token: %s", type(e).__name__)
        return None
    email = str(claims.get("email") or "").strip().lower()
    return email or None


def email_from_request(cfg: AuthConfig, headers, cookies) -> str | None:
    """Who is calling, by login mode. None = not signed in."""
    if cfg.mode == "cloudflare":
        return cloudflare_email(cfg, headers.get("Cf-Access-Jwt-Assertion") or cookies.get("CF_Authorization"))
    if cfg.mode == "proxy":
        raw = headers.get(cfg.header) or ""
        email = raw.split(":", 1)[-1].strip().lower()       # Google IAP sends "accounts.google.com:me@co.com"
        return email or None
    if cfg.mode == "password":
        return read_cookie(cfg, cookies.get(COOKIE))
    return None


def password_ok(cfg: AuthConfig, given: str) -> bool:
    return bool(cfg.password) and hmac.compare_digest(given.encode(), cfg.password.encode())


# ------------------------------------------------------------------ rate limits
class RateLimiter:
    """Sliding-window limits per key (user email or client IP). In memory: one server process."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_s: int) -> int:
        """Record a call. Returns 0 if allowed, else seconds until the next call is allowed."""
        now = time.time()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window_s:
                q.popleft()
            if len(q) >= limit:
                return int(q[0] + window_s - now) + 1
            q.append(now)
            return 0

    def reset(self):
        with self._lock:
            self._hits.clear()


# ------------------------------------------------------------------ headers
def security_headers(production: bool, https: bool) -> dict[str, str]:
    h = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        # microphone=(self): voice search needs it on this page only
        "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
        # React sets inline style attributes, hence 'unsafe-inline' for styles only; scripts are same-origin files.
        # Images: Jira profile photos come from Gravatar or Atlassian's avatar CDN (nothing else).
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                   "img-src 'self' data: https://secure.gravatar.com https://*.atl-paas.net; "
                                   "connect-src 'self'; frame-ancestors 'none'; "
                                   "base-uri 'self'; form-action 'self'",
    }
    if production and https:
        h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return h
