# Nession

> Distributed tmux session management — attach to any node's terminal from your browser or CLI.

**AI path:** [CLAUDE.md](CLAUDE.md)

Nession lets you run and control `tmux` sessions across many machines from one place. A central **server** tracks every **agent** (one per node), and you attach to a live session either from a **web dashboard** or the **CLI** — over a relay through the server, or peer-to-peer straight to the agent for lower latency.

```
Browser / CLI
     │  ws:// (or wss://)
     ▼
nession-server ── SQLite ── registry (agents, sessions)
     │  ws://              ▲
     ▼                      │ heartbeat + session sync
nession-agent ── tmux ─────┘
     │
     ▼
tmux sessions (per-node)
```

**Connection modes**
- **Relay** — Browser/CLI → Server → Agent. Works anywhere the server is reachable.
- **P2P** — Browser/CLI → Agent directly, using the agent address returned by the attach response. Lower latency.

---

## Features

- **Central registry** — agents register on connect and heartbeat; the server persists agents and sessions in SQLite.
- **Web dashboard** — React + xterm.js UI to browse agents, create/kill sessions, and open a live terminal (Catppuccin Mocha theme).
- **Interactive CLI** — attach to a session in a raw terminal, list agents/sessions, create and kill sessions.
- **Two transports** — relay through the server or P2P directly to an agent.
- **Container-ready** — multi-arch (amd64/arm64) Docker images and Kubernetes manifests (kustomize base + staging/production overlays).
- **Prebuilt binaries** — released for Linux and macOS on every version bump.

---

## Install

### One-line installer (Linux / macOS)

Downloads the release binaries matching your OS and architecture:

```bash
curl -fsSL https://github.com/BestNathan/nession/releases/latest/download/install.sh | sh
```

Options:

```bash
# specific version, custom dir, subset of binaries
./scripts/install.sh --version 0.3.8 --dir ~/.local/bin --bins nession

#   -v, --version <ver>   version to install (default: latest)
#   -d, --dir <path>      install dir (default: /usr/local/bin → ~/.local/bin fallback)
#   -b, --bins <list>     comma-separated: nession,nession-agent,nession-server
```

Environment overrides: `NESSION_VERSION`, `NESSION_INSTALL_DIR`, `NESSION_BINS`, and `GITHUB_TOKEN` (to avoid API rate limits).

### From source

Requires **Rust 1.96+** (pinned in `rust-toolchain.toml`) and **Node.js 20+** for the web UI.

```bash
git clone https://github.com/BestNathan/nession.git
cd nession
cargo build --release          # binaries in target/release/
```

Produces three binaries: `nession` (CLI), `nession-agent`, `nession-server`.

---

## Quick start

### 1. Start the server

```bash
nession-server                 # reads ./config.toml if present, else uses defaults
```

Without a config it listens on `127.0.0.1:8080` with no auth and stores its DB under `~/.nession/`. To customize, create a `config.toml`:

```toml
listen_address = "0.0.0.0:8080"
tls_cert_path = ""             # set both to enable wss://
tls_key_path = ""
auth_token = "your-secret-token"
heartbeat_interval_secs = 10
heartbeat_timeout_secs = 30
# db_path defaults to ~/.nession/server/nession.db
```

### 2. Start an agent (needs tmux)

Copy and edit `agent-config.toml`:

```toml
agent_id = "agent-local"
server_url = "ws://127.0.0.1:8080/ws"
auth_token = "your-secret-token"
listen_address = "0.0.0.0:8080"   # internal WS server for P2P
heartbeat_interval_secs = 10
session_poll_interval_secs = 5
# advertise_address / connect_url — optional, for how clients reach this agent (P2P)
```

```bash
nession agent start --config agent-config.toml --foreground
```

The `nession` CLI can also manage the agent/server lifecycle as background processes:

```bash
nession agent start          # background, writes a PID file under ~/.nession/
nession agent status
nession agent stop
nession server start|status|stop
```

### 3. Use it

**CLI** (targets the central server; override with `--server-url` / `--auth-token` or `NENSION_SERVER_URL` / `NENSION_AUTH_TOKEN`):

```bash
nession agents list
nession sessions list [--agent-id <id>]
nession sessions create --agent-id <id> --name dev [--width 120 --height 40]
nession sessions attach --session-id <agent_id>:<session_name> [--mode p2p|relay]
nession sessions kill   --session-id <agent_id>:<session_name> [--force]
```

**Web UI** — see [Web dashboard](#web-dashboard) below.

---

## Web dashboard

```bash
cd web
npm install
npm run dev        # Vite dev server on http://localhost:13000, proxies /ws → :19090
```

Open http://localhost:13000, connect to the server, then browse agents and open terminals. For production, `npm run build` emits static assets to `web/dist/` (served by nginx in the Docker/K8s images).

### Terminal Zoom Controls

The web terminal supports zoom controls for better readability on different devices:

- **Auto-scaling:** Terminal automatically scales based on device type (mobile: 60%, tablet: 80%, desktop: 100%)
- **Manual zoom:** Use the +/- buttons in the terminal toolbar to adjust zoom level (30%-300%)
- **Reset:** Click the reset button to restore default zoom for your device
- **Scrolling:** When terminal size exceeds viewport, use scrollbars or touch gestures to navigate

Zoom level is session-specific and resets on page refresh.

---

## Project layout

```
nession/
├── crates/                 # Rust workspace
│   ├── nession-common/     # shared protocol, config, paths, errors
│   ├── nession-server/     # broker, registry, SQLite persistence, WS server + TLS
│   ├── nession-agent/      # per-node agent: tmux management, server connection, P2P server
│   └── nession-cli/        # CLI: attach, list, create/kill, lifecycle
├── web/                    # React + Vite + TypeScript + shadcn/ui + xterm.js
├── deploy/                 # docker-compose + entrypoints + nginx template
├── k8s/                    # kustomize base + staging/production overlays
├── scripts/install.sh      # release-binary installer
├── Dockerfile.*            # server/agent/ui build variants
└── Cargo.toml              # workspace root (v0.3.8)
```

---

## Development

```bash
# Rust
cargo build
cargo test
cargo fmt --all -- --check
cargo clippy -- -D warnings          # must pass with 0 warnings; #[allow(clippy::*)] is forbidden

# Web (in web/)
npm run dev        # dev server :13000
npm run build      # production build → dist/
npm run lint       # ESLint (--max-warnings 0; eslint-disable is forbidden)
npm test           # Vitest
npx tsc --noEmit   # type check
```

See [`CLAUDE.md`](CLAUDE.md) for the full contributor workflow, coding conventions, and branch/PR rules.

> **Never develop on `main`.** Create a feature branch: `git checkout -b feat/<slug>`.

---

## Docker

```bash
# full builds (Rust + UI)
docker build -f Dockerfile.server -t nession-server .
docker build -f Dockerfile.agent  -t nession-agent  .
```

Published multi-arch images (on version bumps via CI):

- `ghcr.io/bestnathan/nession:server-<version>`
- `ghcr.io/bestnathan/nession:agent-<version>`
- `ghcr.io/bestnathan/nession:ui-<web-version>`

`deploy/docker-compose.yml` wires server + agent + UI together for local runs.

---

## Kubernetes

Kustomize overlays under `k8s/`:

```bash
kubectl apply -k k8s/overlays/production     # or overlays/staging
```

| Service        | Port  | Purpose                          |
|----------------|-------|----------------------------------|
| nession-server | 19090 | WebSocket (agents + clients)     |
| nession-server | 10080 | HTTP (health, UI)                |
| nession-agent  | 19090 | WebSocket (P2P terminal)         |
| nession-agent  | 10080 | HTTP (health)                    |
| nession-ui     | 80    | nginx serving `web/dist/`        |

CI publishes multi-arch images and updates the production overlay's image tags automatically on every version change (see `.github/workflows/release.yml`).

---

## Releases

Pushing a version bump (`Cargo.toml` / `web/package.json`) to `main` triggers CI to:

1. Lint + test (Rust and web).
2. Build & push multi-arch Docker images.
3. Build native binaries for Linux (amd64/arm64) and macOS (Intel/Apple Silicon).
4. Publish a GitHub Release `v<version>` with tarballs named `nession-<version>-<os>-<arch>.tar.gz`, each containing `nession`, `nession-agent`, and `nession-server`.

The [installer](#one-line-installer-linux--macos) consumes these release assets.
