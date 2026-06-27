# Docker Deployment & GHCR CI/CD — Design Spec

**Date**: 2026-06-27
**Status**: Approved
**Repository**: git@github.com:BestNathan/nession.git

## Summary

Package the nession control-plane (`nession-server`) and web UI (`web/`) into a single Docker image, built and published to GitHub Container Registry (GHCR) via GitHub Actions.

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Image structure | Combined control-plane + webui | Single `docker run` starts both; fits single-operator model |
| Agent Dockerfile | Not included | Agent runs directly on tmux hosts; out of scope |
| TLS termination | nginx in the container | Rust server stays TLS-free internally; simpler config |
| CI trigger | Push to `main` + version tags (`v*`) | PRs only validate; tags get semver labels |
| Runtime base | `debian:bookworm-slim` | glibc compat for rusqlite bundled; easy debugging |
| Process management | Shell entrypoint + `exec` | Simple, no extra deps; server as PID 1 for clean signals |

## Architecture

```
┌─────────────────────────────── Container ───────────────────────────────┐
│                                                                         │
│  ┌─────────────────┐         ┌──────────────────────────────────────┐  │
│  │  nginx (port 80/443)      │  nession-server (port 127.0.0.1:8443)│  │
│  │  - static /     │  proxy  │  - WebSocket server                  │  │
│  │  - /ws  ────────┼────────►│  - SQLite DB (/data/server.db)       │  │
│  │  - /api ────────┼────────►│  - Agent registry                    │  │
│  │  - /health      │         │                                      │  │
│  │  - TLS terminate│         │                                      │  │
│  └─────────────────┘         └──────────────────────────────────────┘  │
│        ▲                                      ▲                        │
│        │ 80/443                               │ /data (volume)         │
└────────┼──────────────────────────────────────┼────────────────────────┘
         │                                      │
    host :80, :443                     Docker volume: nession-data
```

## File Inventory

New files to add to the repository:

```
nession/
├── Dockerfile                          # Multi-stage build
├── .dockerignore                       # Exclude target/, node_modules/, .git/
├── deploy/
│   ├── entrypoint.sh                   # Config generation + process startup
│   ├── nginx.conf.template             # nginx config with env var placeholders
│   ├── docker-compose.yml              # One-command deployment
│   └── .env.example                    # Documented env vars
└── .github/
    └── workflows/
        └── docker-publish.yml          # GHCR build + push
```

## Dockerfile

Three-stage build:

### Stage 1: `web-builder`

- **Base**: `node:20-alpine`
- **Purpose**: Build the React SPA
- **Steps**:
  1. `WORKDIR /build`
  2. `COPY web/package.json web/package-lock.json ./`
  3. `npm ci` (reproducible install)
  4. `COPY web/ .`
  5. `npm run build` → produces `/build/dist/`

### Stage 2: `server-builder`

- **Base**: `rust:1.80-bookworm`
- **Purpose**: Compile `nession-server`
- **Steps**:
  1. `WORKDIR /build`
  2. `COPY Cargo.toml Cargo.lock ./`
  3. `COPY crates/ crates/`
  4. `RUN cargo build --release --bin nession-server`
  5. Output: `/build/target/release/nession-server`
- **Cache optimization**: Copy `Cargo.toml` + `Cargo.lock` first, then `crates/` — dependencies cache separately from source changes

### Stage 3: `runtime`

- **Base**: `debian:bookworm-slim`
- **Purpose**: Minimal runtime image
- **Steps**:
  1. `apt-get update && apt-get install -y --no-install-recommends nginx ca-certificates curl`
  2. `rm -rf /var/lib/apt/lists/*`
  3. `COPY --from=server-builder /build/target/release/nession-server /usr/local/bin/nession-server`
  4. `COPY --from=web-builder /build/dist /usr/share/nginx/html`
  5. `COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template`
  6. `COPY deploy/entrypoint.sh /entrypoint.sh && chmod +x /entrypoint.sh`
  7. `RUN mkdir -p /data && chown www-data:www-data /data`
  8. `EXPOSE 80 443`
  9. `HEALTHCHECK CMD curl -f http://localhost/health || exit 1`
  10. `ENTRYPOINT ["/entrypoint.sh"]`

### `.dockerignore`

```
target/
web/node_modules/
web/dist/
.git/
.github/
docs/
*.md
deploy/
```

## Entrypoint Script (`deploy/entrypoint.sh`)

```sh
#!/bin/sh
set -e

# Generate nginx config from template using envsubst
envsubst '${LISTEN_PORT} ${TLS_CERT_PATH} ${TLS_KEY_PATH} ${SERVER_BACKEND}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

# Validate nginx config
nginx -t

# Start nginx in background
nginx -g 'daemon off;' &

# Exec nession-server as PID 1 (receives SIGTERM from docker stop)
exec /usr/local/bin/nession-server
```

## nginx Configuration Template (`deploy/nginx.conf.template`)

```nginx
# Upstream: Rust server
upstream nession_backend {
    server ${SERVER_BACKEND:-127.0.0.1:8443};
}

# HTTP server (always enabled)
server {
    listen ${LISTEN_PORT:-80};
    server_name _;

    # Redirect to HTTPS if TLS is configured
    # (replaced at container start if TLS_CERT_PATH is set)

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
        proxy_read_timeout 86400s;   # 24h for terminal sessions
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
        try_files $uri $uri/ /index.html;  # SPA fallback
    }
}

# HTTPS server (only if TLS is configured)
# The entrypoint script conditionally appends this block
# when TLS_CERT_PATH and TLS_KEY_PATH are set.
```

**TLS conditional logic** (handled in `entrypoint.sh`):
- If `TLS_CERT_PATH` + `TLS_KEY_PATH` are both non-empty:
  - Append a `listen 443 ssl` server block
  - Add `ssl_certificate`, `ssl_certificate_key` directives
  - Add HTTP→HTTPS redirect in the port 80 block
- If not set:
  - Only the port 80 block is active

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_PORT` | `80` | HTTP port nginx listens on |
| `TLS_CERT_PATH` | *(empty)* | Path to TLS certificate file (enables HTTPS if set) |
| `TLS_KEY_PATH` | *(empty)* | Path to TLS private key file |
| `SERVER_BACKEND` | `127.0.0.1:8443` | Address the Rust server binds to internally |
| `NESION_AUTH_TOKEN` | *(required)* | Auth token for agent/client connections |
| `NESION_DB_PATH` | `/data/server.db` | SQLite database file path |
| `NESION_LISTEN_ADDRESS` | `127.0.0.1:8443` | Must match `SERVER_BACKEND` |

## GitHub Actions Workflow (`.github/workflows/docker-publish.yml`)

### Triggers

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
```

### Tag Strategy

| Event | GHCR Tags |
|-------|-----------|
| Push to `main` | `latest` |
| Push tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `latest` |
| PR #42 | `pr-42` |

### Job Definition

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        if: github.event_name != 'pull_request'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository_owner }}/nession
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest,enable={{is_default_branch}}

      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Key Points

- **`GITHUB_TOKEN`** is auto-provided by GitHub Actions — no secret needed
- **`ghcr.io/${{ github.repository_owner }}/nession`** resolves to `ghcr.io/bestnathan/nession` (must be lowercase)
- **Multi-platform**: `linux/amd64` + `linux/arm64` via buildx + QEMU
- **Docker layer caching**: `type=gha` uses GitHub Actions cache, speeds up repeat builds
- **PR builds**: `push: false` means PRs validate the Dockerfile without publishing

## docker-compose.yml (`deploy/docker-compose.yml`)

```yaml
services:
  nession:
    image: ghcr.io/bestnathan/nession:latest
    ports:
      - "${HTTP_PORT:-80}:80"
      - "${HTTPS_PORT:-443}:443"
    environment:
      - NESION_AUTH_TOKEN=${NESION_AUTH_TOKEN:?Auth token required}
      - TLS_CERT_PATH=${TLS_CERT_PATH:-}
      - TLS_KEY_PATH=${TLS_KEY_PATH:-}
      - SERVER_BACKEND=${SERVER_BACKEND:-127.0.0.1:8443}
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

### `deploy/.env.example`

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

# Optional: certs directory (mounted read-only)
CERTS_DIR=./certs
```

## Usage

### Build locally

```bash
docker build -t nession:local .
docker run -p 8080:80 -e NESION_AUTH_TOKEN=secret nession:local
```

### Deploy with docker-compose

```bash
cd deploy
cp .env.example .env
# Edit .env with your auth token
docker compose up -d
```

### With TLS

```bash
mkdir -p certs
cp /path/to/cert.pem certs/tls.crt
cp /path/to/key.pem certs/tls.key
# Set TLS_CERT_PATH=/certs/tls.crt and TLS_KEY_PATH=/certs/tls.key in .env
docker compose up -d
```

## Out of Scope

- Agent Dockerfile (runs directly on tmux hosts)
- Kubernetes manifests (Helm chart, kustomize)
- Multi-arch beyond amd64 + arm64
- Automated TLS certificate provisioning (Let's Encrypt / cert-manager)
- Horizontal scaling / HA (single-instance per architecture doc)
