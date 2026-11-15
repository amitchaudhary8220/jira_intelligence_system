"""Every good and bad example from 'Jira Ticket Naming Convention Standard' must be judged correctly."""

import pytest

from jira_pm.naming import check_title, is_compliant

GOOD = [
    ("iOS | Global Search | Add shimmer loading state", "Story"),
    ("Voter Module | User Side | Support dynamic form handling", "Story"),
    ("Login | Add recent searches to global search", "Task"),
    ("Global Search | Add recent search history", "Task"),
    ("Onboarding | Validate status and resume incomplete flows", "Task"),
    ("Magazine | Unpublished magazines are visible to users", "Bug"),
    ("Magazine | Shared link opens unpublished magazine", "Bug"),
    ("Home Page API | Returns 500 error for specific users", "Bug"),
    ("ID Card Generator | Design non-core unit name display state", "Design"),
    ("Toast Messages | Design Android and iOS variants", "Design"),
    ("Production Domains | Add PagerDuty availability alerts", "DevOps"),
    ("Private Staging Cluster | Migrate Client app", "DevOps"),
    ("Jira Sprint Rollover | Auto-label rolled issues by reason", "Automation"),
    ("Release Notes Workflow | Auto-remind owners for missing entries", "Automation"),
    ("Membership | Improve assisted onboarding journey", "Project Roadmap"),
    ("Bulk Notifications | Validate safe send-rate thresholds", "POC Task"),
    ("[Q3 FY26] Calling improve assignment reliability", "Epic"),
    ("[Q3 FY26] Inbox improve message delivery reliability", "Epic"),
    ("Add API validation for duplicate voter ID in upload flow", "Sub-task"),
    ("Add duplicate voter ID validation in upload API", "Sub-task"),
    ("Update delete voter request placeholder text in user flow", "Sub-task"),
    ("Log pub/sub message details when consumer receives event", "Sub-task"),
    ("Design birthday dashboard home page layout", "Sub-task"),
    ("Enable disabled PM users for reassignment workflow", "Sub-task"),
    ("Add concurrent user log processing using goroutines", "Sub-task"),
    ("Update campaign structure based on demo feedback", "Sub-task"),
]

BAD = [
    ("changes after demo", "Sub-task"),
    ("fix issue", "Sub-task"),
    ("update data", "Sub-task"),
    ("store payload and set limit", "Sub-task"),
    ("is_disabled false check", "Sub-task"),
    ("invalid payload store in communication log and also set limit for per user token fetch", "Sub-task"),
    ("user logs and run for multiple user with go routine", "Sub-task"),
    ("update communication logs for pub/sub message when consume", "Sub-task"),
    ("Update PmUsers is_disabled check to false", "Sub-task"),
    ("update - update placeholder for request to delete voters", "Sub-task"),
    ("changes in campaign structure after demo", "Sub-task"),
    ("Design and Developed Birthday Dashboard Home Page", "Task"),
    ("iOS || opening transition when clicked on global search.", "Task"),
    ("Generic Voter Module | Backend Improvements | bug-fixes and improves", "Story"),
    ("Something went wrong error on banner click", "Bug"),
    ("DevOps Miscellaneous Week 4", "Epic"),
    ("Design Intern Tasks", "Epic"),
    ("DevOps Misc Tasks Week 3", "DevOps"),
    ("carousel list fix time zone issue", "Task"),
]


@pytest.mark.parametrize("title,itype", GOOD)
def test_good_titles_pass(title, itype):
    findings = check_title(title, itype)
    assert is_compliant(findings), [f.message for f in findings]


@pytest.mark.parametrize("title,itype", BAD)
def test_bad_titles_fail(title, itype):
    assert not is_compliant(check_title(title, itype))


@pytest.mark.parametrize("note,ok", [
    ("[Dev] Add form version selection for submissions report", True),
    ("[Testing] Tested this feature for all language translations", True),
    ("[Code Review] - Reviewed the code submitted by Ravi", True),
    ("[Dev]", False),                      # tag only
    ("[Testing] - Test execution.", False),  # too short
    ("Fixed the login page", False),        # no tag
    ("", False),
])
def test_worklog_convention(note, ok):
    from jira_pm.naming import check_worklog
    assert is_compliant(check_worklog(note)) is ok
