# Nession — Distributed tmux Agent

## 1. Project Structure

```
nession/
├── crates/                   # Rust workspace (5 crates)
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
│   ├── nession-cli/          # CLI client for terminal attach
│   │   └── src/
│   │       ├── main.rs
│   │       ├── commands/     # Subcommands (attach, list, etc.)
│   │       ├── client/       # WebSocket client logic
│   │       └── terminal/     # Raw terminal I/O
│   └── nession-claude-code/  # Claude Code config browser extension
│       └── src/
│           ├── agent.rs      # Agent-side handler for claude_code.list/read
│           ├── scanner.rs    # Walks ~/.claude/ and collects exposable files
│           ├── security.rs   # Extension allowlist, size caps, path denylist
│           └── server.rs     # Server-side relay hook (currently generic)
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
├── Cargo.toml                # Workspace root (5 crates, shared dependencies)
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

**⚠ CRITICAL: Never develop on `main`. Always create a branch first.** All branches come off `main` (see **Branch base and merge method**).

```bash
git fetch origin
git checkout -b feat/<slug> origin/main   # or use EnterWorktree for isolated workspace
```

Before committing, verify you are NOT on `main`:
```bash
git branch --show-current     # must NOT be "main"
```

If already on `main` with changes, migrate them:
```bash
git stash
git fetch origin
git checkout -b feat/<slug> origin/main
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

Deploys are automatic: CI updates the overlay image tags and ArgoCD syncs. `k8s/` has no top-level kustomization — always target an overlay.

```bash
kubectl kustomize k8s/overlays/staging        # inspect before applying
kubectl apply -k k8s/overlays/production      # bootstrapping / ArgoCD down only
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
# 1. START — every branch comes off main
git fetch origin
git checkout -b feat/<slug> origin/main

# 2. DEVELOP — implement, test, commit
cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# 3. PUBLISH — PR targets staging. No `Closes #<ISSUE>` here; it goes in the release PR.
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."

# 4. MERGE to staging — quality gate (rust-check + web-check) must pass
gh pr merge <PR-NUMBER> --auto --rebase

# 5. STAGING VALIDATION
./scripts/deploy-watch.sh staging

# 6. RELEASE — staging → main, MUST be --merge
gh pr list --state merged --base staging   # audit what is being released, find linked issues
gh pr create --base main --head staging --title "chore: release (staging → main)" \
  --body "$(cat <<'BODY'
## 变更内容
- ...

## 测试报告
- ...

Closes #<ISSUE>
Closes #<ISSUE>
BODY
)"
gh pr merge <PR-NUMBER> --merge   # never --rebase, never --squash

# 7. VERSION BUMP — only if this release warrants one
git checkout -b chore/bump-version-X.Y.Z origin/main
# Bump version in ALL FOUR files (see "Version Bumping" in nession-development)
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "..."
gh pr merge <PR-NUMBER> --rebase   # no --auto

# 8. WATCH RELEASE — wait for release.yml to finish writing the prod overlay tag
./scripts/deploy-watch.sh prod

# 9. SYNC — main → staging. Always a fast-forward; no force push.
#    Do this LAST, once main has stopped moving (bump + prod tag commit are in).
git fetch origin
git push origin origin/main:refs/heads/staging
```

**⚠ Step 6 must be `--merge`.** The merge commit records `staging`'s tip as a second parent, so `staging` stays an ancestor of `main` and step 9 is a fast-forward forever. No orphaned commits exist, and `staging` never needs a force push.

**Why not `--rebase` here** — even though every *other* merge in this repo is a rebase. GitHub's rebase-merge **always rewrites the commits and leaves the head branch pointing at the originals**, so `staging` would stop being an ancestor of `main` after every release. It rewrites even when nothing forces it to: measured on PR #305, whose branch was already a linear descendant of `main`, the landed commit `787f8be` and the branch tip `39825da` had the *identical* tree `deaf21f4` and differed only because the committer date moved 12:14:04 → 12:16:43.

Those orphans are usually harmless, because a later rebase skips them by patch-id — measured: orphan `67afd56` and its twin `62a5731` both hash to `e56a93b449d8`, and a controlled repro confirmed the replay is skipped. But an orphan whose release rebase **resolved a conflict** carries a different patch-id, so it re-applies and re-conflicts on *every* subsequent release until someone drops it by hand. That is not hypothetical: the 0.29.0 release produced exactly one such orphan, `aeb25f8` (`fdf7df10c5d8`) against `8d0125d` (`be13108ebd0b`), from the overlay conflict. `--merge` removes the entire class rather than relying on de-duplication holding.

`--squash` is worse still: N commits collapse into one whose combined patch-id matches nothing, so a later replay re-applies all N. Measured: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

**⚠ Step 9 is not optional, and it goes last.** Steps 7 and 8 both add commits to `main` (the bump, then `release.yml`'s `chore: update prod image tags`), so syncing before them leaves `staging` two commits behind for no reason. Sync once `main` has stopped moving — it is still a fast-forward, since `staging`'s tip is an ancestor of everything added after it.

Branching from `main` (step 1) is only correct while `main` is not behind `staging`. Skip the sync and `main` starts missing unreleased work; new branches then lack code they need to build on.

**Never force-push `staging`.** It has `allow_force_pushes: true` as an escape hatch, but under this flow a force push is never part of the routine — if you find yourself reaching for one, the release was merged with the wrong method.

**⚠ If the release PR reports `mergeable: false`, do NOT back-merge `main` into `staging`.** Resolve the conflict on a throwaway branch instead, leaving `staging` untouched:

```bash
git checkout -b chore/release-<sha> origin/main
git cherry-pick <staging-commit>...        # resolve conflicts here
git push -u origin chore/release-<sha>
gh pr create --base main --head chore/release-<sha> --title "chore: release (...)" --body "..."
gh pr merge <PR-NUMBER> --rebase
```

Then sync step 9 as usual. Measured 2026-08-17 on the 0.29.0 release: `staging → main` reported `mergeable: false`, conflicting on `k8s/overlays/staging/kustomization.yaml`; the cherry-pick branch merged cleanly. Note `mergeable: false` blocks `--merge`, `--rebase` and `--squash` alike, so switching method never routes around a real conflict. Under this flow such conflicts should not arise at all — see the `k8s/overlays/**` rule below for the one thing that causes them.

**⚠ Step 7 is mandatory when the release contains runtime changes.** 15 of `release.yml`'s 16 jobs are gated on `version_changed` — only `version-check` itself runs — so a release merge that carries no version bump builds nothing — no images, no GitHub Release, no production overlay update. "No bump" means "merged to `main`, not released to production". Test-only or docs-only releases can skip it; anything touching `crates/` or `web/src/` runtime code cannot.

**⚠ All four version files move together.** `release.yml` tags server/agent from `Cargo.toml` and ui from `web/package.json`; `version-check` now fails the run if the two disagree.

**⚠ CRITICAL: Once a PR is merged, that feature branch is DEAD.** Never push more commits to a merged branch — rebase-merge replayed its commits onto `staging` as *new* SHAs, so the originals are not in the target's ancestry and a second PR re-carries every old commit and conflicts. Follow-up work starts from a new branch:

```bash
git fetch origin
git checkout -b fix/<new-slug> origin/main        # normal case
git checkout -b fix/<new-slug> origin/staging     # only if it builds on unreleased work
```

### Branch base and merge method

Every branch comes off `main`. Only follow-up work on code that is on `staging` but not yet released may branch off `origin/staging`.

**Every merge is `--rebase` except the release, which must be `--merge`.** Nothing is ever squashed.

| Work | Branch from | PR base | Merge with |
|------|-------------|---------|------------|
| `feat/**`, `fix/**` — touches `crates/` or `web/src/` | `main` | `staging` | `--auto --rebase` |
| `docs/**`, `chore/**` — touches no build input | `main` | `main` | `--rebase` |
| `.github/workflows/*` fixes | `main` | `main` | `--rebase` |
| release — `staging` → `main` | — | `main` | `--merge` |
| `chore/bump-version-X.Y.Z` — after the release merged | `main` | `main` | `--rebase` |

- **Anything touching `crates/` or `web/src/` must go through `staging`.** A PR to `main` gets no quality gate — `quality.yml` only runs on PRs to `staging`. Required status checks (`rust-check`, `web-check`) are configured on `staging`, not on `main`.
- **The release PR must be `--merge`; everything else is `--rebase`.** The asymmetry is the point: `staging` is a long-lived branch that gets synced back, so it must stay an ancestor of `main`, and only a merge commit guarantees that. Feature branches are dead after merge, so rebase orphaning them costs nothing.
- **The PR body never enters git history, under any merge method here.** Rebase-merge keeps each commit's own message (measured: PR #301 → `673664f` kept the message, discarded the body); `--merge` writes `MERGE_MESSAGE` + `PR_TITLE`, not the body. Only squash used the body, and nothing squashes now. So commit messages are the permanent record — write them properly, and treat the PR body as review material.
- `--auto` only on PRs that have checks. `main`-targeted PRs have none — omit it there.
- Never put an empty commit on `staging`. Trigger workflows with `gh workflow run`, not `git commit --allow-empty`.
- **Never let a feature branch touch `k8s/overlays/**`.** Those files are CI-owned on `main` (`staging.yml` and `release.yml` write them). A branch cut from `main` inherits whatever tag was current, and carrying that snapshot into `staging` is what makes a release conflict — it is exactly what broke the 0.29.0 release. Overlay edits, if ever needed by hand, go direct to `main`.
- **After every release, sync `main` → `staging`.** It is a fast-forward; never force-push `staging`.

Mechanics and rationale: `nession-cicd` skill.

### Issues close at the release PR

`Closes #<ISSUE>` belongs in the **`staging` → `main` release PR body** — and nowhere else. GitHub honors closing keywords only when a PR targets the default branch, so the same line in a feat→staging PR does nothing.

- Before opening the release PR, audit what is being released and collect the linked issues:
  ```bash
  gh pr list --state merged --base staging --limit 20
  ```
- One `Closes #<ISSUE>` line per issue. Missing one means it stays open after shipping.
- Closing keywords work at the PR level, so the merge method is irrelevant — `--merge` closes the issues just as any other method would.
- 变更内容 and 测试报告 go in the release PR body too.
- **Screenshots go in a PR comment, not the body.** This used to be because the body became the squash commit message; nothing squashes now and no current merge method writes the body to a commit, so the reason is just readability — keep the body a scannable change record.

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

Use `mcp__playwright__browser_navigate` to open pages, `mcp__playwright__browser_snapshot` to inspect, and `mcp__playwright__browser_take_screenshot` to capture. Post them as a **PR comment**, not in the PR body — the body becomes the commit message.

**⚠ `browser_take_screenshot` 的 `filename` 必须带 `.playwright-mcp/screenshots/` 前缀** —— 裸文件名会相对于 cwd（仓库根目录）解析，把截图泄漏到工作区。`.playwright-mcp/` 目录只承接 snapshot/console 等自动产物（由 `--output-dir` 控制），不影响显式传入的 `filename`：

- ✅ `filename: ".playwright-mcp/screenshots/terminal-after.png"`
- ❌ `filename: "terminal-after.png"` → 落到仓库根目录

漏网的根目录截图会被 pre-commit 的 `scripts/move-screenshots.sh` 兜底移走，但不要依赖兜底。

### Release Flow

1. Develop on a branch off `main` (worktree preferred, see below)
2. Build & test locally: `cargo test && cd web && npm run build`
3. **Collect screenshots** via Playwright MCP for any functional UI change
4. PR to `staging` — 变更内容 + 测试报告 in the body, screenshots in a PR comment. No `Closes #N` here.
5. `gh pr merge <PR> --auto --rebase` → verify with `./scripts/deploy-watch.sh staging`
6. Release: PR `staging` → `main` with every `Closes #<ISSUE>` in the body → `gh pr merge <PR> --merge`
7. Version bump only if warranted — see **Development Cycle** step 7
8. `./scripts/deploy-watch.sh prod`
9. Sync `main` → `staging` (fast-forward, see **Development Cycle** step 9) — mandatory, and goes last

**No manual k8s step.** `release.yml` opens the PR that sets production image tags; ArgoCD syncs. Never hand-edit overlay tags, never `kubectl apply` as part of a release.

For version bumps and PR mechanics, use the `nession-cicd` skill (`.claude/skills/nession-cicd/SKILL.md`).

### Worktree Convention

Feature work uses isolated git worktrees under `.claude/worktrees/`. Claude Code can create these automatically via `EnterWorktree`.

**Branch naming must follow the standard prefix convention** (`feat/` or `fix/`) so CI triggers correctly:
- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes

When using `EnterWorktree`, pass the full branch name: `EnterWorktree name: "feat/<slug>"`.

`EnterWorktree` bases the branch on `origin/main`, which is the correct base. Only re-point it when the work builds on unreleased code already on `staging`:

```bash
git fetch origin
git reset --hard origin/staging
```

### Commit Convention

- `feat:` — new feature or component
- `fix:` — bug fix or code review finding
- `refactor:` — code change, no behavior change
- `chore:` — config, deps, cleanup
- `docs:` — documentation

All commits co-authored by Claude: `Co-Authored-By: Claude <noreply@anthropic.com>`

**Feature branches merge by rebase, so every commit message lands verbatim** — nothing collapses them and no PR body replaces them. Write each commit as if it were the permanent record, because it is. Don't leave `wip`/`fixup` subjects on a branch you intend to merge; squash them locally with `git rebase -i` first.

## 3. Quality Gates

- **两个 hook,都在 `.githooks/`**（`git config core.hooksPath = .githooks`），随仓库版本控制。改 hooks 只改这两个文件。每一步都是 blocking。
- **`pre-commit` 只跑快检查**：`just quick`（`cargo fmt --check` → `cargo clippy --workspace -D warnings`）+ `just web-lint`（`eslint --max-warnings 0` → `tsc --noEmit`）。不跑测试,不跑覆盖率。
- **`pre-push` 跑测试和覆盖率,且按改动范围收窄**：改了 `.rs` / `Cargo.{toml,lock}` / `rust-toolchain.toml` / `.cargo/` → `just test` + `just coverage`;改了 `web/**.{ts,tsx,js,css}` → `just web-test` + `just web-coverage`。两者都没改则整个跳过。
- **CI 触发**：`quality.yml`（PR -> staging:rust-check = `just check`,web-check = `just web-lint` + `just web-test`）;`staging.yml`（push to staging,纯文档改动经 `paths-ignore` 跳过:完整 build + deploy）;`release.yml`（push to main:release,全部 job 门禁在 `version_changed` 上）。
- **⛔ 禁止任何手段跳过 git hooks**：`git commit --no-verify`、`git push --no-verify`、`--no-gpg-sign`、临时 unset `core.hooksPath` 等一律禁止。测试挂了修测试,覆盖率不够补测试,lint 报错修 lint——不准绕。pre-push hook 跑太久就等着,或者拆分 commit。
- **覆盖率阈值**（`scripts/check-coverage.sh` 是唯一来源,每次遍历全部登记的 crate,不按改动收窄）：

  | 目标 | 阈值 |
  |------|------|
  | `nession-common` / `nession-server` | 80% line |
  | `nession-agent` | 80% line（macOS 上 79%，control-mode 测试在 macOS 被跳过） |
  | `nession-cli` | 40% line（不可测的命令已排除） |
  | `nession-claude-code` | **未登记 → 不检查** |
  | web（`web/vite.config.ts`） | lines / functions / statements 80%，**branches 65%** |

- **CI 的 web-check 不跑 `just web-coverage`**。web 覆盖率阈值只由本地 pre-push 把关,PR 上没有独立验证。改动 web 代码时不要指望 CI 拦住覆盖率回退。
