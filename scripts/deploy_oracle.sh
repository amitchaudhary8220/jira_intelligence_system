#!/usr/bin/env bash
# Deploy Jira Pulse to an Ubuntu VM (Oracle Cloud Always Free: Ampere A1 or the 1 GB AMD micro), with login in front.
# The login is chosen by AUTH_MODE in .env.production:
#   proxy       "Sign in with Google" on the VM: Caddy (HTTPS, port 80/443) + oauth2-proxy (compose profile "google")
#   cloudflare  Cloudflare Tunnel + Access, no open ports (compose profile "cloudflare"; needs a domain on Cloudflare)
#
#   make deploy HOST=ubuntu@<vm-ip>          (or: scripts/deploy_oracle.sh ubuntu@<vm-ip>)
#
# What it does, over SSH:
#   1. installs Docker on the VM (first run only)
#   2. copies the project (no secrets, no node_modules, no local chat history)
#   3. copies .env.production -> .env and team.yaml (secrets travel only over SSH)
#   4. builds and starts the app + the login gateway, then waits until the app is healthy
# Small VMs (under 2 GB RAM, e.g. VM.Standard.E2.1.Micro): the image is built HERE on your Mac for the VM's CPU and
# copied over SSH (building the React UI on 1 GB runs out of memory), and a 2 GB swap file is added once.
# Force either way with BUILD_ON=local or BUILD_ON=vm.
set -euo pipefail

HOST="${1:?usage: scripts/deploy_oracle.sh ubuntu@<vm-ip>}"
DIR="${REMOTE_DIR:-jira-pulse}"
cd "$(dirname "$0")/.."

# ---- refuse to deploy a half-filled config
[ -f .env.production ] || { echo "Missing .env.production - copy .env.production.example and fill it in"; exit 1; }
env_has() { grep -Eq "^$1=.+" .env.production; }
env_val() { grep -E "^$1=" .env.production | tail -1 | cut -d= -f2-; }
missing=()
for k in JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN INCEPTION_API_KEY ALLOWED_EMAIL_DOMAINS; do env_has "$k" || missing+=("$k"); done
grep -Eq '^APP_ENV=production' .env.production || missing+=("APP_ENV=production")
case "$(env_val AUTH_MODE)" in
  proxy)      PROFILE=google
              for k in PUBLIC_HOST GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET OAUTH2_COOKIE_SECRET; do env_has "$k" || missing+=("$k"); done ;;
  cloudflare) PROFILE=cloudflare
              for k in CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD CLOUDFLARE_TUNNEL_TOKEN; do env_has "$k" || missing+=("$k"); done ;;
  *)          missing+=("AUTH_MODE=proxy (Google sign-in) or AUTH_MODE=cloudflare") ;;
esac
if [ ${#missing[@]} -gt 0 ]; then echo "Fill these in .env.production: ${missing[*]}"; exit 1; fi
if [ "$PROFILE" = google ]; then
  # the certificate only works once the DNS record points at this VM
  PUBLIC_HOST="$(env_val PUBLIC_HOST)"; VM_IP="${HOST#*@}"
  DNS_IP="$(dig +short "$PUBLIC_HOST" A | tail -1)"
  if [ "$DNS_IP" != "$VM_IP" ]; then
    echo "DNS: $PUBLIC_HOST points to '${DNS_IP:-nothing}', not $VM_IP. Add an A record $PUBLIC_HOST -> $VM_IP first."
    [ "${SKIP_DNS_CHECK:-}" = 1 ] || exit 1
  fi
fi
[ -f team.yaml ] || { echo "Missing team.yaml - run 'make roster' first"; exit 1; }

echo "==> 1/4 Docker on $HOST"
ssh "$HOST" 'command -v apt-get >/dev/null || { echo "This script expects an Ubuntu VM (apt-get not found)"; exit 1; }
command -v docker >/dev/null || {
  sudo apt-get update -qq &&
  sudo apt-get install -y -qq docker.io docker-compose-v2 rsync &&
  sudo usermod -aG docker "$USER"; }'

# what kind of machine is it?
read -r VM_ARCH VM_MEM_MB < <(ssh "$HOST" 'echo "$(uname -m) $(awk "/MemTotal/ {print int(\$2/1024)}" /proc/meminfo)"')
case "$VM_ARCH" in x86_64) PLATFORM=linux/amd64 ;; aarch64|arm64) PLATFORM=linux/arm64 ;; *) echo "Unknown CPU: $VM_ARCH"; exit 1 ;; esac
BUILD_ON="${BUILD_ON:-$([ "$VM_MEM_MB" -lt 2000 ] && echo local || echo vm)}"
echo "    VM: $VM_ARCH, ${VM_MEM_MB} MB RAM -> building on: $BUILD_ON"

if [ "$VM_MEM_MB" -lt 2000 ]; then
  # a little breathing room for memory spikes (2 GB swap file, created once, kept across reboots)
  ssh "$HOST" 'swapon --show | grep -q . || {
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap -q /swapfile && sudo swapon /swapfile &&
    echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null && echo "    added 2 GB swap"; }'
fi

if [ "$PROFILE" = google ]; then
  # Oracle's Ubuntu image blocks everything but SSH in its own firewall: let HTTP/HTTPS in (Caddy), and keep it after reboots
  ssh "$HOST" 'for p in 80 443; do sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null ||
    sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport $p -j ACCEPT; done
    command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 || true'
fi

echo "==> 2/4 copying the project"
ssh "$HOST" "mkdir -p ~/$DIR"
rsync -az --delete \
  --exclude .git --exclude .venv --exclude node_modules --exclude frontend/dist --exclude frontend/e2e/screenshots \
  --exclude logs --exclude data --exclude '__pycache__' --exclude .pytest_cache \
  --exclude '.env' --exclude '.env.*' --exclude team.yaml --exclude team.yaml.bak --exclude team.suggested.yaml \
  ./ "$HOST:~/$DIR/"

echo "==> 3/4 secrets + roster"
scp -q .env.production "$HOST:~/$DIR/.env"
scp -q team.yaml "$HOST:~/$DIR/team.yaml"
ssh "$HOST" "chmod 600 ~/$DIR/.env"

echo "==> 4/4 build + start (first build takes a few minutes)"
# sg docker: works in the same SSH session right after usermod added the docker group
if [ "$BUILD_ON" = local ]; then
  docker buildx build --platform "$PLATFORM" -t jira-pulse:latest --load .
  # Copy as a FILE with rsync (resumes if the connection drops), then load it on the VM. Streaming
  # `docker save | ssh docker load` timed out on a home connection while the small VM unpacked.
  IMG="$(mktemp -d)/jira-pulse.tar.gz"
  docker save jira-pulse:latest | gzip -6 > "$IMG"
  echo "    copying the image to the VM ($(du -h "$IMG" | cut -f1))..."
  for try in 1 2 3 4 5 6 7 8; do
    rsync -a --partial --timeout=60 -e "ssh -o ConnectTimeout=15 -o ServerAliveInterval=15" "$IMG" "$HOST:/tmp/jira-pulse.tar.gz" && break
    echo "    connection dropped (try $try) - resuming"; sleep 5
    [ "$try" = 8 ] && { echo "Upload kept failing."; exit 1; }
  done
  ssh -o ServerAliveInterval=20 "$HOST" "gunzip -c /tmp/jira-pulse.tar.gz | sg docker -c 'docker load' && rm -f /tmp/jira-pulse.tar.gz"
  ssh "$HOST" "cd ~/$DIR && sg docker -c 'docker compose --profile $PROFILE up -d --no-build --remove-orphans'"
else
  ssh "$HOST" "cd ~/$DIR && sg docker -c 'docker compose --profile $PROFILE up -d --build --remove-orphans'"
fi
# Nightly backup of the app's own database (reasons + chats): cron at 21:00 UTC (02:30 IST), last 14 copies kept.
ssh "$HOST" "( crontab -l 2>/dev/null | grep -v 'deploy/backup_db.sh' ; echo '0 21 * * * bash \$HOME/$DIR/deploy/backup_db.sh >> \$HOME/jira-pulse-backup.log 2>&1' ) | crontab -"
for i in $(seq 1 60); do
  if ssh "$HOST" "curl -sf -m 5 http://127.0.0.1:8010/api/health >/dev/null"; then
    if [ "$PROFILE" = google ]; then
      echo "App is healthy. Checking HTTPS (the first certificate can take a minute)..."
      for j in $(seq 1 24); do
        code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "https://$PUBLIC_HOST/" || true)
        case "$code" in 302|303|403) echo "HTTPS works; signed-out visitors go to Google sign-in (HTTP $code)."; break ;; esac
        sleep 5
      done
      ssh "$HOST" "cd ~/$DIR && sg docker -c 'docker compose --profile google logs --tail 5 caddy oauth2-proxy'"
      echo "Done. Open https://$PUBLIC_HOST"
    else
      echo "App is healthy. Tunnel status:"
      ssh "$HOST" "cd ~/$DIR && sg docker -c 'docker compose --profile cloudflare logs --tail 5 cloudflared'"
      echo "Done. Open your Cloudflare hostname (e.g. https://pulse.<your-domain>)."
    fi
    exit 0
  fi
  sleep 5
done
echo "The app did not become healthy in 5 minutes. Logs:"
ssh "$HOST" "cd ~/$DIR && sg docker -c 'docker compose logs --tail 60 jira-pulse'"
exit 1
