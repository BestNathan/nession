# Nession

[Pages](https://bestnathan.github.io/nession/) · [Vision](VISION.md) · [Principles](PRINCIPLE.md) · [Product](PRODUCT.md)

## Overview

**Nession is an intelligent workspace for continuous work across devices, environments, and compute nodes.** It connects remote machines, persistent terminal Sessions, and the tools surrounding them so users can return to their work without rebuilding the environment each time.

The existing **0.x** product centers on remote terminal control. The **1.x** product is under development, extending that foundation toward a **Session-first, Workspace-centered** experience with contextual capabilities. See [Product](PRODUCT.md) for the product-generation definitions.

## Telemetry

### Repository health

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/BestNathan/nession/metrics/repo-metrics-dark.svg?sanitize=true&v=2">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/BestNathan/nession/metrics/repo-metrics-light.svg?sanitize=true&v=2">
  <img alt="Nession repository telemetry: repository health, quality and engineering activity" src="https://raw.githubusercontent.com/BestNathan/nession/metrics/repo-metrics-light.svg?sanitize=true&v=2">
</picture>

<sub>Published from the <code>metrics</code> branch · <a href="https://raw.githubusercontent.com/BestNathan/nession/metrics/metrics.json">repository metrics (JSON)</a></sub>

### Agent workflow activity

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/BestNathan/nession/metrics/agent-metrics-dark.svg?sanitize=true&v=1">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/BestNathan/nession/metrics/agent-metrics-light.svg?sanitize=true&v=1">
  <img alt="Nession agent workflow telemetry: activity, outcomes, token usage and execution costs" src="https://raw.githubusercontent.com/BestNathan/nession/metrics/agent-metrics-light.svg?sanitize=true&v=1">
</picture>

<sub>Observed Agent workflow activity · <a href="https://raw.githubusercontent.com/BestNathan/nession/metrics/agent-metrics.json">Agent workflow metrics (JSON)</a></sub>

## Architecture

Nession's current runtime uses a **Server / Agent / Client** architecture. The Server coordinates identity, discovery and Session metadata; each Agent owns execution on its node and connects to local tmux Sessions. Web and CLI clients attach through the Server relay or directly to an Agent where P2P is available.

```text
                       Web (React / xterm.js)   CLI
                                |                 |
                                +--------+--------+
                                         |
                                   WebSocket
                                         |
                                         v
                              Nession Server
                         (registry / auth / SQLite)
                                         |
                             coordination / relay
                                         |
                                         v
                              Nession Agent(s)
                              (node execution)
                                         |
                                nession-tmux
                                         |
                                         v
                            tmux-backed Sessions

     Web / CLI ---------------- P2P WebSocket ------------> Agent
```

**Connection paths**

- **Relay:** Client → Server → Agent, when the Server is reachable.
- **P2P:** Client → Agent, when a direct endpoint is reachable and authorized.
- **Session execution:** Agent → tmux; client attachment and node connectivity are distinct from Session lifetime.

The longer-term product model introduces logical Workspaces, Workspace Locations and context-aware capabilities around Sessions; this target is described in [Product](PRODUCT.md) and [Product & UI Design](docs/design/README.md), not represented as fully shipped by the diagram above.

## Features

- **Central registry** — agents register on connect and heartbeat; the server persists agents and sessions in SQLite.
- **Web workspace** — React + xterm.js UI for Sessions, terminals and contextual capabilities; the broader Workspace product model is still evolving.
- **Interactive CLI** — list Agents and Sessions, create/kill Sessions and attach to a terminal.
- **Two transports** — relay through the server or P2P directly to the agent.
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
# custom install directory and subset of binaries (add --version for a pinned release)
./scripts/install.sh --dir ~/.local/bin --bins nession

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
nession-server                 # reads ./config.toml if present, else uses the 127.0.0.1:8080 fallback
```

With no `config.toml`, the standalone `nession-server` executable listens on `127.0.0.1:8080` with no auth. The Web development server instead proxies `/ws` and `/api` to port `19090` by default. To use the Web UI locally, configure the Server to listen on `19090` as below (or override `NESSION_DEV_WS_PROXY` in the Web dev environment). Do not expose the no-auth default to untrusted networks.

To customize, create a `config.toml`:

```toml
listen_address = "127.0.0.1:19090"
tls_cert_path = ""             # set both to enable wss://
tls_key_path = ""
auth_token = "your-secret-token"
heartbeat_interval_secs = 10
heartbeat_timeout_secs = 30
# db_path defaults to ~/.nession/server/server.db (or under NESSION_HOME)
```

### 2. Start an agent (needs tmux)

Copy and edit `agent-config.toml`:

```toml
agent_id = "agent-local"
server_url = "ws://127.0.0.1:19090/ws"
auth_token = "your-secret-token"  # outbound Server credential
# agent_token = "..."              # optional inbound override; generated beside
#                                  # this config (mode 0600) when omitted
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

`--config` selects the file the daemon loads. An **explicit** `--config` that is
missing or unreadable fails before startup; omitting it uses the target's
documented default (`~/.nession/agent-config.toml` /
`~/.nession/server-config.toml`, or `$NESSION_HOME`). A `server start` with no
config file uses `127.0.0.1:8080`; the standalone `nession-server` binary has
the same no-file fallback. The two daemons' defaults are separate from the
remote CLI target below.

### Logs and diagnostics

Both daemons write rolling local logs; no Server connection, credential or
running daemon is needed to read them:

```bash
nession agent logs                 # last 100 runtime records
nession server logs -n 500         # last 500 after filtering
nession agent logs -f              # tail, then follow appends (Ctrl-C stops only the reader)
nession server logs --since 1h --level warn
nession agent logs --target nession_agent::ws -n 50
nession agent logs --path          # resolved file locations, no content
nession agent logs --source startup   # bounded startup diagnostics
nession agent logs --source service   # systemd user journal / launchd capture (Agent)
```

The root is `$NESSION_HOME` (default `~/.nession`):
`agent/logs/nession-agent[.YYYY-MM-DD[.HH]]`, `server/logs/nession-server…`,
plus `agent|server/logs/startup/` for startup diagnostics. `--source service`
is Agent-only; the Server has no managed service in this CLI. Filters are
applied before `--tail`, and `--level`/`--target` apply only to runtime
records (raw startup/service text is never assigned a severity or target).
`-n 0` prints nothing. `--since` accepts a duration (`30m`, `1h30m`, `2d`) or
an RFC3339 timestamp with an offset; `--until` is RFC3339 and ends a
follow at the cutoff. A selected archive release (`nession +<version> …`)
reads its own home; a release that predates these commands is read directly by
the Current CLI. See
[docs/architecture/cli-logs.md](docs/architecture/cli-logs.md) for selection,
retention and platform details.

### Configuration files

The same selection is available to the config commands, so `config set` edits
the file a daemon was actually started with:

```bash
nession config agent init --config /srv/nession/agent.toml
nession config agent show --config /srv/nession/agent.toml
nession config agent set --config /srv/nession/agent.toml logging.level debug
nession config server set --config /srv/nession/server.toml terminal_web_font_size 13.5
```

`init`, `show` and `set` without `--config` use the target's default path.
Every serializable `AgentConfig`/`ServerConfig` field is editable with typed
validation; dotted keys address nested values (`logging.level`,
`logging.rotation`, `logging.retention_days`), and `advertise_addresses` takes a
JSON array of URLs. Unknown keys and invalid values are rejected without
writing, and edits preserve comments and unrelated keys. `show` masks
`auth_token`/`agent_token`, and written files are private (0600 on Unix).
`auth_token` and `agent_token` are different endpoint secrets: the first is the
Agent → Server credential (and the Server's inbound token), the second is the
Agent's own durable inbound token for P2P and embedded MCP. Leave `agent_token`
unset and the Agent provisions one beside its config on first start; it is
reused across restarts and never placed in a URL or log.

A fresh `nession config server init` is deliberately a **local no-auth** file:
`listen_address` is the loopback fallback (`127.0.0.1:8080`) and `auth_token`
is empty. That is safe only for this machine, and it matches what
`nession server start` uses when no config file exists. Accepting clients from
other machines is an explicit opt-in: set a credential and a reachable
listener together.

```bash
nession config server set auth_token <token>
nession config server set listen_address 0.0.0.0:19090
```

`init --force` writes the same safe default again; it never restores an
all-interface listener with a blank token. An operator-authored config is
loaded as written — the CLI does not rewrite it during startup.

### 3. Use it

**CLI** (targets the central Server through a persistent connection profile,
`--server-url` / `--auth-token`, or `NESSION_SERVER_URL` / `NESSION_AUTH_TOKEN`).
For the `19090` example above, set the target and use the same auth token
configured for the Server:

```bash
export NESSION_SERVER_URL=ws://127.0.0.1:19090
# Set NESSION_AUTH_TOKEN to the Server auth token securely in your shell.
nession agents list
nession sessions list [--agent-id <id>]
nession sessions create --agent-id <id> --name dev
nession sessions attach --session-id <agent_id>:<session_name> [--mode p2p|relay]
nession sessions kill   --session-id <agent_id>:<session_name> [--force]
```

#### Connection profiles

For repeatable operation, store a named **client connection profile** instead
of re-entering infrastructure configuration (#4682). A profile is an
installation-owned endpoint plus its credential policy — not an Agent,
Project, Session or release, and it needs no running local daemon:

```bash
nession profile add home --server-url ws://127.0.0.1:19090
nession profile credential set home --stdin   # pipe the Server token; never argv
nession profile list
nession profile current
nession profile use home
nession profile test home
nession --profile home sessions list
nession profile import-agent                  # endpoint-only Agent import
nession profile set home --server-url ws://192.0.2.10:19090
nession profile remove home --force
```

The first profile added (or imported) becomes current; later adds never change
the selection. `profile credential set` reads a masked prompt or one line of
stdin (`--stdin`), stores the secret in the OS credential store when available
or a private 0600 file fallback otherwise, and binds it to the profile's
endpoint. Re-running it rotates; `profile credential clear` deletes it;
`profile set home --no-auth` marks an explicit no-auth Server. Secrets never
appear in the profile TOML, argv for credential commands, output, logs or
errors. `list`/`current`/`show` are offline and masked; `test` makes a bounded
real connection and reports sanitized success/denial/refusal.

With no profile, no explicit flag and no environment target, the first remote
command imports the endpoint from a valid, explicitly configured Agent
`server_url` (endpoint only — daemon credentials are never copied) and asks you
to set a client credential. An absent Agent config keeps the legacy loopback
with a setup hint; an invalid one is an actionable error. The full grammar,
resolution matrix and credential boundary live in
[docs/architecture/cli-connection-profiles.md](docs/architecture/cli-connection-profiles.md).

`--auth-token` is convenient for a one-off command, but a value passed as a
flag is visible in shell history and in process listings while the command
runs. For repeatable operation, use a profile credential or set
`NESSION_AUTH_TOKEN` in the environment. The daemon config's `auth_token` is a
**different credential direction**: it is the Agent → Server credential (and
the Server's inbound auth), written by
`nession config agent set auth_token <token>`. Remote commands never borrow a
daemon config or credential (#2267, evolved by #4682): the independent client
store may supply an endpoint and a client credential of its own, but an Agent's
configured secrets are never copied, derived or sent.

Remote commands resolve one target/credential pair, in this order:
`--server-url`, `--profile`, `NESSION_SERVER_URL`, the legacy
`NENSION_SERVER_URL` alias, `NESSION_PROFILE`, the persisted current profile,
the one-time Agent endpoint bootstrap, then `ws://127.0.0.1:8080` with an empty
token. `--server-url` and `--profile` together are rejected as ambiguous; a
named profile overrides ambient URL variables. An ambient token applies to the
legacy flag/env/default flows, or when its accompanying ambient URL is the same
canonical endpoint — never silently to a selected profile. The canonical
`NESSION_*` names win over the legacy `NENSION_*` aliases (kept so an existing
environment keeps working). Agent and Server daemon configs do not override
this CLI target. A background `nession agent start` never passes its resolved
token to the child process as an argument; the credential goes over a private
pipe instead.

The global flags apply only where they have an effect. `agents` and `sessions`
read `--server-url`/`--auth-token`/`--profile` as the remote context;
`profile add`/`set` read `--server-url` as the endpoint to store; `agent start`
and `agent restart` read `--server-url`/`--auth-token` as overrides for the
Agent daemon's outbound target (never `--profile`). `server`, `config`,
`update`, `version`, agent stop/status/service commands and the profile
management leaves have no use for the irrelevant flags and **reject** them
rather than silently ignoring them:

```bash
# Rejected: --server-url does not configure the Server's listener
nession server start --server-url ws://127.0.0.1:19090
# Rejected: daemon lifecycle never runs profile resolution
nession agent start --profile home
```

**Web UI** — see [Web dashboard](#web-dashboard) below.

---

## Web dashboard

```bash
cd web
npm ci
npm run dev        # Vite dev server :13000, proxies /ws and /api → :19090
```

Open http://localhost:13000, connect to the server, then browse agents and open terminals. For production, `npm run build` emits static assets to `web/dist/` (served by nginx in the Docker/K8s images).

The generated local Server profile (`nession config server init`) already lists
the Vite dev (`:13000`) and preview (`:4173`) origins in `allowed_origins`.
A Server started from a hand-written config — or the no-file fallback — refuses
browser WebSocket upgrades until the page's exact origin is listed there; CLI
and Agent clients present no `Origin` and need no entry. See
[protocol ownership](docs/architecture/protocol.md#effective-exposure-and-browser-origin-policy).

### Terminal presentation and scrollback

The terminal uses a fixed logical column count per Session (96 by default; configurable for a release). Web/App adapt font size and visible rows to each viewport without reflowing the Session into a different column count. See [terminal sizing](docs/design/terminal/terminal-sizing.md) for the current contract.

A Session's history is xterm's own scrollback — the wheel stays in the browser
and never enters tmux copy mode — and attaching (or reloading) fills it from
the Session, so context is available when the terminal mounts. That holds on
the default attach transport; `attach_mode = "plain"` is a fallback, and
[docs/design/terminal/scrollback-bootstrap.md](docs/design/terminal/scrollback-bootstrap.md)
states exactly what it does and does not give you.

---

## Project layout

```
nession/
├── crates/                 # Rust workspace (11 crates; see Cargo.toml)
│   ├── nession-common/     # shared configuration, paths and utilities
│   ├── nession-protocol/   # versioned wire contracts
│   ├── nession-protocol-codegen/ # TypeScript / JSON Schema generation
│   ├── nession-runtime/    # reusable runtime primitives
│   ├── nession-client/     # reusable client library
│   ├── nession-tmux/       # independent typed tmux / Control Mode client
│   ├── nession-server/     # broker, registry, SQLite, WebSocket + TLS
│   ├── nession-agent/      # per-node tmux, server and P2P lifecycle
│   ├── nession-cli/        # interactive CLI and process lifecycle
│   ├── nession-git/        # Git capability / protocol
│   └── nession-claude-code/ # Claude Code capability / protocol
├── web/                    # authenticated React / Vite / xterm.js product UI
├── pages/                  # independent public project observatory
├── docs/                   # architecture, product and design documentation
├── deploy/                 # docker-compose + entrypoints + nginx template
├── design/                 # design tokens + executable UI contracts (`design/generated/` is codegen output)
├── e2e/                    # shared Runner, Cases, Scenarios, Playwright regressions
├── gates/                  # invariant checks and suite catalog
├── scripts/                # tooling, acceptance, metrics, gitops writer, install.sh
├── Dockerfile.*            # server/agent/ui build variants
└── Cargo.toml              # workspace root (version lives here, and in web/package.json)
```

Deployment desired state — the kustomize base, per-environment overlays and the
ArgoCD app-of-apps — lives on the **`gitops` orphan branch**, not on `main`
(issue #592). See "Deploying to Kubernetes" in the root `CLAUDE.md`.

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

See [`AGENTS.md`](AGENTS.md) and the [development Skill](.claude/skills/nession-development/SKILL.md) for current contributor, worktree, Gate and PR rules.

> **Never develop in the root `main` checkout.** Use an isolated worktree and feature branch.

---

## Docker

```bash
# full builds (Rust + UI)
docker build -f Dockerfile.server -t nession-server .
docker build -f Dockerfile.agent  -t nession-agent .
```

Published multi-arch images (on version bumps via CI):

- `ghcr.io/bestnathan/nession:server-<version>`
- `ghcr.io/bestnathan/nession:agent-<version>`
- `ghcr.io/bestnathan/nession:mcp-<version>` (standalone MCP host, independently deployed)
- `ghcr.io/bestnathan/nession:ui-<web-version>`

`deploy/docker-compose.yml` wires server + agent + UI together for local runs.
`deploy/docker-compose.mcp.yml` is the independent standalone MCP sample; it
has its own lifecycle and is not part of that stack. See
[docs/architecture/mcp.md](docs/architecture/mcp.md#standalone-oci-image-3791)
for configuration, auth, ingress and rollback.

---

## Kubernetes

The Kubernetes Kustomize base, environment overlays and ArgoCD desired state
are maintained on the [`gitops` branch](https://github.com/BestNathan/nession/tree/gitops),
**not** at `k8s/` in `main` or `staging`. Check out that branch and follow
its current overlay paths before applying manifests.

The deployment nginx listener serves the UI and `/health` endpoint
(container port `10080`), proxying `/ws` to the configured Rust WebSocket
listener. Rust listener ports and external service ports are configuration,
not fixed Kubernetes constants. CI publishes multi-arch images and promotes
versioned image tags through the gitops workflow on version changes
(see the current release workflows under `.github/workflows/`).

---

## Releases

Pushing a version bump (`Cargo.toml` / `web/package.json`) to `main` triggers CI to:

1. Lint + test (Rust and web).
2. Build & push multi-arch Docker images.
3. Build native binaries for Linux (amd64/arm64) and macOS (Intel/Apple Silicon).
4. Publish a GitHub Release `v<version>` with tarballs named `nession-<version>-<os>-<arch>.tar.gz`, each containing `nession`, `nession-agent`, and `nession-server`.

The [installer](#one-line-installer-linux--macos) consumes these release assets.
