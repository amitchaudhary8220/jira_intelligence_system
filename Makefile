# Jira PM Agent - learning project 5
# Usage: make <target>    e.g.  make step1 ONLY=bugs FEATURE="voter module"   |   make chat Q="who is free?"

ONLY    ?=
WHO     ?=
FEATURE ?=
DAYS    ?=
Q       ?=
AS      ?=
FORCE   ?=
APPLY   ?=
PORT    ?= 8010
HOST    ?=

# uv would otherwise complain if another project's venv is active in this shell
UV := env -u VIRTUAL_ENV uv
PY := $(UV) run python


.PHONY: deploy share unshare keep-up keep-down
.PHONY: help setup check roster step1 chat demo server dev build test test-ui test-all up down status test-live test-agent test-e2e prod docker
.DEFAULT_GOAL := help

prod: build ## Production mode on this machine: no auto-reload, real login required (see .env.example "Production")
	APP_ENV=production $(UV) run uvicorn jira_pm.server:app --host $${HOST:-127.0.0.1} --port $(PORT) --proxy-headers --no-access-log

deploy: ## Deploy to the Oracle VM with login in front (HOST=ubuntu@<vm-ip>; needs .env.production; BUILD_ON=local|vm)
	@test -n "$(HOST)" || (echo "usage: make deploy HOST=ubuntu@<vm-ip>"; exit 1)
	scripts/deploy_oracle.sh $(HOST)

docker: ## Build and start the production container (needs Docker running)
	docker compose up -d --build

# true when the watchdog from `make up` is alive (the pid file is just overwritten on each start)
WATCHDOG_ALIVE = [ -f logs/watchdog.pid ] && ps -p $$(cat logs/watchdog.pid) -o command= 2>/dev/null | grep -q serve_forever

help: ## Show all commands
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-8s %s\n", $$1, $$2}'

setup: ## Install Python + frontend deps, create .env from the example
	$(UV) sync
	cd frontend && npm install
	@test -f .env || (cp .env.example .env && echo "Created .env - fill in JIRA_API_TOKEN and INCEPTION_API_KEY")

check: ## Step 0: test the Jira + Inception keys in .env
	$(PY) steps/step0_check.py

roster: ## Write team.yaml from Jira (people assigned in the last 60 days) - then set roles by hand
	$(PY) steps/build_roster.py $(if $(DAYS),--days $(DAYS)) $(if $(FORCE),--force)

roles: ## Suggest roles for team.yaml from Jira activity -> team.suggested.yaml  (APPLY=1 fills only "unknown" roles)
	$(PY) steps/suggest_roles.py $(if $(DAYS),--days $(DAYS)) $(if $(APPLY),--apply)

step1: ## Step 1: all reports, plain Python, no LLM  (ONLY=mine|bugs|devs|free|inactive|naming|features)
	$(PY) steps/step1_reports.py $(if $(ONLY),--only $(ONLY)) $(if $(WHO),--who "$(WHO)") $(if $(FEATURE),--feature "$(FEATURE)") $(if $(DAYS),--days $(DAYS))

chat: ## Step 2: chat with the agent in the terminal  (Q="one question", AS="name")
	$(PY) steps/step2_chat.py $(if $(Q),--q "$(Q)") $(if $(AS),--as-person "$(AS)")

demo: ## Step 2: run the fixed list of PM questions through the agent (end-to-end check)
	$(PY) steps/step2_chat.py --demo

server: ## Step 3: FastAPI on http://localhost:$(PORT) (serves the built React app too)
	$(UV) run uvicorn jira_pm.server:app --port $(PORT)

up: ## Keep the server running in the background; restarts it if it stops (logs: logs/server.log)
	@if $(WATCHDOG_ALIVE); then \
		echo "already running (watchdog pid $$(cat logs/watchdog.pid)) -> http://localhost:$(PORT)"; \
	else \
		( PORT=$(PORT) nohup scripts/serve_forever.sh >/dev/null 2>&1 & ); \
		for i in $$(seq 1 40); do curl -s -o /dev/null -f http://127.0.0.1:$(PORT)/api/health && break; sleep 1; done; \
		echo "running -> http://localhost:$(PORT)   (make status | make down | logs/server.log)"; \
	fi

down: ## Stop the background server and its watchdog
	@if $(WATCHDOG_ALIVE); then kill $$(cat logs/watchdog.pid); sleep 3; fi; \
	pids=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null); if [ -n "$$pids" ]; then kill $$pids 2>/dev/null; fi; \
	echo "stopped"

status: ## Is the server up, and is the watchdog guarding it?
	@if $(WATCHDOG_ALIVE); then echo "watchdog: running (pid $$(cat logs/watchdog.pid))"; else echo "watchdog: not running (start it: make up)"; fi; \
	if pmset -g assertions | grep -q "caffeinate asserting on behalf of Process ID $$(cat logs/watchdog.pid 2>/dev/null)"; then echo "mac:      kept awake (caffeinate)"; else echo "mac:      may sleep"; fi; \
	curl -s -o /dev/null -m 10 -w "server:   HTTP %{http_code} in %{time_total}s -> http://localhost:$(PORT)\n" http://127.0.0.1:$(PORT)/api/health || echo "server:   down"

dev: ## Step 3 while coding: FastAPI :$(PORT) + React with hot reload on http://localhost:5173
	@trap 'kill 0' EXIT; $(UV) run uvicorn jira_pm.server:app --port $(PORT) --reload & cd frontend && npm run dev

build: ## Build the React app into frontend/dist (then `make server` serves everything)
	cd frontend && npm run build

test: ## Backend unit tests (fake Jira, no network)
	JIRA_API_TOKEN=test $(UV) run pytest -q

test-ui: ## Frontend tests: clicks every filter, tab, button and the voice input (fake backend)
	cd frontend && npm test

test-all: test test-ui ## Both test suites

test-live: ## Live: real Jira + the running server - every number must match its click-through list (needs `make up`)
	LIVE=1 $(UV) run pytest -q tests/live/test_live_invariants.py

test-e2e: ## Live: real Chrome clicks everything on every tab and checks each number against its list (needs `make up`)
	cd frontend && npm run e2e

test-agent: ## Live: ask the agent ~50 PM questions, check tools and numbers against Jira (slow, uses the LLM)
	LIVE=1 $(UV) run pytest -q tests/live/test_agent_questions.py

share: ## Share from this Mac via a Cloudflare quick tunnel, Sign in with Google only (.env.public); prints the link
	scripts/share_local.sh start

unshare: ## Stop sharing from this Mac
	scripts/share_local.sh stop

keep-up: ## Keep the shared app up: watchdog every minute + keep this Mac awake on power (launchd, survives reboots)
	scripts/keep_up.sh install

keep-down: ## Stop the watchdog and let the Mac sleep again (sharing itself keeps running until make unshare)
	scripts/keep_up.sh uninstall
