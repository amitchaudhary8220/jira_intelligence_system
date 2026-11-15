"""A small, READ-ONLY Jira Cloud REST client (API v3).

Only GET requests and the search endpoints (which are POST but read-only) are used,
so nothing in Jira can be changed by this app.

JS comparison: this is like a tiny axios instance with baseURL + basic auth + retry.
"""

import time
from datetime import datetime

import httpx


class JiraError(Exception):
    pass


def jql_quote(value: str) -> str:
    """Put a value in double quotes for JQL, escaping quotes/backslashes."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_time(value: str | None) -> datetime | None:
    """Jira timestamps look like 2026-11-12T10:15:30.123+0530."""
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%f%z")


def is_human(user: dict | None) -> bool:
    """Skip bots: Jira Automation, app users, etc. have accountType 'app'."""
    return bool(user) and user.get("accountType", "atlassian") == "atlassian"


class Jira:
    def __init__(self, base_url: str, email: str, api_token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(
            base_url=self.base_url,
            auth=(email, api_token),           # Basic auth: email + API token
            headers={"Accept": "application/json"},
            timeout=timeout,
        )
        self._sprint_field: str | None = None
        self.calls = 0                          # how many HTTP calls we made (for curiosity / tuning)

    # ------------------------------------------------------------------ plumbing
    def _request(self, method: str, path: str, **kwargs):
        for attempt in range(4):
            self.calls += 1
            try:
                resp = self.http.request(method, path, **kwargs)
            except httpx.TransportError as e:
                # Timeout / dropped connection: usually a short Jira hiccup. Wait 1s, 2s, 4s and try again;
                # after that, raise a JiraError so the page shows a readable message instead of crashing.
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise JiraError(f"Jira didn't respond ({type(e).__name__}) on {path} - please try again in a moment") from e
            retryable = resp.status_code == 429 or resp.status_code >= 500
            if retryable and attempt < 3:
                # Jira rate-limits with 429 + Retry-After. Back off and try again.
                time.sleep(min(float(resp.headers.get("Retry-After", 2 ** attempt)), 10))
                continue
            if resp.status_code == 401:
                raise JiraError("401 Unauthorized - check JIRA_EMAIL and JIRA_API_TOKEN in .env")
            if resp.status_code == 403:
                raise JiraError(f"403 Forbidden on {path} - your account can't see this")
            if resp.status_code >= 400:
                raise JiraError(f"{resp.status_code} on {path}: {resp.text[:400]}")
            return resp.json() if resp.content else None
        raise JiraError(f"Gave up on {path} after retries")

    def get(self, path: str, **params):
        return self._request("GET", path, params=params)

    # ------------------------------------------------------------------ endpoints
    def myself(self) -> dict:
        return self.get("/rest/api/3/myself")

    def search(self, jql: str, fields: list[str], expand: str | None = None,
               limit: int | None = None, page_size: int = 100) -> list[dict]:
        """All issues matching `jql` (follows nextPageToken pages). `limit` stops early."""
        issues: list[dict] = []
        token = None
        while True:
            body = {"jql": jql, "fields": fields, "maxResults": page_size}
            if expand:
                body["expand"] = expand
            if token:
                body["nextPageToken"] = token
            data = self._request("POST", "/rest/api/3/search/jql", json=body)
            issues.extend(data.get("issues", []))
            token = data.get("nextPageToken")
            if not token or data.get("isLast") or (limit and len(issues) >= limit):
                return issues[:limit] if limit else issues

    def count(self, jql: str) -> int | None:
        """Fast approximate count (Jira's own estimate). None if the endpoint is unavailable."""
        try:
            return self._request("POST", "/rest/api/3/search/approximate-count", json={"jql": jql})["count"]
        except JiraError:
            return None

    def find_users(self, query: str) -> list[dict]:
        return [u for u in self.get("/rest/api/3/user/search", query=query, maxResults=20) if is_human(u)]

    def projects(self) -> list[dict]:
        out, start = [], 0
        while True:
            data = self.get("/rest/api/3/project/search", startAt=start, maxResults=50)
            out.extend(data["values"])
            if data.get("isLast", True):
                return out
            start += len(data["values"])

    def components(self, project_key: str) -> list[dict]:
        return self.get(f"/rest/api/3/project/{project_key}/components")

    def worklogs(self, issue_key: str, started_after: datetime) -> list[dict]:
        ms = int(started_after.timestamp() * 1000)
        return self.get(f"/rest/api/3/issue/{issue_key}/worklog", startedAfter=ms, maxResults=5000)["worklogs"]

    def comments(self, issue_key: str, newest: int = 100) -> list[dict]:
        return self.get(f"/rest/api/3/issue/{issue_key}/comment", orderBy="-created", maxResults=newest)["comments"]

    def changelog_tail(self, issue_key: str, total: int, size: int = 100) -> list[dict]:
        """The NEWEST `size` changelog entries (the changelog is sorted oldest-first)."""
        data = self.get(f"/rest/api/3/issue/{issue_key}/changelog", startAt=max(0, total - size), maxResults=size)
        return data["values"]

    def sprint_field(self) -> str | None:
        """The custom field id that holds sprints (customfield_10020 on most sites)."""
        if self._sprint_field is None:
            for f in self.get("/rest/api/3/field"):
                if (f.get("schema") or {}).get("custom") == "com.pyxis.greenhopper.jira:gh-sprint":
                    self._sprint_field = f["id"]
                    break
            else:
                self._sprint_field = ""
        return self._sprint_field or None

    def browse_url(self, key: str) -> str:
        return f"{self.base_url}/browse/{key}"
