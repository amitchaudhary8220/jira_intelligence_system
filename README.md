# Jira PM Agent (learning project 5)

A chat agent that answers product managers' questions from Jira:

- "What's assigned to me?" / "What am I working on?"
- "How many bugs were reported in Form Builder this month?"
- "How many developers work on the voter module?"
- "How many developers are free today?"
- "Who did nothing in Jira in the last 7 days?"
- "Who isn't following the ticket naming standard?" / "Who logs time without a description?"

**Stack:** Python, the OpenAI Agents SDK running Inception's `mercury-2.5`, the Jira REST API v3 (read-only), FastAPI, and React (Vite + TypeScript).

## How it works

```
React chat  ──/api/chat──▶  FastAPI  ──▶  Agent (Inception Mercury)
                                              │ picks a tool
                                              ▼
                                   metrics.py (plain Python) ──▶ Jira REST API
                                   counts, groups, filters        (read-only)
```

The LLM **never counts**. It chooses a tool, Python gets the exact numbers from Jira, and the LLM writes the answer. Step 1 runs the same functions with no LLM, so you can check every number.

## Setup

```bash
make setup     # uv sync + npm install + .env
# edit .env: JIRA_API_TOKEN (https://id.atlassian.com/manage-profile/security/api-tokens, classic token)
make check     # checks that the Jira and Inception keys work
make roster    # writes team.yaml; then set each person's role (dev/qa/pm/...)
```

## Steps

| Step | Command | What it shows |
|---|---|---|
| 0 | `make check` | Keys work, which projects you can see |
| 1 | `make step1` | Every report as plain Python tables, **no LLM** |
| 2 | `make chat` / `make demo` | The agent in the terminal, with the tools it called under each answer |
| 3 | `make dev`, then open http://localhost:5173 | Dashboard + chat UI, with hot reload |
| 3 (prod) | `make build && make server`, then open http://localhost:8010 | One server for everything |

## Definitions (change them in `.env` / `team.yaml`)

| Term | Meaning |
|---|---|
| Feature | A Jira **component** ("Form Builder", "Voter Module User Portal"). "voter module" matches all three Voter Module components. If no component matches, a project name is used. |
| Person name | Typo-tolerant ("karan boes" → Karan Bose, "lakshmi raman" → lakshmi.raman). Whole-word matches win ("ravi" → Ravi Kumar Mehra, not Kiran Ravishankar). Several equally good matches → it asks which one. A corrected typo is always shown as "Assuming you meant …". Logic: `name_score()` in `roster.py`. |
| Busy | Has an issue in `ACTIVE_STATUSES` (default: In Progress, In Review, Ready to merge) |
| Free | Not busy. Split into *free, nothing queued* and *free, has To Do in the sprint* |
| Not busy | Deployed on Staging, In QA, Ready to deploy. The dev work is done and the ticket is waiting on QA or release. |
| Inactive | On the roster, but no worklog, status change, field edit, comment or new issue in N days |
| Developer | Role `dev` / `devops` / `lead` / `unknown` in team.yaml |
| Bad ticket title | Breaks the *Jira Ticket Naming Convention Standard* (PDF): `Module \| Verb + outcome`, bugs `Module \| What is broken`, sub-tasks start with a verb, epics `[Qx FYyy] …`; no past tense, misc/changes buckets or code shorthand. Charged to the ticket **creator**. Rules in `naming.py`; every PDF example is a test in `tests/test_naming.py`. |
| Bad worklog | Not `[Category] what was done`, e.g. a bare `[Dev]`. **Not in the PDF**: inferred from the team's own worklogs (98% of 1,390 already use tags). Categories: `WORKLOG_TAGS` in `.env`. |

**Limits:** leave and holidays aren't in Jira, and neither is work done without updating tickets. "Free" and "inactive" are hints to look into, not verdicts.

## Files

```
src/jira_pm/
  config.py        settings from .env
  jira_client.py   read-only Jira REST client (search pagination, retries on 429)
  roster.py        team list (team.yaml, or automatic: recent assignees)
  metrics.py       the answers: person_issues, feature_bugs, feature_developers,
                   free_developers, inactive_people, naming_compliance, worklog_quality,
                   dashboard, list_features, search_issues
  naming.py        naming-standard + worklog-convention rules (plain regex, easy to edit)
  agent.py         Agents SDK: tools + system prompt + Chat (conversation memory)
  server.py        FastAPI: /api/people, /api/chat, serves frontend/dist
frontend/src/      React app: App.tsx (dashboard), components/ChatPanel.tsx, components/charts.tsx
steps/             step0_check, build_roster, step1_reports, step2_chat
tests/             unit tests with a fake Jira
```

## Before sharing with the team

- **Login:** the "I am" picker is not authentication. Put the app behind company SSO and take the user's identity from the login.
- **Access:** use a dedicated read-only service account, or OAuth so each PM only sees projects they're allowed to see.
- **Approval:** get sign-off on the people-activity reports, and on sending Jira text to an outside LLM.

Port: 8010 by default (8000 was taken on this machine). Change it with `make server PORT=9000`; for `make dev`, also update the proxy in `frontend/vite.config.ts`.

## Dashboard features (Jira Pulse)

- **Ask bar + voice.** Type or tap the mic. Voice uses the browser's speech recognition (Chrome/Edge): pick
  **Hinglish** (`en-IN`, mixed speech comes back in English letters) or **हिंदी** (`hi-IN`, Devanagari). It stops by
  itself after 1.2 s of silence. Note: Chrome sends audio to Google. For better Indian-language accuracy and
  privacy, the next step is server-side Sarvam STT (needs `SARVAM_API_KEY`).
- **Period filter** (7 / 30 / 90 days) applies to bugs, ticket titles and worklogs. The People tab is "right now",
  and inactivity is always the last 7 days.
- **Click any chart** (pipeline bar, bug segment, feature name, week column, workload bar, bug tiles) to list
  the actual tickets, with a text filter, "Open in Jira" and "Ask about these".
- **Sprints** tab: pick a sprint (current, last, or any) to see delivered % (released by the end date), what didn't
  deliver (dev done / in progress / not started / finished late), carried over, added mid-sprint, reopened,
  per project. Also a delivered % trend over 6 sprints, developer and tester tables, and per-metric highlights
  (not one combined score). A company sprint = the same-named sprint on all 13 boards. Story points aren't used,
  so delivery is counted in tickets; developer "delivered" counts top-level tickets, with sub-tasks separate.
- **Bugs project filter**: scope the Bugs tab (and its click-through lists) to one project.
- **Chat history** (left sidebar, like ChatGPT/Claude) is saved on the server in SQLite (`data/chats.sqlite3`),
  per signed-in person (or per "I am" person without login), so it follows you to any browser. **Only your last 5
  chats are kept**: when you already have 5, asking in a new chat removes the one you used least recently (opening
  a chat counts as using it). The sidebar says this, and the new-chat screen names the chat that would go.
  Chats untouched for 90 days are deleted (`HISTORY_RETENTION_DAYS`). Nobody can open someone else's chat.
- **Logo**: clicking "Jira Pulse" takes you back to the home page (Overview).
- **Naming guide** tab (`/#guide`): the company naming standard as a readable page, plus live title and worklog
  checkers that use the same rules as the dashboard.

## Going to production

**Checklist (do these before sharing the URL):**
1. **Login.** Use `AUTH_MODE=proxy` behind your company SSO gateway (Cloudflare Access, Google IAP, oauth2-proxy…)
   with `ALLOWED_EMAIL_DOMAINS=your-company.com`, or `AUTH_MODE=password` (shared password of 12+ characters,
   plus a 32+ character `SECRET_KEY`) for a short pilot. With `APP_ENV=production` the server **refuses to start**
   without one of these.
2. **Jira token.** Create a dedicated read-only service account and use its token, not a personal one. Give it
   "Browse users" permission, or add an `email:` per person in `team.yaml`; either one lets sign-in find "me".
3. **team.yaml.** Set every person's `role` (dev / qa / pm…) and `email`.
4. **Approvals.** Get sign-off for sending Jira text to the LLM provider (Inception) and for the people/activity reports.
5. **HTTPS.** Terminate HTTPS at the gateway or load balancer. The app sends HSTS when it sees `X-Forwarded-Proto: https`.

**Run it:** `make docker` (`docker compose up -d --build`), or `make prod` without Docker. Keep it to **one** process,
because caches and live chat sessions live in memory. Chat history is in `data/chats.sqlite3` (in Docker: the `chat-data`
volume, so it survives rebuilds); back it up if the history matters. Health check: `GET /api/health` (public). Logs: one line per
request, with the user and the time taken. Chat text is never logged.

**Built in:** login (proxy or password) with signed, HttpOnly session cookies; "I am" locked to the signed-in person;
an email-domain allow-list; rate limits (chat per minute and per day, all API calls, sign-in attempts); input size
limits; security headers (CSP, frame blocking, nosniff, HSTS); API docs hidden in production; no stack traces sent
to browsers; Jira timeouts retried.

## Share from this Mac (quickest, for now)

`make share` runs a second copy of the app in Docker (production mode) behind **Sign in with Google** (oauth2-proxy,
only `ALLOWED_EMAIL_DOMAINS` accounts) and puts it online through a free Cloudflare quick tunnel: it prints a
`https://<words>.trycloudflare.com` link. The dev server on :8010 stays private. `make unshare` stops it.

1. Google Cloud Console (company account) > APIs & Services > OAuth consent screen: **Internal**. Then Credentials >
   Create credentials > OAuth client ID > Web application.
2. Put the client ID and secret in `.env.public` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), run `make share`.
3. Add the redirect URI it prints (`<link>/oauth2/callback`) to the OAuth client's Authorized redirect URIs.

- No Google client = no sharing (there is no fallback login).
- Keep it up: `make keep-up` installs two launchd jobs: a watchdog that checks the address every minute (starts Docker
  after a reboot, replaces a dead quick tunnel and re-points the Worker; repairs logged in `data/watchdog.log`) and
  `caffeinate -s` so the Mac doesn't sleep on power. `make keep-down` removes them. Still needs the Mac on, logged in
  and plugged in; for 24/7 use the VM deploy below.
- Fixed address: set `PUBLIC_URL=https://jira-pulse.<subdomain>.workers.dev` in `.env.public` (register the workers.dev
  subdomain once in the Cloudflare dashboard, `cd deploy/worker && npx wrangler@4.156.0 login` once). A tiny Worker
  (`deploy/worker`) forwards that address to the tunnel; `make share` re-points it whenever the tunnel link changes, so
  people and Google's redirect URI (`<PUBLIC_URL>/oauth2/callback`) only ever see the fixed address.
- Works while this Mac is awake and Docker Desktop runs. The link survives `make share` re-runs; it changes when the
  tunnel restarts (Mac reboot, `make unshare`), and then step 3 has to be repeated with the new link.

## Deploy: Oracle Cloud (free VM) + a login in front

The app runs on a free Oracle VM, with one of two logins in front (`AUTH_MODE` in `.env.production`):

| | **A. Sign in with Google** (`AUTH_MODE=proxy`) | **B. Cloudflare** (`AUTH_MODE=cloudflare`) |
|---|---|---|
| Use when | your company email is Google Workspace; any subdomain of the company domain | you have a domain on Cloudflare |
| What runs | Caddy (free HTTPS, Let's Encrypt) + oauth2-proxy (Google login) on the VM | Cloudflare Tunnel; Cloudflare Access does the login |
| Who gets in | Google accounts in `ALLOWED_EMAIL_DOMAINS` (checked by oauth2-proxy and again by the app) | the Access policy (+ `ALLOWED_EMAIL_DOMAINS`) |
| Ports on the VM | 80 + 443 (the deploy opens them in the VM firewall) | none |
| Cost | free | free (up to 50 users) |

In A, Caddy drops any identity headers the browser sends, so only oauth2-proxy (after a real Google sign-in) can tell
the app who someone is. In B, the app checks Cloudflare's signed token on every request.

**1. Oracle VM (once, ~15 min)**
1. Sign up for Oracle Cloud **Always Free** (a card is needed for verification; Always Free resources aren't
   charged). Pick a home region near you (e.g. Mumbai or Hyderabad); it can't be changed later.
2. Compute > Instances > Create: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex (Ampere ARM), 2 OCPU / 12 GB**.
   If Oracle says "Out of capacity" (common for free ARM), use **VM.Standard.E2.1.Micro** (AMD, 1 GB) instead: the app needs ~150 MB,
   and `make deploy` notices the small VM, builds the image on your Mac for its CPU, copies it over SSH and adds 2 GB swap.
3. Under SSH keys, paste your Mac's public key: `cat ~/.ssh/id_ed25519.pub`.
4. Note the public IP, and check that `ssh ubuntu@<ip>` works.

**2A. Google sign-in (once, ~10 min)**
1. DNS: ask whoever manages the company domain to add an **A record** `pulse` -> `<vm-ip>`
   (wherever your domain's DNS is hosted). Check: `dig +short pulse.example.com` shows the VM's IP.
2. [Google Cloud Console](https://console.cloud.google.com) (signed in with your company account) > create a project >
   **APIs & Services > OAuth consent screen**: User type **Internal** (only your company's accounts can sign in), app name
   "Jira Pulse". Then **Credentials > Create credentials > OAuth client ID** > Web application, Authorized redirect URI
   `https://pulse.example.com/oauth2/callback`. Copy the client ID and secret into `.env.production`.
3. `OAUTH2_COOKIE_SECRET`: generate with the command in `.env.production.example`.

**2B. Cloudflare instead (once, ~10 min)**, in the dashboard under **Zero Trust**:
1. **Networks > Tunnels > Create a tunnel** > Cloudflared > name it `jira-pulse`. From the install command shown,
   copy only the token (the long string after `--token`). You don't need to run that command; Docker runs it.
2. In the same tunnel, open **Public hostname > Add**: subdomain `pulse`, your domain, service type **HTTP**, URL
   `jira-pulse:8010`.
3. **Access > Applications > Add > Self-hosted**: application domain `pulse.<your-domain>`. Add a policy with
   action **Allow** and Include **Emails ending in** `@your-company.com` (or a list of emails). Login method:
   One-time PIN or Google. Save, then copy the **Application Audience (AUD) Tag** from the app's overview.
4. **Settings > Custom pages** shows your team domain (`<team>.cloudflareaccess.com`).

**3. Deploy (from this Mac)**
```bash
cp .env.production.example .env.production   # fill in: Jira service-account token, Inception key, block A or B
make deploy HOST=ubuntu@<vm-ip>              # installs Docker, copies the code, builds, starts app + login gateway
```
Open `https://pulse.<your-domain>`: Google (A) or Cloudflare (B) asks you to sign in, then the dashboard opens.

**Afterwards**
- Update: run `make deploy HOST=...` again (the chat history volume is kept).
- Logs: `ssh ubuntu@<ip> 'cd jira-pulse && docker compose logs -f --tail 100'`
- Change who gets in: A: `ALLOWED_EMAIL_DOMAINS`, then redeploy. B: edit the Access policy in Cloudflare (no redeploy).
- Backups (the app's own data: time-log reasons + chat history; Jira data lives in Jira): `make deploy` installs a
  nightly job (21:00 UTC / 02:30 IST, `deploy/backup_db.sh`) that keeps the last 14 copies in the data volume
  (`/app/data/backups/`). Restore steps are at the top of that script. For losing the whole VM, add an Oracle
  boot-volume backup policy (weekly, keep 4, stays inside the 5 free volume backups).

## Keep it running

- `make up`: starts the server in the background under a watchdog. If the server exits or stops answering for
  about a minute, the watchdog restarts it, and the Mac is kept awake while it runs (`caffeinate`; closing a
  MacBook lid still sleeps it). Logs go to `logs/server.log`. Code edits in `src/` are picked up automatically.
- `make status`: shows whether the watchdog, the server and the keep-awake are running.
- `make down`: stops all of it, and the Mac can sleep normally again.

## Tests

- `make test`: backend (fake Jira, no network)
- `make test-ui`: frontend; clicks every filter, tab, chart, the guide checkers and voice input (fake backend)
- `make test-all`: both of the above
- `make test-live`: **real Jira + the running server**. Every number on the dashboard must equal the length of its
  click-through list, the filters must change what they claim to, and every sprint in the dropdown must load and add up.
- `make test-e2e`: **real Chrome** (your installed browser, headless) clicks everything on every tab against real
  data, checks each number against its list and the API, and saves screenshots to `frontend/e2e/screenshots/`.
- `make test-agent`: asks the live agent about 40 PM questions (English, Hinglish, Devanagari, typos) and checks
  the tool it used and the numbers in its answer against Jira.
