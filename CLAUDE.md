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

**⚠ CRITICAL: Never develop on `main`. Always create a feature branch first — based on `origin/staging`, since feature PRs target `staging`.**

```bash
git fetch origin
git checkout -b feat/<slug> origin/staging   # or use EnterWorktree for isolated workspace
```

Before committing, verify you are NOT on `main`:
```bash
git branch --show-current     # must NOT be "main"
```

If already on `main` with changes, migrate them:
```bash
git stash
git fetch origin
git checkout -b feat/<slug> origin/staging
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

Deploys are automatic: CI updates the image tags in the overlay and ArgoCD syncs from there. `k8s/` has no top-level kustomization — you must target an overlay explicitly.

```bash
# Render to inspect what would be applied (preferred over blind apply)
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production

# Manual apply — only for bootstrapping or when ArgoCD is unavailable
kubectl apply -k k8s/overlays/staging
kubectl apply -k k8s/overlays/production
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
# 1. START — branch from the SAME ref you will target. Feature PRs target
#    staging, so branch from origin/staging — NOT from main.
git fetch origin
git checkout -b feat/<slug> origin/staging

# 2. DEVELOP — implement, test, commit
cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# 3. PUBLISH — push and create PR targeting **staging**
#    Put `Closes #<ISSUE>` in a COMMIT MESSAGE, not just the PR body.
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."

# 4. MERGE to staging — quality gate (rust-check + web-check) must pass.
#    --squash here: one commit per feature on staging, and the squash body is
#    built from your commit messages (so `Closes #N` survives — see below).
gh pr merge <PR-NUMBER> --auto --squash

# 5. STAGING VALIDATION — CI builds and deploys to staging automatically after merge.
#    Verify on staging with ./scripts/deploy-watch.sh staging

# 6. VERSION BUMP + RELEASE — after staging validation, rebase staging onto a bump branch
git fetch origin                       # local `staging` is often stale — refresh first
git checkout main && git pull
git checkout -b chore/bump-version-X.Y.Z
# Rebase onto origin/staging, NOT the local `staging` branch. A stale local ref
# silently releases the wrong tree and fabricates conflicts.
git rebase origin/staging
# Bump version in ALL FOUR files (see "Version Bumping" in nession-development)
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "..."
# chore/** has no CI checks → --auto would fail with "clean status". Merge directly.
gh pr merge <PR-NUMBER> --rebase

# 7. RETURN — back to main, pull merged result. OLD BRANCH IS DEAD.
git checkout main
git pull
```

**⚠ Order matters in step 6:** `git rebase staging` comes **before** the version-bump commit. Rebasing after the bump would replay your bump commit onto staging and bury it mid-history.

**⚠ CRITICAL: Once a PR is merged, that feature branch is DEAD.** Never push more commits to a merged branch. Any follow-up work — even a one-line fix — must start from a new branch:

```bash
git fetch origin
git checkout -b feat/<new-slug> origin/staging
```

### Branch from the ref you target

| Work | Branch from | PR base |
|------|-------------|---------|
| `feat/**`, `fix/**`, `docs/**` | `origin/staging` | `staging` |
| `chore/bump-version-X.Y.Z` | `main` (then `git rebase origin/staging`) | `main` |
| `.github/workflows/*` fixes | `main` | `main` |

**Branching from `main` for a staging-targeted PR is a bug, not a shortcut.** The PR diff is computed against `merge-base(staging, yourBranch)`, so it silently carries every commit `main` has that `staging` lacks — and the merge drags all of it into `staging` (bundled into the squash commit, or replayed as rewritten duplicates under rebase). This actually happened: a `docs/**` branch cut from `main` dragged 5 of `main`'s commits into `staging`, and the resulting patch-id mismatch made the *next* release conflict on a file that PR never touched.

### Why `staging → main` must be rebase

`main` accumulates commits that `staging` never sees (the automated `chore: update staging image tags` PRs). So `main` and `staging` permanently diverge, and every release has to reconcile them. **The merge method that decides whether that reconciliation stays cheap is the `staging → main` one — not the `feature → staging` one.**

| Step | Method | Why |
|------|--------|-----|
| `feature → staging` | `--squash` | One commit per feature on `staging`. Harmless to de-duplication: that single commit is what later gets rebased onto `main`, patch intact. |
| `staging → main` | `--rebase` | Each `staging` commit lands on `main` as a 1:1 patch-id twin, so the next `git rebase origin/staging` **skips every already-released commit automatically**. Also preserves commit messages, which is what carries `Closes #N` to the default branch. |

Squashing at the **`staging → main`** step is what breaks it: N staging commits collapse into one commit whose combined patch-id matches nothing, so the next release replays all N again and conflicts the moment `main` has touched the same files. This is not theoretical — release PR #268 was squash-merged, and the next release was measured conflicting on `web/src/terminal/DeviceProfile.ts`.

Verified behaviour of `git rebase origin/staging` on a bump branch: already-released commits are dropped with `skipped previously applied commit`, `Merge branch 'main' into staging` commits are linearized away, and `main`-only commits rewritten during the rebase are de-duplicated again by the final rebase-merge. Net effect on `main` is exactly the new work plus the bump commit.

**⚠ Never commit an empty commit to `staging`.** An empty commit has no computable patch-id, so de-duplication cannot see it and **it is re-applied on every subsequent release**, accumulating a duplicate each time. To trigger a workflow use `gh workflow run` / `workflow_dispatch`, never `git commit --allow-empty`. To drop one that is already on `staging`, mark it `drop` during `git rebase -i origin/staging`.

### Closing issues: `Closes #N` goes in a commit message

This repo sets `squash_merge_commit_message: COMMIT_MESSAGES`, so a squash commit's body is assembled from **your commit messages** — the PR description is discarded. And GitHub only honours closing keywords when they reach the **default branch** (`main`), which a merge into `staging` never is.

So a `Closes #N` written only in the PR body is dropped at the squash and never reaches `main`. **Auto-close has never worked in this repo for exactly this reason** — issues #240, #239, #177 were all closed by hand.

Put the keyword in a commit message instead:

```bash
git commit -m "fix: stop terminal remounting on address switch

Closes #263"
```

It then flows: commit message → squash body on `staging` → rebase-merge preserves it → lands on `main` → GitHub closes the issue at release time. Keeping it in the PR body too is fine for human readers, but the commit message is what actually does the work.

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

Use `mcp__playwright__browser_navigate` to open pages, `mcp__playwright__browser_snapshot` to inspect, and `mcp__playwright__browser_take_screenshot` to capture. Reference them in the PR body under the **核心功能截图** section using repo-relative paths.

**⚠ `browser_take_screenshot` 的 `filename` 必须带 `.playwright-mcp/screenshots/` 前缀** —— 裸文件名会相对于 cwd（仓库根目录）解析，把截图泄漏到工作区。`.playwright-mcp/` 目录只承接 snapshot/console 等自动产物（由 `--output-dir` 控制），不影响显式传入的 `filename`：

- ✅ `filename: ".playwright-mcp/screenshots/terminal-after.png"`
- ❌ `filename: "terminal-after.png"` → 落到仓库根目录

漏网的根目录截图会被 pre-commit 的 `scripts/move-screenshots.sh` 兜底移走，但不要依赖兜底。

### Release Flow

1. Develop on feature branch (worktree preferred, see below)
2. Build & test locally: `cargo test && cd web && npm run build`
3. **Collect screenshots** via Playwright MCP for any functional UI changes
4. Push, create PR targeting **staging**. Put `Closes #<ISSUE>` in a **commit message** (not just the PR body — see "Closing issues" above), screenshots in the PR body → quality gate runs
5. Merge to staging with `gh pr merge <PR> --auto --squash` → CI builds and deploys to staging — verify with `./scripts/deploy-watch.sh staging`
6. After staging validation, release to main with a version bump → auto-closes issue + release workflow publishes versioned images
   ```bash
   git fetch origin
   git checkout main && git pull
   git checkout -b chore/bump-version-X.Y.Z
   git rebase origin/staging             # NOT local `staging` — it is often stale
   # Bump version in all four files (Cargo.toml, Cargo.lock, web/package.json, web/package-lock.json)
   git add -A && git commit -m "chore: bump version to X.Y.Z"
   git push -u origin chore/bump-version-X.Y.Z
   gh pr create --base main --title "chore: bump version to X.Y.Z" --body "..."
   gh pr merge <PR-NUMBER> --rebase      # no --auto: chore/** has no checks
   ```
7. Watch the release: `./scripts/deploy-watch.sh prod`

**No manual k8s step.** `release.yml`'s `update-prod-kustomize` job opens a PR that sets the version tags in `k8s/overlays/production/kustomization.yaml`; ArgoCD syncs from there. Do not hand-edit overlay image tags, and do not run `kubectl apply` as part of a release.

For version bumps and PR mechanics, use the `nession-cicd` skill (`.claude/skills/nession-cicd/SKILL.md`).

### Worktree Convention

Feature work uses isolated git worktrees under `.claude/worktrees/`. Claude Code can create these automatically via `EnterWorktree`.

**Branch naming must follow the standard prefix convention** (`feat/` or `fix/`) so CI triggers correctly:
- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes

When using `EnterWorktree`, pass the full branch name: `EnterWorktree name: "feat/<slug>"`.

**⚠ `EnterWorktree` bases the new branch on `origin/main`**, not `origin/staging` (its `worktree.baseRef` defaults to `fresh`, which means `origin/<default-branch>`, and it accepts only `fresh` or `head` — it cannot be pointed at an arbitrary ref). Since feature PRs target `staging`, re-point the branch immediately after entering the worktree:

```bash
git fetch origin
git reset --hard origin/staging
```

Skipping this reproduces the branch-base bug described in **Branch from the ref you target** above.

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
- **CI 触发**：三个 workflow 分工。`quality.yml`（PR -> staging：rust-check + web-check）；`staging.yml`（push to staging：完整 build + deploy）；`release.yml`（push to main：release）。与 pre-commit 必须一致。
- **⛔ 禁止任何手段跳过 git hooks**：`git commit --no-verify`、`git push --no-verify`、`--no-gpg-sign`、临时 unset `core.hooksPath` 等一律禁止。测试挂了修测试，覆盖率不够补测试，lint 报错修 lint——不准绕。pre-push hook 跑太久就等着，或者拆分 commit。
- **覆盖率阈值**：`nession-common` 90%，其余 Rust crate 80%，web 80%。
