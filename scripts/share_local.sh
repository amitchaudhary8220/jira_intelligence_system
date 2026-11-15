#!/usr/bin/env bash
# Share Jira Pulse from THIS Mac through a free Cloudflare quick tunnel (a random https://<words>.trycloudflare.com link).
#
#   scripts/share_local.sh start     build + start the app (production mode) with a login, and the tunnel; print the link
#   scripts/share_local.sh url       print the current link
#   scripts/share_local.sh stop      stop sharing
#
# Login: "Sign in with Google" only (oauth2-proxy), and only ALLOWED_EMAIL_DOMAINS accounts get in. Without the Google
# client in .env.public the script refuses to share. Google needs the redirect URI <address>/oauth2/callback (printed).
# Fixed address: with PUBLIC_URL=https://jira-pulse.<subdomain>.workers.dev in .env.public, a Cloudflare Worker
# (deploy/worker) forwards that address to the tunnel, and is re-pointed here whenever the tunnel link changes.
# Containers run with restart=unless-stopped: they keep running after you close the editor, while Docker Desktop runs
# and the Mac is awake. The tunnel (and its link) is kept across `start`s; it changes only when the tunnel restarts.
# Separate from the dev server on :8010 (no login, never exposed). Own chat history volume.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=jp-public-app AUTH=jp-public-auth TUNNEL=jp-public-tunnel NET=jp-public
FRONT=jp-public-front            # network alias the tunnel talks to: oauth2-proxy (never the app directly)
CLOUDFLARED=cloudflare/cloudflared:2026.10.7
OAUTH2_PROXY=quay.io/oauth2-proxy/oauth2-proxy:v7.12.0
WRANGLER=wrangler@4.156.0
WORKER_STATE=data/.share-worker-target   # the tunnel link the Worker currently forwards to

url() { docker logs "$TUNNEL" 2>&1 | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1; }
# Is the tunnel really carrying traffic? (After the Mac sleeps, Cloudflare drops quick tunnels: the container keeps
# running but only logs "Tunnel not found".) oauth2-proxy answers /ping with 200 without sign-in.
tunnel_ok() { local l; l="$(url)"; [ -n "$l" ] && [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$l/ping" || true)" = 200 ]; }
site_ok() { local s; s="$(public PUBLIC_URL)"; s="${s:-$(url)}"; [ -n "$s" ] && [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$s/ping" || true)" = 200 ]; }
# .env + .env.public read with python-dotenv (what the app uses): `docker run --env-file` would keep quotes in KEY="value"
merged_env() { uv run --quiet python -c 'from dotenv import dotenv_values as d
for k, v in {**d(".env"), **d(".env.public")}.items(): print(f"{k}={v}")'; }
public() { uv run --quiet python -c "from dotenv import dotenv_values as d; print(d('.env.public').get('$1') or '')"; }

# One start at a time: `make share` and the every-minute watchdog must not rebuild the containers simultaneously.
take_lock() {
  mkdir -p data
  for _ in $(seq 1 120); do
    mkdir data/.share.lock 2>/dev/null && { trap 'rmdir data/.share.lock 2>/dev/null' EXIT; return 0; }
    [ -n "$(find data/.share.lock -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir data/.share.lock 2>/dev/null   # stale
    sleep 2
  done
  echo "Another start is still running (data/.share.lock). Try again in a minute."; exit 1
}

case "${1:-start}" in
  start)
    take_lock
    # a watchdog repair that waited for someone else's start: if the site is fine now, there is nothing to repair
    if [ "${REPAIR:-}" = 1 ] && site_ok; then echo "ok"; exit 0; fi
    [ -f .env ] && [ -f .env.public ] || { echo "Needs .env (Jira + LLM keys) and .env.public (login)"; exit 1; }
    [ -n "$(public ALLOWED_EMAIL_DOMAINS)" ] || { echo "Set ALLOWED_EMAIL_DOMAINS in .env.public"; exit 1; }
    for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET OAUTH2_COOKIE_SECRET; do
      [ -n "$(public $k)" ] || { echo "Fill $k in .env.public (Sign in with Google). Not sharing without a login."; exit 1; }
    done

    # Build the app image. A watchdog repair never rebuilds (it must work even when the internet blips, and the code
    # didn't change); a normal start falls back to the existing image if the build fails (e.g. no network).
    have_image() { docker image inspect jira-pulse:latest >/dev/null 2>&1; }
    if [ "${REPAIR:-}" = 1 ] && have_image; then
      :
    elif ! docker build -q -t jira-pulse:latest . >/dev/null; then
      have_image || { echo "Build failed and there is no earlier image to fall back to."; exit 1; }
      echo "Build failed (network?) - using the existing app image."
    fi
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    docker rm -f "$APP" "$AUTH" >/dev/null 2>&1 || true

    # 1. the app: AUTH_MODE=proxy, trusts the email oauth2-proxy passes. Only oauth2-proxy can reach it (not the tunnel).
    docker run -d --name "$APP" --network "$NET" --restart unless-stopped \
      --env-file <(merged_env) -e APP_ENV=production -e AUTH_MODE=proxy -e LOGOUT_URL=/oauth2/sign_out \
      -v "$PWD/team.yaml:/app/team.yaml:ro" -v jp-public-data:/app/data \
      -p 127.0.0.1:8020:8010 jira-pulse:latest >/dev/null
    for _ in $(seq 1 30); do curl -sf -m 3 http://127.0.0.1:8020/api/health >/dev/null && break; sleep 2; done
    curl -sf -m 3 http://127.0.0.1:8020/api/health >/dev/null || { docker logs --tail 30 "$APP"; exit 1; }

    # 2. the tunnel (kept if already running, so the link - and Google's redirect URI - stay the same)
    if [ "$(docker inspect -f '{{.State.Running}}' "$TUNNEL" 2>/dev/null)" != true ] ||
       ! docker inspect -f '{{join .Args " "}}' "$TUNNEL" | grep -q "http://$FRONT:8010" ||
       { docker logs --tail 5 "$TUNNEL" 2>&1 | grep -q "Tunnel not found"; }; then
      docker rm -f "$TUNNEL" >/dev/null 2>&1 || true
      docker run -d --name "$TUNNEL" --network "$NET" --restart unless-stopped "$CLOUDFLARED" \
        tunnel --no-autoupdate --url "http://$FRONT:8010" >/dev/null
    fi
    for _ in $(seq 1 30); do [ -n "$(url)" ] && break; sleep 2; done
    LINK="$(url)"; [ -n "$LINK" ] || { echo "The tunnel gave no link:"; docker logs --tail 20 "$TUNNEL"; exit 1; }

    # 2b. the fixed address (optional): point the Worker at the tunnel's current link
    PUBLIC_URL="$(public PUBLIC_URL)"; SITE="${PUBLIC_URL:-$LINK}"
    if [ -n "$PUBLIC_URL" ] && [ "$(cat "$WORKER_STATE" 2>/dev/null)" != "$LINK" ]; then
      echo "Pointing $PUBLIC_URL at the new tunnel link..."
      (cd deploy/worker && npx --yes "$WRANGLER" deploy --var "TARGET:$LINK" >/dev/null 2>&1) ||
        { echo "Worker deploy failed - run: cd deploy/worker && npx $WRANGLER login"; exit 1; }
      mkdir -p data && echo "$LINK" > "$WORKER_STATE"
    fi

    # 3. oauth2-proxy in front of the app (it strips identity headers the browser sends, then sets
    #    X-Forwarded-Email from the verified Google session)
    docker run -d --name "$AUTH" --network "$NET" --network-alias "$FRONT" --restart unless-stopped \
      -e OAUTH2_PROXY_PROVIDER=google \
      -e OAUTH2_PROXY_CLIENT_ID="$(public GOOGLE_CLIENT_ID)" \
      -e OAUTH2_PROXY_CLIENT_SECRET="$(public GOOGLE_CLIENT_SECRET)" \
      -e OAUTH2_PROXY_COOKIE_SECRET="$(public OAUTH2_COOKIE_SECRET)" \
      -e OAUTH2_PROXY_EMAIL_DOMAINS="$(public ALLOWED_EMAIL_DOMAINS)" \
      -e OAUTH2_PROXY_REDIRECT_URL="$SITE/oauth2/callback" \
      -e OAUTH2_PROXY_WHITELIST_DOMAINS="${SITE#https://}" \
      -e OAUTH2_PROXY_UPSTREAMS="http://$APP:8010" \
      -e OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:8010 \
      -e OAUTH2_PROXY_REVERSE_PROXY=true -e OAUTH2_PROXY_COOKIE_SECURE=true -e OAUTH2_PROXY_COOKIE_EXPIRE=12h \
      -e OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=false -e OAUTH2_PROXY_PROMPT=select_account \
      -v "$PWD/deploy/oauth2-templates:/templates:ro" -e OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR=/templates \
      -e OAUTH2_PROXY_PASS_USER_HEADERS=true -e OAUTH2_PROXY_FLUSH_INTERVAL=100ms \
      "$OAUTH2_PROXY" >/dev/null
    for _ in $(seq 1 20); do docker exec "$APP" python -c "import urllib.request; urllib.request.urlopen('http://$AUTH:8010/ping', timeout=2)" 2>/dev/null && break; sleep 1; done

    echo "Shared at: $SITE"
    echo "Login: Sign in with Google (@$(public ALLOWED_EMAIL_DOMAINS) accounts only)."
    echo "Google Cloud Console > Credentials > your OAuth client > Authorized redirect URIs must contain:"
    echo "  $SITE/oauth2/callback"
    ;;
  check)   # used by the watchdog every minute: repair only when the public address doesn't answer
    [ -d data/.share.lock ] && { echo "ok"; exit 0; }       # a (re)start is running right now: don't pile on
    if site_ok; then echo "ok"; exit 0; fi
    echo "$(date '+%F %T') not reachable - repairing"
    tunnel_ok || docker rm -f "$TUNNEL" >/dev/null 2>&1 || true     # a dead quick tunnel: start a fresh one
    REPAIR=1 exec "$0" start ;;
  url)  p="$(public PUBLIC_URL)"; echo "${p:-$(url)}" ;;
  tunnel-url) echo "$(url)" ;;
  stop) docker rm -f "$APP" "$AUTH" "$TUNNEL" >/dev/null 2>&1 || true; echo "Stopped sharing." ;;
  *)    echo "usage: $0 start|url|stop"; exit 1 ;;
esac
