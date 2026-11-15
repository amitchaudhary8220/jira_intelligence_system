"""Settings read from .env (like process.env in Node, via python-dotenv)."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .naming import DEFAULT_WORKLOG_TAGS

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass
class Settings:
    jira_base_url: str
    jira_email: str
    jira_api_token: str
    inception_api_key: str
    inception_model: str = "mercury-2.5"
    llm_reasoning: str = "none"          # Mercury "thinking" effort: none | low | medium | high
    # A person with an issue in one of these statuses is BUSY (actively working).
    # "Ready to deploy", "Deployed on Staging", "In QA" are NOT here on purpose:
    # the dev part is finished, the ticket is waiting for QA / release.
    active_statuses: list[str] = field(default_factory=lambda: ["In Progress", "In Review", "Ready to merge", "In QA"])
    daily_log_hours: float = 5.0                # time to log per working day (Mon-Fri); DAILY_LOG_HOURS
    roster_path: Path = PROJECT_ROOT / "team.yaml"
    # Worklog categories the team uses: "[Dev] Add version filter to report"
    worklog_tags: list[str] = field(default_factory=lambda: list(DEFAULT_WORKLOG_TAGS))

    @classmethod
    def from_env(cls) -> "Settings":
        missing = [k for k in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN") if not os.getenv(k)]
        if missing:
            raise SystemExit(f"Missing in .env: {', '.join(missing)}  (see .env.example)")
        return cls(
            jira_base_url=os.environ["JIRA_BASE_URL"].rstrip("/"),
            jira_email=os.environ["JIRA_EMAIL"],
            jira_api_token=os.environ["JIRA_API_TOKEN"],
            inception_api_key=os.getenv("INCEPTION_API_KEY", ""),
            inception_model=os.getenv("INCEPTION_MODEL", "mercury-2.5"),
            llm_reasoning=os.getenv("LLM_REASONING", "none"),
            active_statuses=_list(os.getenv("ACTIVE_STATUSES", "In Progress,In Review,Ready to merge,In QA")),
            daily_log_hours=float(os.getenv("DAILY_LOG_HOURS", "5")),
            worklog_tags=_list(os.getenv("WORKLOG_TAGS", "")) or list(DEFAULT_WORKLOG_TAGS),
        )
