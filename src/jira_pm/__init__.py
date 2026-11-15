"""Jira PM agent: answers product-manager questions from Jira."""

from .config import Settings
from .jira_client import Jira, JiraError
from .metrics import PMService
from .roster import Person, Roster

__all__ = ["Settings", "Jira", "JiraError", "PMService", "Person", "Roster"]
