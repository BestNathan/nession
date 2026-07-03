# Nession — Distributed tmux Agent

## 1. Project Structure

```
nession/
├── crates/                   # Rust workspace (4 crates)
│   ├── nession-common/       # Shared types, protocol, config, error definitions
│   │   └── src/
│   │       ├── protocol.rs   # WebSocket message types & serialization
│   │       ├── config.rs     # Agent/server config structs
│   │       ├── error.rs      # Error types
│   │       ├── paths.rs      # Config/data directory paths
│   │       └── lib.rs
│   ├── nession-server/       # Central server — broker, registry, DB
│   │   └── src/
│   │       ├── main.rs
│   │       ├── broker.rs     # Message routing between clients & agents
│   │       ├── server/       # WebSocket server + TLS
│   │       ├── registry/     # Agent registration & heartbeat tracking
│   │       └── db/           # SQLite persistence (agents, sessions)
│   ├── nession-agent/        # Per-node agent — manages tmux sessions
│   │   └── src/
│   │       ├── main.rs
│   │       ├── config.rs
│   │       ├── server/       # Internal WebSocket server for P2P connections
│   │       ├── connection/   # Server connection & reconnection logic
│   │       ├── sync/         # Session state sync with server
│   │       └── tmux/         # tmux process management
│   └── nession-cli/          # CLI client for terminal attach
│       └── src/
│           ├── main.rs
│           ├── commands/     # Subcommands (attach, list, etc.)
│           ├── client/       # WebSocket client logic
│           └── terminal/     # Raw terminal I/O
│
├── web/                      # React frontend (Vite + TypeScript)
│   └── src/
│       ├── App.tsx           # Root: connection state → LoginPage or Dashboard
│       ├── main.tsx          # Entry point + Sonner Toaster
│       ├── index.css         # Tailwind v4 + shadcn/ui dark theme
│       ├── types.ts           # Shared TypeScript types
│       ├── lib/utils.ts      # cn() helper (clsx + tailwind-merge)
│       ├── services/
│       │   └── websocket.ts  # WebSocketService singleton (connection, auth, events)
│       └── components/
│           ├── ui/           # shadcn/ui primitives (13 components, auto-generated)
│           ├── LoginPage.tsx         # Connection form (Card + Input + Button + Badge)
│           ├── Dashboard.tsx         # Main view: agent cards grid + session list
│           ├── AgentCard.tsx         # Agent status card (Badge + relative time)
│           ├── SessionList.tsx       # Session rows (ScrollArea + Attach/Kill buttons)
│           ├── CreateSessionDialog.tsx  # Modal: create tmux session (Dialog + Select)
│           ├── KillConfirmDialog.tsx    # Modal: confirm kill (Dialog destructive)
│           ├── Terminal.tsx          # xterm.js 5.5 (P2P + relay, Catppuccin theme)
│           ├── TerminalToolbar.tsx   # Collapsible quick-commands + text input
│           └── quickCommands.ts      # Preset commands + localStorage persistence
│
├── deploy/                   # Docker runtime scripts & configs
│   ├── docker-compose.yml
│   ├── entrypoint-server.sh
│   ├── entrypoint-agent.sh
│   └── nginx.conf.template
│
├── k8s/                      # Kubernetes manifests (kustomize)
│   ├── kustomization.yaml
│   ├── namespace.yaml, secret.yaml, pvc.yaml
│   ├── deployment-{server,agent,ui}.yaml
│   ├── service-{server,agent,ui}.yaml
│   └── ingress-{server,agent,ui}.yaml
│
├── Dockerfile.server         # Multi-stage: Rust build + nginx + UI
├── Dockerfile.agent          # Multi-stage: Rust build + nginx + UI + tmux
├── Dockerfile.ui.prebuilt    # nginx serving pre-built web/dist/
├── Dockerfile.{server,agent}.prebuilt  # Pre-built binary + UI variants
│
├── Cargo.toml                # Workspace root (4 crates, shared dependencies)
├── agent-config.toml         # Default agent config
├── web/package.json          # React deps: shadcn/ui, xterm 5.5, sonner, lucide-react
└── docs/
    └── superpowers/
        ├── specs/            # Design specs
        └── plans/            # Implementation plans
```

### Architecture Flow

```
Browser (Web UI)
  │ ws://server/ws
  ▼
nession-server ─── SQLite ─── registry (agents, sessions)
  │ ws://agent/ws        ▲
  ▼                       │ heartbeat + session sync
nession-agent ─── tmux ──┘
  │
  ▼
tmux sessions (per-node)
```

**Connection modes:**
- **Relay:** Browser → Server → Agent (terminal data proxied through server)
- **P2P:** Browser → Agent directly (lower latency, agent_address from attach response)

### Key Design Decisions

- **Web UI theming:** shadcn/ui default dark theme (Zinc/neutral palette). Terminal keeps Catppuccin Mocha independent of UI theme.
- **WebSocket singleton:** `WebSocketService` is a global singleton for the browser session — request/response correlation, event pub/sub, auto-reconnect.
- **CSS:** Tailwind v4 via `@tailwindcss/vite`. Only one CSS file (`index.css`). All component styles are Tailwind utilities.
- **shadcn components:** Individual primitives in `components/ui/`, added via CLI, version-controlled.
- **ESLint:** `eslint-disable` comments are forbidden. All lint violations must be fixed properly (type narrowing, destructuring deps, extracting non-component exports). `--max-warnings 0` is enforced.

---

## 2. Development Workflow

**⚠ CRITICAL: Never develop on `main`. Always create a feature branch first.**

```bash
git checkout -b feat/<slug>   # or use EnterWorktree for isolated workspace
```

Before committing, verify you are NOT on `main`:
```bash
git branch --show-current     # must NOT be "main"
```

If already on `main` with changes, migrate them:
```bash
git stash
git checkout -b feat/<slug>
git stash pop
```

### Prerequisites

- Rust 1.88+ with `cargo`
- Node.js 20+ with `npm`
- tmux (for agent — not needed for server/client dev)
- Docker (for builds), kubectl + kustomize (for k8s deploys)

### Local Development

**Rust:** standard cargo workflow from workspace root.
```bash
cargo build                    # Build all crates
cargo test                     # Run all tests
cargo run -p nession-server    # Start server (port 19090 ws, 10080 http)
cargo run -p nession-agent     # Start agent (needs config)
```

**Rust linting:**
```bash
cargo fmt --all -- --check      # Formatting check
cargo clippy -- -D warnings     # Lint — MUST pass with 0 warnings
```
- `#[allow(clippy::*)]` is **forbidden**. Every clippy lint must be fixed properly, not silenced.
- `clippy.toml` contains lint thresholds (`cognitive-complexity-threshold = 25`, `too-many-lines-threshold = 150`).
- Workspace lints in `Cargo.toml` (`[workspace.lints.clippy]`) apply to all crates via `[lints] workspace = true`.

**Web UI:** work inside `web/`.
```bash
cd web
npm install            # Install deps (needed once, after any package.json change)
npm run dev            # Vite dev server on :13000, proxies /ws → localhost:19090
npm run build          # Production build → web/dist/
npm run lint           # ESLint check
npm test                # Vitest (unit + component tests)
npm run coverage        # Vitest with coverage (≥ 80% threshold)
npx tsc --noEmit       # TypeScript check (no output files)
```

Adding a shadcn component:
```bash
cd web && npx shadcn@latest add <component-name> --yes
```
Components land in `web/src/components/ui/` and are committed to git.

### Docker Builds

Multi-stage builds. To build locally:

```bash
# Full build (Rust + UI)
docker build -f Dockerfile.server -t nession-server .
docker build -f Dockerfile.agent -t nession-agent .

# Prebuilt variants (binary/web already compiled)
docker build -f Dockerfile.server.prebuilt -t nession-server .
docker build -f Dockerfile.ui.prebuilt -t nession-ui .
```

Prebuilt variants expect `--build-arg` or multi-stage `COPY --from` sources.

### CI/CD (GitHub Actions)

Triggered by push to `main` or PR. See `.github/workflows/docker-publish.yml`.

**Image naming:** `ghcr.io/bestnathan/nession-{server,agent,ui}` with two tags:
- `sha-<short-sha>` — immutable, per-commit
- Branch name (`main`, `feat-*`) — moving tag

**Build matrix:** `linux/amd64`, `linux/arm64` (multi-arch).

### Deploying to Kubernetes

Uses kustomize overlays. From repo root:
```bash
kubectl apply -k k8s/
```

Service ports:
| Service | Port | Purpose |
|---------|------|---------|
| nession-server | 19090 | WebSocket (agents + clients) |
| nession-server | 10080 | HTTP (health, UI) |
| nession-agent | 19090 | WebSocket (P2P terminal) |
| nession-agent | 10080 | HTTP (health) |
| nession-ui | 80 | nginx serving web/dist/ |

### Release Flow

1. Develop on feature branch (worktree preferred, see below)
2. Build & test locally: `cargo test && cd web && npm run build`
3. Push, create PR (include `Closes #<ISSUE>` in body) → CI runs docker-publish
4. Merge to main → auto-closes issue + CI publishes `main`-tagged images
5. Update image tags in k8s manifests: `k8s/kustomization.yaml`
6. `kubectl apply -k k8s/`

For version bumps and PR mechanics, use the `nession-cicd` skill (`.claude/skills/nession-cicd/SKILL.md`).

### Worktree Convention

Feature work uses isolated git worktrees under `.claude/worktrees/`. Claude Code can create these automatically via `EnterWorktree`. Branch naming: `worktree-<feature-slug>`.

### Commit Convention

- `feat:` — new feature or component
- `fix:` — bug fix or code review finding
- `refactor:` — code change, no behavior change
- `chore:` — config, deps, cleanup
- `docs:` — documentation

All commits co-authored by Claude: `Co-Authored-By: Claude <noreply@anthropic.com>`
