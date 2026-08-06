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
│           ├── ui/           # shadcn/ui primitives (21 components + 2 custom wrappers, auto-generated)
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

### Frontend Conventions

- **hooks/**: All custom hooks. Never place hooks in `components/`.
- **components/**: UI components only. If a file starts with `use`, it belongs in `hooks/`.
- **services/websocket/plugins/**: WebSocket functionality is plugin-based. New capabilities go in a plugin, not in the core.
- **Type organization**: Core types in `types.ts`, domain types in `{domain}/types.ts`. Re-export domain types from `types.ts` for backward compatibility.

### Key Design Decisions

- **Web UI theming:** shadcn/ui default dark theme (Zinc/neutral palette). Terminal keeps Catppuccin Mocha independent of UI theme.
- **WebSocket singleton:** `WebSocketService` is a global singleton for the browser session — request/response correlation, event pub/sub, auto-reconnect.
- **CSS:** Tailwind v4 via `@tailwindcss/vite`. Only one CSS file (`index.css`). All component styles are Tailwind utilities.
- **shadcn components:** Individual primitives in `components/ui/`, added via CLI, version-controlled. See the shadcn component mapping below for what's installed and what to use for new features.
- **ESLint:** `eslint-disable` comments are forbidden. All lint violations must be fixed properly (type narrowing, destructuring deps, extracting non-component exports). `--max-warnings 0` is enforced.
- **Event handlers:** Never pass a function with optional parameters directly to `onClick`/`onChange` — React events will be passed as the first argument and may flow into `JSON.stringify`, causing circular-reference errors. Always wrap: `onClick={() => fn()}`.
- **React effect ordering:** Child component effects run before parent effects on first mount. Hooks managing async connection state must initialize to the optimistic in-progress value (`'connecting'`), not `'disconnected'` — otherwise child effects that depend on the connection will reject before the parent has a chance to start it. Also, under StrictMode (dev), effects run mount→cleanup→mount; don't reject in-flight promise waiters in cleanup — let them survive on a ref and settle on the second mount.

### shadcn/ui Component Map

Full component inventory and custom-component-to-primitive mapping: **`.claude/skills/nession-development/references/shadcn-components.md`**

Summary: 21 installed primitives + 2 custom wrappers. All hand-rolled tab strips, raw resize logic, and destructive confirms have been replaced with shadcn equivalents (Tabs, Resizable, AlertDialog). ~20 Tooltips added to icon-only buttons. See the reference doc for the complete inventory, priority queue, and golden rules.

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

- Rust (see `rust-toolchain.toml` for pinned version) with `cargo`
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

**Rust toolchain:** `rust-toolchain.toml` is the single source of truth (currently `channel = "1.96.0"`). CI uses `actions-rust-lang/setup-rust-toolchain@v1` which reads it natively — no version hardcoded in the workflow. To bump Rust, edit `rust-toolchain.toml` only, then `rustup toolchain install <ver> --component rustfmt --component clippy`.

**Linux-only code:** `#[cfg(target_os = "linux")]` blocks (including test assertions) are NOT compiled or linted on macOS. Lint violations there (e.g. `u64 >= 0`) only surface in CI. Manually review these blocks for platform-independent lint issues before pushing.

**Local demo stack (for Playwright verification):** use an isolated HOME so env/db files don't pollute `~/.nession`:
```bash
# Server (no-auth mode when auth_token is empty)
HOME=/tmp/nession-demo cargo run -p nession-server
# Agent (needs config as argv[1], tmux required)
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml
# Web (vite proxies /ws → localhost:19090)
cd web && npm run dev
```
Server listens on `127.0.0.1:19090` (ws) + `:10080` (http), agent on `:19091`. In the browser (http://localhost:13000), use any non-empty token to log in. Run `localStorage.clear()` first to drop stale prefilled values. Clean up with `pkill -f 'target/debug/nession-(server|agent)'` and `pkill -f vite`.

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

### Development Cycle

**Start fresh → Feature branch → PR → Merge → Old branch dead → Repeat**

```bash
# 1. START — always from latest main, always new branch
git checkout main
git pull
git checkout -b feat/<slug>

# 2. DEVELOP — implement, test, commit
cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# 3. PUBLISH — push and create PR (include Closes #<ISSUE> in body)
git push -u origin feat/<slug>
gh pr create --title "feat: <description>" --body "..."

# 4. MERGE — after review, merge to main (CI auto-publishes images)
#    For feat/** branches, use auto-merge to merge automatically when CI checks pass:
gh pr merge <PR-NUMBER> --auto --squash

# 5. VERSION BUMP — create a separate branch from main for version bump
git checkout main && git pull
git checkout -b chore/bump-version
# Edit Cargo.toml and web/package.json to bump version
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push origin chore/bump-version
gh pr create --title "chore: bump version to X.Y.Z" --body "Version bump"
# chore/** branches don't trigger CI, so merge directly (no --auto needed)
gh pr merge <PR-NUMBER> --squash

# 6. RETURN — back to main, pull merged result. OLD BRANCH IS DEAD.
git checkout main
git pull
```

**⚠ CRITICAL: Once a PR is merged, that feature branch is DEAD.** Never push more commits to a merged branch. Any follow-up work — even a one-line fix — must start from a new branch:

```bash
git checkout main
git pull
git checkout -b feat/<new-slug>
```

### Screenshots with Playwright

**After any functional UI change, collect screenshots via Playwright MCP** to prove the feature works visually. This is mandatory before creating a PR.

```bash
# 1. Start the app locally (server + agent + web)
cargo run -p nession-server &        # :19090 ws, :10080 http
cargo run -p nession-agent &          # needs tmux
cd web && npm run dev                 # :13000

# 2. Use Playwright MCP browser tools to:
#    - Navigate to http://localhost:13000
#    - Log in (if needed)
#    - Navigate to the feature you changed
#    - Take screenshots of BEFORE and AFTER states
#    - Save screenshots to a temp location for PR attachment
```

Use `mcp__playwright__browser_navigate` to open pages, `mcp__playwright__browser_snapshot` to inspect, and `mcp__playwright__browser_take_screenshot` to capture. Save screenshots to `.playwright-mcp/screenshots/` (gitignored, never committed). Reference them in the PR body under the **核心功能截图** section using repo-relative paths.

### Release Flow

1. Develop on feature branch (worktree preferred, see below)
2. Build & test locally: `cargo test && cd web && npm run build`
3. **Collect screenshots** via Playwright MCP for any functional UI changes
4. Push, create PR (include `Closes #<ISSUE>` in body, screenshots in PR body) → CI runs docker-publish
5. Merge to main → auto-closes issue + CI publishes `main`-tagged images
   - Use auto-merge when development is complete and version is bumped:
     ```bash
     gh pr merge <PR-NUMBER> --auto --squash
     ```
   - CI will automatically merge the PR once all checks pass
6. Update image tags in k8s manifests: `k8s/kustomization.yaml`
7. `kubectl apply -k k8s/`

For version bumps and PR mechanics, use the `nession-cicd` skill (`.claude/skills/nession-cicd/SKILL.md`).

### Worktree Convention

Feature work uses isolated git worktrees under `.claude/worktrees/`. Claude Code can create these automatically via `EnterWorktree`.

**Branch naming must follow the standard prefix convention** (`feat/` or `fix/`) so CI triggers correctly:
- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes

When using `EnterWorktree`, pass the full branch name: `EnterWorktree name: "feat/<slug>"`.

### Commit Convention

- `feat:` — new feature or component
- `fix:` — bug fix or code review finding
- `refactor:` — code change, no behavior change
- `chore:` — config, deps, cleanup
- `docs:` — documentation

All commits co-authored by Claude: `Co-Authored-By: Claude <noreply@anthropic.com>`

## 3. Quality Gates

- **`.githooks/pre-commit`** 是唯一 hooks 入口（`git config core.hooksPath = .githooks`），随仓库版本控制。改 hooks 只改这个文件。
- **Pre-commit 全部 blocking**：`cargo fmt` → `cargo clippy` → `cargo test --no-run` → `cargo test` → coverage（仅变更 crate）→ `eslint` → `tsc --noEmit` → `vitest run` → `vitest coverage`
- **CI 触发**：push `feat/**` / `fix/**`。`rust-check`（fmt + clippy + test）+ `web-check`（lint + tsc + test）。与 pre-commit 必须一致。
- **⛔ 禁止任何手段跳过 git hooks**：`git commit --no-verify`、`git push --no-verify`、`--no-gpg-sign`、临时 unset `core.hooksPath` 等一律禁止。测试挂了修测试，覆盖率不够补测试，lint 报错修 lint——不准绕。pre-push hook 跑太久就等着，或者拆分 commit。
- **覆盖率阈值**：`nession-common` 90%，其余 Rust crate 80%，web 80%。
