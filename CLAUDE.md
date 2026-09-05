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
├── (gitops branch)           # ArgoCD desired state — k8s/ + argocd/ moved to the
│                             # gitops orphan branch (issue #592); main carries
│                             # application source only
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

### Two Iron Laws

**Iron Law 1 — Project root = latest `main` only**

The repository root checkout exists solely to mirror `origin/main`. It is **not** a development workspace.

| Allowed in root | Forbidden in root |
|-----------------|-------------------|
| `git fetch origin` | Any file edits |
| `git checkout main` | Any commits |
| `git pull --ff-only origin main` (or `git reset --hard origin/main` after fetch) | `git checkout -b …` or any feature branch |
| `git worktree add/list/remove/prune` | `cargo` / `npm` / tests for feature work |
| Reading docs, inspecting code | Leaving uncommitted changes |

**Refresh root before every new worktree:**

```bash
git fetch origin
git checkout main
git pull --ff-only origin main   # must fast-forward; resolve offline if not
git status                     # must be clean — no modified/untracked work files
```

**Iron Law 2 — All development in worktrees**

Every change — `feat/**`, `fix/**`, `chore/**`, `docs/**`, release cherry-picks, version bumps — happens in an isolated worktree under `.claude/worktrees/`. **Never develop in the project root.**

```bash
# Preferred — Claude Code / Cursor
EnterWorktree name: "feat/<slug>"

# Manual — from clean root on latest main (after Iron Law 1 refresh)
git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main
cd .claude/worktrees/feat-<slug>
```

Branch naming must use `feat/<slug>` or `fix/<slug>` (or `chore/**`, `docs/**` for direct-to-main work) so CI triggers correctly. See **Branch base and merge method**.

Before every commit, verify you are **not** on `main`:

```bash
git branch --show-current     # must NOT be "main"
```

**Emergency only** — uncommitted changes accidentally made in root (do not make this a habit):

```bash
git stash
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main
cd .claude/worktrees/feat-<slug>
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
cargo fmt --all -- --check                              # Formatting check
cargo clippy --workspace --all-targets -- -D warnings   # Lint — MUST pass with 0 warnings
```
- `#[allow(clippy::*)]` is **forbidden**. Every clippy lint must be fixed properly, not silenced.
- **⛔ Lint 规则本身不准擅自改动 —— 任何修改必须先经仓库所有者明确同意。** 规则收紧和放宽都算,包括但不限于:
  - `Cargo.toml` 的 `[workspace.lints.*]`(增删条目、改 `deny`/`warn`/`allow` 级别)
  - `clippy.toml`(阈值,以及 `allow-*-in-tests` 这类放行开关)
  - 命令行 `-A` / `--allow`,或在 `justfile` / CI 里给 clippy 传放行参数
  - `#![allow(...)]` crate 级属性、`#[allow(clippy::*)]` 条目级属性

  换句话说:**碰到 lint 报错就修代码,不准改规则来让报错消失。** 想改规则,先带上理由和影响面来问,拿到同意再改。这是为了防止「一条 lint 挡路 → 顺手放宽 → 门禁被逐步蛀空」——放宽一次不会有人注意,但覆盖面是一去不返的。
- 同理,**测试代码也必须完整受 lint 门禁覆盖**,不能靠"测试是特例"来豁免。测试 helper 里 `unwrap()` 报错,正确做法是把 helper 改成返回 `Result`、由 `#[test]` 函数在调用处 unwrap(clippy 在 `#[test]` 函数内部本就放行),而不是给它加放行开关。
- `clippy.toml` contains lint thresholds (`cognitive-complexity-threshold = 25`, `too-many-lines-threshold = 150`).
- Workspace lints in `Cargo.toml` (`[workspace.lints.clippy]`) apply to all crates via `[lints] workspace = true`.
- 门禁 `just lint` = `cargo clippy --workspace --all-targets -- -D warnings`。**`--all-targets` 是必须的** —— 没有它,`#[cfg(test)]` 模块和 `tests/` 下的集成测试完全不会被 lint。改动这条门禁的覆盖面同样属于 lint 规则改动,需先获同意。
- 测试代码里的 `foo[0]` 由 `clippy.toml` 的 `allow-indexing-slicing-in-tests` 放行(2026-08-21 经批准)。理由写在 `clippy.toml` 注释里:该 lint 命中的绝大多数是 `value["key"]` 这种 `serde_json::Value` 索引,而它对缺失键返回 `Value::Null`、**不会 panic**,改成 `.get("key").unwrap()` 反而会凭空引入 panic。

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

**ArgoCD consumes the `gitops` orphan branch — not `main`** (issue #592, scoped
2026-09-05: the development flow keeps its staging-branch gates and
staging→main releases; only deployment desired state moved). The branch holds
`base/nession` (env-agnostic manifests), `environments/<env>/nession` (one
kustomize overlay per env) and `argocd/` (self-managed app-of-apps). Deploys
are bot commits on `gitops`, in **two lanes** (owner model 2026-09-05):

| Lane | Environments | Deploys | Ref |
|------|-------------|---------|-----|
| **staging lane — any sha** | `staging` (auto), `staging-01` + any env dir (manual) | arbitrary commit whose ghcr images exist | `staging.yml` `deploy-staging-gitops`; `deploy.yml` |
| **release lane — needs a version** | `production` only | SemVer via release, behind Environment approval | `release.yml` `promote-production` |

- **staging branch push** → `staging.yml` builds sha images → `deploy-staging-gitops`
  writes `deploy(staging): <sha>` to `gitops/environments/staging` → ArgoCD syncs.
- **staging→main release** (version bump) → `release.yml` builds version images →
  `promote-production` writes `deploy(production): <ver>` **after GitHub
  Environment `production` approval** → ArgoCD syncs.
- **Manual SHA deploy** (`deploy.yml`) to any env dir (e.g. `staging-01`):
  accepts **any commit with built images** — merge to staging builds them
  (quality already ran), so small fixes can be validated standalone before the
  next release. `production` is release-lane only: the deploy is refused with
  a clear message (gitops-commit.sh rejects non-SemVer refs for production).

`preprod` is dormant (dispatch-ready, not in any lane). `staging-01` currently
sits on an older validated commit from the machinery drills.

All writers go through `scripts/gitops-commit.sh` (gitops-writer concurrency +
rebase-retry). Never edit the `gitops` branch by hand except rollback
(`git revert` a deploy commit — ArgoCD syncs back). Inspect overlays with:

```bash
git show gitops:environments/production/nession/kustomization.yaml   # current prod tags
git clone -b gitops <repo> /tmp/gitops                                # full tree
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

**Refresh root main → worktree → develop → PR → merge → cleanup worktree → repeat**

```bash
# 1. START — refresh root, then create worktree off origin/main
git fetch origin && git checkout main && git pull --ff-only origin main
EnterWorktree name: "feat/<slug>"
# manual: git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main

# 2. DEVELOP — in the worktree only; implement, test, commit
cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# 3. PUBLISH — PR targets staging. No `Closes #<ISSUE>` here; it goes in the release PR.
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."

# 4. MERGE to staging — quality gate (rust-check + web-check) must pass
gh pr merge <PR-NUMBER> --auto --merge

# 5. STAGING VALIDATION
./scripts/deploy-watch.sh staging

# 6. RELEASE — staging → main
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
gh pr merge <PR-NUMBER> --merge

# 7. VERSION BUMP — only if this release warrants one (in a worktree, not root)
EnterWorktree name: "chore/bump-version-X.Y.Z"
# manual: git worktree add -b chore/bump-version-X.Y.Z .claude/worktrees/chore-bump-X.Y.Z origin/main
# Bump version in ALL FOUR files (see "Version Bumping" in nession-development)
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "..."
gh pr merge <PR-NUMBER> --merge   # no --auto

# 8. WATCH RELEASE — wait for release.yml's promote-production (Environment
#    approval pauses it) to write the gitops deploy commit, then ArgoCD rollout
./scripts/deploy-watch.sh prod

# 9. SYNC — main → staging. Always a fast-forward; no force push.
#    Do this LAST, once main has stopped moving (bump + prod tag commit are in).
git fetch origin
git push origin origin/main:refs/heads/staging
```

**⚠ Everything is `--merge`. Nothing is ever rebased or squashed.** A merge commit records the head branch's tip as a second parent, so every branch that lands stays in the target's ancestry with its **original SHAs**. `staging` therefore stays an ancestor of `main` and step 9 is a fast-forward forever; no orphaned commits exist anywhere; `staging` never needs a force push.

**Why not `--rebase`.** GitHub's rebase-merge **always rewrites the commits and leaves the head branch pointing at the originals**. It rewrites even when nothing forces it to: measured on PR #305, whose branch was already a linear descendant of `main`, the landed commit `787f8be` and the branch tip `39825da` had the *identical* tree `deaf21f4` and differed only because the committer date moved 12:14:04 → 12:16:43.

Those orphans are usually harmless, because a later rebase skips them by patch-id — measured: orphan `67afd56` and its twin `62a5731` both hash to `e56a93b449d8`, and a controlled repro confirmed the replay is skipped. But an orphan whose rebase **resolved a conflict** carries a different patch-id, so it re-applies and re-conflicts on *every* subsequent release until someone drops it by hand. That is not hypothetical: the 0.29.0 release produced exactly one such orphan, `aeb25f8` (`fdf7df10c5d8`) against `8d0125d` (`be13108ebd0b`), from an overlay conflict. `--merge` removes the entire class rather than relying on de-duplication holding.

`--squash` is worse still: N commits collapse into one whose combined patch-id matches nothing, so a later replay re-applies all N. Measured: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

**⚠ Step 9 is not optional, and it goes last.** Steps 7 and 8 both add commits to `main` (the bump, then `release.yml`'s `promote-production` gitops deploy commit — on the `gitops` branch, not main), so syncing before them leaves `staging` two commits behind for no reason. Sync once `main` has stopped moving — it is still a fast-forward, since `staging`'s tip is an ancestor of everything added after it.

Branching from `origin/main` (step 1 worktree base) is only correct while `main` is not behind `staging`. Skip the sync and `main` starts missing unreleased work; new worktrees then lack code they need to build on.

**Never force-push `staging`.** It has `allow_force_pushes: true` as an escape hatch, but under this flow a force push is never part of the routine — if you find yourself reaching for one, the release was merged with the wrong method.

**⚠ If the release PR reports `mergeable: false`, do NOT back-merge `main` into `staging`.** Resolve the conflict in a throwaway worktree off `origin/main`, leaving `staging` untouched:

```bash
git fetch origin && git checkout main && git pull --ff-only origin/main
git worktree add -b chore/release-<sha> .claude/worktrees/chore-release-<sha> origin/main
cd .claude/worktrees/chore-release-<sha>
git cherry-pick <staging-commit>...        # resolve conflicts here
git push -u origin chore/release-<sha>
gh pr create --base main --head chore/release-<sha> --title "chore: release (...)" --body "..."
gh pr merge <PR-NUMBER> --merge
```

Then sync step 9 as usual. Measured 2026-08-17 on the 0.29.0 release: `staging → main` reported `mergeable: false`, conflicting on `k8s/overlays/staging/kustomization.yaml`; the cherry-pick branch merged cleanly. Note `mergeable: false` blocks every merge method alike, so switching method never routes around a real conflict. That particular conflict came from the rebase flow rewriting an inherited overlay commit, which `--merge` no longer does — so a release conflict should now be rare enough to treat as a genuine content clash worth reading carefully.

**⚠ Step 7 is mandatory when the release contains runtime changes.** 15 of `release.yml`'s 16 jobs are gated on `version_changed` — only `version-check` itself runs — so a release merge that carries no version bump builds nothing — no images, no GitHub Release, no production deploy commit. "No bump" means "merged to `main`, not released to production". Test-only or docs-only releases can skip it; anything touching `crates/` or `web/src/` runtime code cannot.

**⚠ All four version files move together.** `release.yml` tags server/agent from `Cargo.toml` and ui from `web/package.json`; `version-check` now fails the run if the two disagree.

**Prefer a fresh worktree for follow-up work.** Under `--merge` a landed branch's commits are in the target's ancestry with their original SHAs, so pushing another commit to an already-merged branch and opening a second PR does work — the new PR's diff is just that commit. (This was a hard hazard while the repo rebased: replayed commits got *new* SHAs, the originals were not in the target's ancestry, and a second PR re-carried every old commit and conflicted.) It is still cleaner to start from a new worktree, so the branch name keeps matching one unit of work:

```bash
git fetch origin && git checkout main && git pull --ff-only origin/main
EnterWorktree name: "fix/<new-slug>"
# normal case — bases on origin/main (EnterWorktree default)
# unreleased staging dependency:
git worktree add -b fix/<new-slug> .claude/worktrees/fix-<new-slug> origin/staging
```

### Branch base and merge method

Every branch comes off `main` (via worktree — never `git checkout -b` in project root). Only follow-up work on code that is on `staging` but not yet released may use `origin/staging` as the worktree base.

**Every merge is `--merge`. Nothing is ever rebased or squashed.**

| Work | Branch from | PR base | Merge with |
|------|-------------|---------|------------|
| `feat/**`, `fix/**` — touches `crates/` or `web/src/` | `main` | `staging` | `--auto --merge` |
| `docs/**`, `chore/**` — touches no build input | `main` | `main` | `--merge` |
| `.github/workflows/*` fixes | `main` | `main` | `--merge` |
| release — `staging` → `main` | — | `main` | `--merge` |
| `chore/bump-version-X.Y.Z` — after the release merged | `main` | `main` | `--merge` |

- **Anything touching `crates/` or `web/src/` must go through `staging`.** A PR to `main` gets no quality gate — `quality.yml` only runs on PRs to `staging`. Required status checks (`rust-check`, `web-check`) are configured on `staging`, not on `main`.
- **One method everywhere, so ancestry is never rewritten.** Every landed branch stays reachable from the target with its original SHAs. That is what keeps `staging` an ancestor of `main` — making the step 9 sync a fast-forward forever — and it is why none of the orphan-and-patch-id reasoning that a rebase flow needs applies here.
- **The PR body never enters git history.** `--merge` writes `MERGE_MESSAGE` + `PR_TITLE`, not the body, and each commit keeps its own message. Only squash ever used the body, and nothing squashes. So commit messages are the permanent record — write them properly, and treat the PR body as review material.
- `--auto` only on PRs that have checks. `main`-targeted PRs have none — omit it there.
- Never put an empty commit on `staging`. Trigger workflows with `gh workflow run`, not `git commit --allow-empty`.
- **Never let a feature branch *edit* desired state.** Deploy commits live only on the `gitops` branch and are written solely by `scripts/gitops-commit.sh` (staging.yml / release.yml / deploy.yml) or by a human rollback (`git revert`). A branch touching `gitops` desired state would race the workflows that own it. (The old `k8s/overlays/**` on main is gone — moved to `gitops` in issue #592; the conflict class it caused at release died with it, because deploy commits never touch `main`.)
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

1. Develop in a worktree off `origin/main` (never in project root — see **Two Iron Laws**)
2. Build & test locally: `cargo test && cd web && npm run build`
3. **Collect screenshots** via Playwright MCP for any functional UI change
4. PR to `staging` — 变更内容 + 测试报告 in the body, screenshots in a PR comment. No `Closes #N` here.
5. `gh pr merge <PR> --auto --merge` → verify with `./scripts/deploy-watch.sh staging`
6. Release: PR `staging` → `main` with every `Closes #<ISSUE>` in the body → `gh pr merge <PR> --merge`
7. Version bump only if warranted — see **Development Cycle** step 7
8. `./scripts/deploy-watch.sh prod`
9. Sync `main` → `staging` (fast-forward, see **Development Cycle** step 9) — mandatory, and goes last

**No manual k8s step.** `release.yml`'s `promote-production` writes the gitops deploy commit after Environment approval; ArgoCD syncs. Never hand-edit gitops tags, never `kubectl apply` as part of a release (the only manual apply ever was the one-time `argocd/app-of-apps.yaml` bootstrap at cutover).

For version bumps and PR mechanics, use the `nession-cicd` skill (`.claude/skills/nession-cicd/SKILL.md`).

### Worktree Convention

| Location | Role |
|----------|------|
| **Project root** | Read-only mirror of latest `origin/main` — refresh, spawn worktrees, inspect code |
| **`.claude/worktrees/<name>/`** | All development — one worktree per branch/PR |

Claude Code / Cursor: `EnterWorktree name: "feat/<slug>"` (creates under `.claude/worktrees/`, bases on `origin/main`).

**Branch naming** (`feat/` or `fix/` for code changes) so CI triggers correctly:
- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes
- `chore/<slug>`, `docs/<slug>` — direct-to-main work (still in a worktree, not root)

**After PR merge** — worktree is dead; clean up and refresh root:

```bash
# In the worktree: push is done, PR merged
cd <project-root>                # return to root (still on main)
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree remove .claude/worktrees/feat-<slug>
git worktree prune
git branch -d feat/<slug>        # local branch, if fully merged
```

Claude Code: `ExitWorktree` with action `remove`.

**Exception — unreleased code on `staging`:** when follow-up work depends on code not yet on `main`, base the worktree on `origin/staging` instead:

```bash
git fetch origin
git worktree add -b fix/<slug> .claude/worktrees/fix-<slug> origin/staging
```

Do **not** `git reset --hard` in project root — root stays on `main`.

### Commit Convention

- `feat:` — new feature or component
- `fix:` — bug fix or code review finding
- `refactor:` — code change, no behavior change
- `chore:` — config, deps, cleanup
- `docs:` — documentation

All commits co-authored by Claude: `Co-Authored-By: Claude <noreply@anthropic.com>`

**Every commit message lands verbatim** — `--merge` collapses nothing and no PR body replaces them. Write each commit as if it were the permanent record, because it is. Don't leave `wip`/`fixup` subjects on a branch you intend to merge; tidy them locally with `git rebase -i` before pushing (rebasing your own unpushed branch is fine — what the flow never does is *land* a PR by rebase).

## 3. Quality Gates

- **两个 hook,都在 `.githooks/`**（`git config core.hooksPath`），随仓库版本控制。改 hooks 只改这两个文件。每一步都是 blocking。
- **⚠️ hook 改动在当前 worktree 里不生效。** 本机的 `core.hooksPath` 是**绝对路径**指向主检出(`/Users/.../nession/.githooks`),不是相对的 `.githooks`。git 是按 worktree 之外的这个绝对路径找 hook 的,所以**所有 worktree 提交时跑的都是主检出那一份**。后果:在 worktree 里改了 `.githooks/*` 之后,本 worktree 的提交仍然走旧 hook —— 新步骤要等改动合进 `main` 且根目录 `git pull` 之后才真正生效。想在合并前验证,直接调 `./.githooks/pre-commit`(需先 `git add` 一些文件,否则它因无 staged 内容直接 exit 0)。
- **`pre-commit` 只跑快检查**：`scripts/check-dev-workspace.sh commit`（禁止在根目录/`main` 上提交）→ `just quick`（`cargo fmt --check` → `cargo clippy --workspace -D warnings`）+ `just web-lint`（`eslint --max-warnings 0` → `tsc --noEmit`）。不跑测试,不跑覆盖率。
- **`pre-push` 跑测试和覆盖率,且按改动范围收窄**：开头同样跑 `check-dev-workspace.sh push`；改了 `.rs` / `Cargo.{toml,lock}` / `rust-toolchain.toml` / `.cargo/` → `just test` + `just coverage`;改了 `web/**.{ts,tsx,js,css}` → `just web-test` + `just web-coverage`。两者都没改则整个跳过。
- **手动检查**：`just check-workspace`（或 `./scripts/check-dev-workspace.sh session --fetch`）— Agent/开发者开新任务前确认根目录在最新 `main`、当前在 worktree 里开发。
- **测试并发安全**:测试之间隔离不够,**跑与跑之间**也必须隔离 —— 本仓库多 worktree 并存,CI 也可能和本地同时跑,共享状态会让两轮互相踩,失败看起来像随机的。三条硬规则:
  - 测试监听端口一律 `bind("127.0.0.1:0")` 由 OS 分配,**不准写死端口号,也不准用"预留端口段"** —— 段位在两轮并发时照样撞。需要一个"没人监听"的地址时,用 `free_port()`(bind :0 拿号后释放),helper 命名为 `*_on()`。
  - 每个测试用的数据库/临时文件走 `tempfile::tempdir()`,**不准用 `temp_dir()` 拼固定名**,也不准用"时间戳 + 进程内计数"(两个进程同一秒启动、计数都从 0 开始,拼出同一个路径)。
  - 碰 `paths::nession_home()` 的测试**必须先把 `NESSION_HOME` 指到临时目录** —— 否则它解析成 `$HOME/.nession`,直接改开发者的真实配置。

  **门禁是静态检查**:`just check-test-isolation`(`scripts/check-test-isolation.sh`),已接入 `pre-commit`,改了 `.rs` 就跑,约 1.5 秒。扫描范围是 `crates/*/tests/**` 加上每个 `src/` 文件第一个 `#[cfg(test)]` 之后的部分。`just check-test-isolation-selftest` 逐条注入违规,证明它还真的能抓到 —— 门禁静默失效比没门禁更糟。

  `just check-test-concurrency`(`scripts/check-test-concurrency.sh`,把每个测试二进制同时跑两遍)是**按需诊断工具,不是门禁**。它的价值是发现**未知类别**的共享状态(`NESSION_HOME` 那条就是它找到的,静态检查想不到要查)。但它不适合当门禁:竞态类问题它会漏报(实测同一份坏代码,一次 PASS 一次 FAIL),而并发让整机负载翻倍又可能让时序敏感的测试误报失败 —— 而 hook 不准绕,一次误报就把人卡死。
- **清理测试遗留的 tmux 会话**：`./scripts/sweep-test-sessions.sh`（列出）/ `--kill`（删除）。测试创建的会话一律以 `nession-test-` 开头,脚本只匹配这个前缀,不会碰开发者自己的会话。集成测试的 `TestSession` guard 会在 panic 时自行清理,所以正常情况下不该有残留 —— 真出现了说明测试进程被强杀(Ctrl-C / SIGKILL)。注意它跑在默认 socket 上,安全性只来自名字前缀(`:43` list / `:67` kill)。
- **CI 触发**：`quality.yml`（PR -> staging:rust-check = `just check`,web-check = `just web-lint` + `just web-test`）;`staging.yml`（push to staging,纯文档改动经 `paths-ignore` 跳过:完整 build + deploy）;`release.yml`（push to main:release,全部 job 门禁在 `version_changed` 上）。
- **⛔ 禁止任何手段跳过 git hooks**：`git commit --no-verify`、`git push --no-verify`、`--no-gpg-sign`、临时 unset `core.hooksPath` 等一律禁止。测试挂了修测试,覆盖率不够补测试,lint 报错修 lint——不准绕。pre-push hook 跑太久就等着,或者拆分 commit。
- **⛔ 禁止擅自改动 lint 规则**:`[workspace.lints.*]`、`clippy.toml`、命令行 `-A`、`#[allow]` 一律需仓库所有者明确同意后才能改,收紧和放宽都算。报错修代码,不准改规则消错。测试代码同样必须受门禁覆盖,不靠"测试是特例"豁免。详见「Rust linting」。
- **⛔ 禁止 `tmux kill-server`,禁止不带 `-t <name>` 的 `kill-session`。** `kill-session -t <name>` 只允许针对本次自己创建的会话。需要临时 tmux 一律 `tmux -S /tmp/<唯一名>/sock`,清理前先用 `#{socket_path}` 断言路径。**`TMUX_TMPDIR=` 前缀不是隔离,不准拿它当保险。**
- **⛔ 禁止本地跑 e2e**(`npx playwright test`、为 e2e 跑 `cargo run`)。本地验 UI 只用 `cd web && npm run dev`;查 spec 语法用 `npx playwright test --list`。e2e spec 一律带 `test.skip(!process.env.CI, 'local only — runs in CI workflow only')`。与 §「Screenshots with Playwright」的 Playwright MCP 工具无关,那个照常用。

  以上两条的实测依据与修复进度见 #574、#575。
- **覆盖率阈值**（`scripts/check-coverage.sh` 是唯一来源,每次遍历全部登记的 crate,不按改动收窄）：

  | 目标 | 阈值 |
  |------|------|
  | `nession-common` / `nession-server` | 80% line |
  | `nession-agent` | 80% line（macOS 上 79%，control-mode 测试在 macOS 被跳过） |
  | `nession-cli` | 40% line（不可测的命令已排除） |
  | `nession-claude-code` | **未登记 → 不检查** |
  | web（`web/vite.config.ts`） | lines 78%，functions 72%，statements 76%，**branches 65%** |

- **CI 的 web-check 不跑 `just web-coverage`**。web 覆盖率阈值只由本地 pre-push 把关,PR 上没有独立验证。改动 web 代码时不要指望 CI 拦住覆盖率回退。
