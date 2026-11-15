# Jira Pulse - production image: builds the React app, then runs FastAPI (one process: caches live in memory).
#   docker compose up -d --build        (settings come from .env - see .env.example "Production")

# ---- 1. build the React app ----
# --platform=$BUILDPLATFORM: the UI is plain JS/CSS, so build it natively even when the image is for another CPU
FROM --platform=$BUILDPLATFORM node:22.22.2-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. Python runtime ----
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy APP_ENV=production
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev
COPY --from=web /app/frontend/dist ./frontend/dist
RUN useradd --create-home --uid 10001 app && mkdir -p /app/data && chown -R app /app
USER app
EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/api/health', timeout=8)" || exit 1
# --proxy-headers: trust X-Forwarded-* from the SSO proxy / load balancer in front (HTTPS is terminated there)
CMD [".venv/bin/uvicorn", "jira_pm.server:app", "--host", "0.0.0.0", "--port", "8010", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]
