# Docker Deployment & GHCR CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Docker image running nginx + nession-server, published to GHCR via GitHub Actions.

**Architecture:** Multi-stage Dockerfile (node → rust → debian-slim). nginx reverse-proxies `/ws` and `/api` to the Rust server and serves the React SPA from `/`. Entrypoint generates nginx config and `config.toml` from env vars at container start. GitHub Actions builds on push to `main`/tags, pushes to GHCR.

**Tech Stack:** Docker multi-stage build, nginx (reverse proxy + static), debian:bookworm-slim, GitHub Actions (docker/build-push-action), GHCR

**Spec:** `docs/superpowers/specs/2026-06-27-docker-deployment-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `Dockerfile` | Multi-stage build: web → server → runtime |
| `.dockerignore` | Exclude target/, node_modules/, .git/, docs/ from build context |
| `deploy/nginx.conf.template` | nginx config with `${LISTEN_PORT}`, `${SERVER_BACKEND}` placeholders |
| `deploy/entrypoint.sh` | Generate nginx config + config.toml from env vars, start nginx, exec server |
| `deploy/docker-compose.yml` | One-command deployment with volumes and health check |
| `deploy/.env.example` | Documented env vars for docker-compose |
| `.github/workflows/docker-publish.yml` | Build on PR, build+push on main/tags to GHCR |

---

### Task 1: Create `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
target/
web/node_modules/
web/dist/
.git/
docs/
*.md
```

This excludes Rust build artifacts, node_modules, pre-built web dist, git history, and docs from the Docker build context — keeping it small and preventing stale artifacts from being copied.

- [ ] **Step 2: Verify file exists**

Run: `cat .dockerignore`
Expected: the 6 lines above.

- [ ] **Step 3: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore for Docker build context"
```

---

### Task 2: Create nginx config template

**Files:**
- Create: `deploy/nginx.conf.template`

- [ ] **Step 1: Create `deploy/` directory**

```bash
mkdir -p deploy
```

- [ ] **Step 2: Create `deploy/nginx.conf.template`**

```nginx
# Upstream: Rust server (SERVER_BACKEND is set by entrypoint.sh with default)
upstream nession_backend {
    server ${SERVER_BACKEND};
}

# HTTP server (always enabled)
server {
    listen ${LISTEN_PORT};
    server_name _;

    # Health check endpoint
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    # WebSocket proxy
    location /ws {
        proxy_pass http://nession_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # API proxy
    location /api {
        proxy_pass http://nession_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Static files (web UI)
    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
```

Key points:
- `${LISTEN_PORT}` and `${SERVER_BACKEND}` are substituted by `envsubst` in the entrypoint
- `$http_upgrade`, `$host`, etc. are native nginx variables — NOT substituted by envsubst because the entrypoint uses `envsubst '${LISTEN_PORT} ${SERVER_BACKEND}'` which only replaces those two variables
- `proxy_read_timeout 86400s` = 24 hours, needed for long-lived terminal WebSocket connections
- `try_files ... /index.html` enables SPA client-side routing

- [ ] **Step 3: Validate template syntax (optional, requires nginx locally)**

Run: `nginx -t -c "$(pwd)/deploy/nginx.conf.template"` only if you have nginx installed locally. This will fail because the template has `${...}` placeholders — that's expected. If you want to validate the non-placeholder parts, substitute manually:

```bash
LISTEN_PORT=80 SERVER_BACKEND=127.0.0.1:8443 envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' \
  < deploy/nginx.conf.template > /tmp/test-nginx.conf
nginx -t -c /tmp/test-nginx.conf 2>&1 || true
```

Expected: warnings about upstream not reachable are fine; the key is no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add deploy/nginx.conf.template
git commit -m "feat: add nginx config template for reverse proxy + static serving"
```

---

### Task 3: Create entrypoint script

**Files:**
- Create: `deploy/entrypoint.sh`

- [ ] **Step 1: Create `deploy/entrypoint.sh`**

```sh
#!/bin/sh
set -e

# --- Defaults (envsubst requires variables to be set) ---
LISTEN_PORT="${LISTEN_PORT:-80}"
SERVER_BACKEND="${SERVER_BACKEND:-127.0.0.1:8443}"
NESION_LISTEN_ADDRESS="${NESION_LISTEN_ADDRESS:-127.0.0.1:8443}"
NESION_DB_PATH="${NESION_DB_PATH:-/data/server.db}"
export LISTEN_PORT SERVER_BACKEND

# --- Generate nginx config from template ---
envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

# --- If TLS certs are provided, enable HTTPS ---
if [ -n "$TLS_CERT_PATH" ] && [ -n "$TLS_KEY_PATH" ]; then
  # Add HTTP→HTTPS redirect to the port 80 server block
  sed -i 's|server_name _;|server_name _;\n    return 301 https://\$host\$request_uri;|' \
    /etc/nginx/conf.d/default.conf

  # Append HTTPS server block
  cat >> /etc/nginx/conf.d/default.conf <<NGINX
server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location /ws {
        proxy_pass http://${SERVER_BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /api {
        proxy_pass http://${SERVER_BACKEND};
        proxy_set_header Host \$host;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX
fi

# --- Generate nession-server config.toml ---
cat > /etc/nession/config.toml <<TOML
listen_address = "${NESION_LISTEN_ADDRESS}"
auth_token = "${NESION_AUTH_TOKEN}"
db_path = "${NESION_DB_PATH}"
tls_cert_path = ""
tls_key_path = ""
heartbeat_timeout_secs = 30
TOML

# --- Validate nginx config ---
nginx -t

# --- Start nginx in background ---
nginx -g 'daemon off;' &

# --- Exec nession-server as PID 1 ---
# Receives SIGTERM directly from `docker stop`
exec /usr/local/bin/nession-server
```

Key points:
- `envsubst '${LISTEN_PORT} ${SERVER_BACKEND}'` — the argument list restricts substitution to only these two variables, so nginx's `$http_upgrade`, `$host`, etc. pass through untouched
- TLS block uses a heredoc with escaped `\$` for nginx variables that must remain literal
- `config.toml` is generated into `/etc/nession/` (the WORKDIR set by Dockerfile), so `nession-server` finds it via its `load_config()` which reads `config.toml` from cwd
- `exec nession-server` replaces the shell process — the Rust binary becomes PID 1 and receives SIGTERM/SIGINT directly

- [ ] **Step 2: Make it executable**

```bash
chmod +x deploy/entrypoint.sh
```

- [ ] **Step 3: Test envsubst logic locally (optional)**

If you have `envsubst` installed (usually via `gettext` package):

```bash
export LISTEN_PORT=80 SERVER_BACKEND=127.0.0.1:8443
envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' < deploy/nginx.conf.template
```

Expected: `${LISTEN_PORT}` → `80`, `${SERVER_BACKEND}` → `127.0.0.1:8443`, `$http_upgrade` unchanged.

- [ ] **Step 4: Commit**

```bash
git add deploy/entrypoint.sh
git commit -m "feat: add entrypoint script for nginx + nession-server startup"
```

---

### Task 4: Create Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# ---- Stage 1: Build web UI ----
FROM node:20-alpine AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ---- Stage 2: Build Rust server ----
FROM rust:1.80-bookworm AS server-builder
WORKDIR /build
# Cache dependency compilation: copy manifests first, then source
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release --bin nession-server

# ---- Stage 3: Runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx ca-certificates curl gettext-base && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled binary
COPY --from=server-builder /build/target/release/nession-server /usr/local/bin/nession-server

# Copy web UI static assets
COPY --from=web-builder /build/dist /usr/share/nginx/html

# Copy nginx template and entrypoint
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data and config directories
RUN mkdir -p /data /etc/nession && chown www-data:www-data /data

# Remove default nginx site to avoid port conflicts
RUN rm -f /etc/nginx/sites-enabled/default

WORKDIR /etc/nession
EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
```

Key points:
- **Cache optimization**: `Cargo.toml` + `Cargo.lock` are copied before `crates/` — if only source changes (not dependencies), Docker reuses the cached `cargo build` layer for dependency compilation
- **`rm -f /etc/nginx/sites-enabled/default`**: Debian's nginx package ships a default site listening on port 80, which would conflict with our template
- **`HEALTHCHECK`**: Uses curl to hit the nginx `/health` endpoint; the container is marked unhealthy if nginx can't serve
- **`chown www-data:www-data /data`**: nginx runs as www-data; the server may need to read/write the DB here

- [ ] **Step 2: Build the Docker image**

```bash
docker build -t nession:local .
```

Expected: Build completes successfully. The Rust compilation step takes the longest (5-15 min on first build). Final output shows the runtime image size (should be ~80-120MB).

- [ ] **Step 3: Run and verify health check**

```bash
docker run -d --name nession-test \
  -p 8080:80 \
  -e NESION_AUTH_TOKEN=test-secret \
  nession:local

# Wait for startup
sleep 5

# Check health endpoint
curl -sf http://localhost:8080/health && echo "OK" || echo "FAIL"

# Check logs
docker logs nession-test

# Cleanup
docker rm -f nession-test
```

Expected:
- `curl` returns `ok`
- Logs show nginx starting and nession-server starting
- If nession-server crashes (e.g., can't bind to port), logs will show the error

- [ ] **Step 4: Verify static files are served**

```bash
docker run -d --name nession-test -p 8080:80 -e NESION_AUTH_TOKEN=test nession:local
sleep 3
curl -s http://localhost:8080/ | head -5
docker rm -f nession-test
```

Expected: HTML output from the React SPA (should contain `<!DOCTYPE html>` and `<script` tags).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile for combined server+webui image"
```

---

### Task 5: Create docker-compose.yml and .env.example

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/.env.example`

- [ ] **Step 1: Create `deploy/docker-compose.yml`**

```yaml
services:
  nession:
    image: ghcr.io/bestnathan/nession:latest
    build:
      context: ..
      dockerfile: Dockerfile
    ports:
      - "${HTTP_PORT:-80}:80"
      - "${HTTPS_PORT:-443}:443"
    environment:
      - NESION_AUTH_TOKEN=${NESION_AUTH_TOKEN:?Auth token required}
      - TLS_CERT_PATH=${TLS_CERT_PATH:-}
      - TLS_KEY_PATH=${TLS_KEY_PATH:-}
      - SERVER_BACKEND=${SERVER_BACKEND:-127.0.0.1:8443}
      - NESION_LISTEN_ADDRESS=${SERVER_BACKEND:-127.0.0.1:8443}
    volumes:
      - nession-data:/data
      - ${CERTS_DIR:-./certs}:/certs:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped

volumes:
  nession-data:
```

Note: `build.context: ..` points to the repo root (since docker-compose.yml is in `deploy/`). This allows `docker compose up --build` from the deploy directory.

- [ ] **Step 2: Create `deploy/.env.example`**

```bash
# Required
NESION_AUTH_TOKEN=change-me-to-a-strong-random-token

# Optional: TLS (uncomment to enable HTTPS)
# TLS_CERT_PATH=/certs/tls.crt
# TLS_KEY_PATH=/certs/tls.key
# HTTPS_PORT=443

# Optional: ports
HTTP_PORT=80

# Optional: server backend (must match NESION_LISTEN_ADDRESS)
SERVER_BACKEND=127.0.0.1:8443

# Optional: certs directory (mounted read-only into container)
CERTS_DIR=./certs
```

- [ ] **Step 3: Test docker-compose locally**

```bash
cd deploy
cp .env.example .env
# Edit .env if needed (default auth token works for local testing)
docker compose up -d
sleep 5
curl -sf http://localhost/health && echo "OK" || echo "FAIL"
docker compose down
cd ..
```

Expected: Container starts, health check returns `ok`, `docker compose down` stops cleanly.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml deploy/.env.example
git commit -m "feat: add docker-compose.yml and .env.example for easy deployment"
```

---

### Task 6: Create GitHub Actions workflow

**Files:**
- Create: `.github/workflows/docker-publish.yml`

- [ ] **Step 1: Create `.github/workflows/` directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Create `.github/workflows/docker-publish.yml`**

```yaml
name: Docker

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository_owner }}/nession

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up QEMU (for multi-platform builds)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata (tags, labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Key points:
- **`docker/setup-qemu-action@v3`**: Required for cross-compilation to arm64 on GitHub's amd64 runners
- **`if: github.event_name != 'pull_request'`**: PRs build but never push (no GHCR auth needed)
- **`docker/metadata-action`** automatically generates tags based on the event:
  - Push to `main` → `main` tag + `latest`
  - Tag `v1.2.3` → `1.2.3`, `1.2`, `1`, `latest`
  - PR #42 → `pr-42`
- **`cache-from: type=gha`**: Uses GitHub Actions cache for Docker layers — subsequent builds are much faster
- **`IMAGE_NAME` uses `github.repository_owner`** (not `github.repository`) to avoid the `owner/repo` slash — GHCR requires lowercase `owner/nession`

- [ ] **Step 3: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-publish.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci: add GitHub Actions workflow for Docker build and GHCR push"
```

---

### Task 7: End-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Push to a feature branch and verify PR build**

```bash
git checkout -b ci/test-docker
git push origin ci/test-docker
```

Then open a PR. Check the Actions tab — the `Docker` workflow should run and build successfully (but not push).

- [ ] **Step 2: Merge to main and verify GHCR push**

After merging, check the Actions tab — the workflow should build and push to `ghcr.io/<your-username>/nession:latest`.

Verify the package appears at: `https://github.com/<your-username>?tab=packages`

- [ ] **Step 3: Pull from GHCR and run**

```bash
docker pull ghcr.io/<your-username>/nession:latest
docker run -d --name nession-ghcr \
  -p 8080:80 \
  -e NESION_AUTH_TOKEN=test \
  ghcr.io/<your-username>/nession:latest
sleep 5
curl -sf http://localhost:8080/health && echo "GHCR image OK" || echo "FAIL"
docker rm -f nession-ghcr
```

- [ ] **Step 4: Tag a version and verify semver tags**

```bash
git tag v0.1.0
git push origin v0.1.0
```

Check Actions — should produce tags: `0.1.0`, `0.1`, `0`, `latest` on GHCR.

- [ ] **Step 5: Clean up test branch (if still exists)**

```bash
git branch -d ci/test-docker 2>/dev/null || true
```
