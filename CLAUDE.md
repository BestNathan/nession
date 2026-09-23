# Nession — Distributed tmux Agent

## Product Direction — mandatory upstream constraints

Before proposing or implementing any user-facing or product-facing change, read these two repository-level sources of truth first:

1. [`VISION.md`](VISION.md) — what problem Nession exists to solve and where the product is going.
2. [`PRINCIPLE.md`](PRINCIPLE.md) — the durable rules used to make product and UX decisions.

They are upstream constraints for product behavior, UI, information architecture, interactions, Session, Workspace, extensions, contextual capabilities, and other user-facing work.

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
feature design
    ↓
implementation
```

Existing code, historical design documents, fixtures, screenshots, and executable UI contracts do not override the Vision or Principles. If a lower-level artifact conflicts, treat it as convergence debt: update it in the same change when appropriate, or link an explicit follow-up.

> **多 agent 兼容**:本文件通过 `AGENTS.md` 软链暴露给 Codex/Cursor/Copilot
> (AGENTS.md 是跨工具指令标准)。如果你不是 Claude Code:
> - 遇到 `EnterWorktree` / Skill 调用等 Claude Code 专属指令时,改用对应的
>   手动 git 命令(`git worktree add …`,见 Iron Law 2 段落)或直接读取文件。
> - 按领域取用 `.claude/skills/<name>/SKILL.md`(如开发前读
>   `nession-development`,CI/CD 问题读 `nession-cicd`)——它们是与工具无关的
>   流程文档,读文件即可生效。
> - `.githooks/` 的 pre-commit/pre-push 对所有 agent 的 git 提交生效(工作区
>   策略 + lint 门禁),不可绕过。

## 1. Project Structure

```
nession/
├── crates/                   # Rust workspace (8 crates)
│   ├── nession-protocol/     # The Protocol Kernel (#678) — identity, envelope,
│   │   └── src/              #   descriptor, manifest, resolver — and, under
│   │       ├── kernel/       #   `contracts/`, the core Protocol Units Nession
│   │       └── contracts/    #   owns. Depends on serde + thiserror ONLY: the
│   │                         #   dependency list *is* the ownership rule, so
│   │                         #   no resolver can name a concrete provider.
│   │                         #   Vocabulary, layout and the evolution rules:
│   │                         #   docs/architecture/protocol.md
│   ├── nession-common/       # Shared types, config, error definitions
│   │   └── src/              #   Contracts are NOT re-exported from here. The
│   │       │                 #   #678 Phase 1 shim that did was removed; the
│   │       │                 #   only spelling is the version-addressable
│   │       │                 #   nession_protocol::contracts::<family>::v1
│   │       ├── config.rs     # Agent/server config structs
│   │       ├── error.rs      # Error types
│   │       ├── paths.rs      # Config/data directory paths
│   │       └── lib.rs
│   ├── nession-git/          # Git Protocol Unit — typed contracts under
│   │                         #   protocol/<unit>/v1.rs, erased at agent.rs
│   ├── nession-protocol-codegen/  # `just codegen`: Rust contracts → the Web's
│   │                         #   TypeScript bindings (#678 Phase 5). Depends on
│   │                         #   the providers because enumerating them is its
│   │                         #   job; nothing that ships depends on it.
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
│       ├── App.tsx           # Root: auth gate → Shell or LoginPage
│       ├── main.tsx          # Entry point + Sonner Toaster
│       ├── index.css         # Tailwind v4 + shadcn/ui dark theme
│       ├── types.ts           # Shared TypeScript types
│       ├── app/              # App layer (composition root): Shell tree,
│       │                     #   experiences/{web,app}/, workspace/ tools, fixture/,
│       │                     #   app hooks (useAppConnection, useDashboard, …), LoginPage
│       ├── product/          # Nession product concepts: session/, agent/, terminal/,
│       │                     #   capability/ (the generic capability model)
│       ├── capabilities/     # Discoverable/activatable capabilities, as vertical slices:
│       │                     #   files/, env/, commands/, claude-code/
│       ├── platform/         # transport/runtime/attach + framework-level code with no
│       │                     #   product semantics: socket/, server/, explorer/,
│       │                     #   terminal-runtime/ (React-free), session-runtime/, attach/
│       │                     #   state lives in <owner>/state/ — product/*/state,
│       │                     #   platform/attach/state (no central atoms/ — #801 Phase 5)
│       ├── shared/           # Shared layer: hooks/ (generic React hooks importable by all layers)
│       ├── components/
│       │   └── ui/           # shadcn/ui primitives + wrappers (shared, added via CLI)
│       ├── lib/              # Pure helpers (shared layer)
│       ├── extensions/       # Generic UI-slot registry (no contributor today)
│       └── generated/        # `just codegen` output — protocol/<owner>/<unit>/v<N>.ts
│                             #   from the Rust contracts. NEVER hand-edited; the
│                             #   name the version means is in the import path.
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
├── Cargo.toml                # Workspace root (8 crates, shared dependencies)
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

- **hooks placement**: shared hooks in `shared/hooks/`, owner hooks in `<owner>/hooks/` (`product/<concept>/`, `capabilities/<name>/`, `platform/<domain>/`), app-composition hooks in `app/`. Never place hooks in `components/`.
- **components/**: only the shared `ui/` shadcn primitives live under `components/ui/`; owner UI belongs in `<owner>/components/`, shell UI in `app/`.
- **platform/socket/**: WebSocket functionality is plugin-based. A new wire-protocol family is a `TransportPlugin` (`platform/socket/types.ts`) implemented inside its owner layer and registered in `app/useAppConnection.ts` (`SERVER_PLUGINS`) — never added to the core `WebSocketService`. **Not to be confused with a Product Capability**, which has a presence state (`product/capability`); a transport plugin has none and is user-invisible.
- **Type organization**: Core types in `types.ts`, domain types in `{domain}/types.ts`. Re-export domain types from `types.ts` for backward compatibility.

### Key Design Decisions

- **Web UI theming:** light-only, from `design/tokens/*.json` via `design/generated/web.css` — never restate palette values in `index.css`. Location (local warm / remote cool) is the only chromatic axis; local sessions are colourless. The terminal consumes the same source as `design/generated/terminal.ts`, so its background *is* the canvas.
- **WebSocket singleton:** `WebSocketService` is a global singleton for the browser session — request/response correlation, event pub/sub, auto-reconnect.
- **CSS:** Tailwind v4 via `@tailwindcss/vite`. Only one CSS file (`index.css`). All component styles are Tailwind utilities.
- **shadcn components:** Individual primitives in `components/ui/`, added via CLI, version-controlled. See the shadcn component mapping below for what's installed and what to use for new features.
- **ESLint:** `eslint-disable` comments are forbidden. All lint violations must be fixed properly (type narrowing, destructuring deps, extracting non-component exports). `--max-warnings 0` is enforced.
- **Event handlers:** Never pass a function with optional parameters directly to `onClick`/`onChange` — React events will be passed as the first argument and may flow into `JSON.stringify`, causing circular-reference errors. Always wrap: `onClick={() => fn()}`.
- **React effect ordering:** Child component effects run before parent effects on first mount. Hooks managing async connection state must initialize to the optimistic in-progress value (`'connecting'`), not `'disconnected'` — otherwise child effects that depend on the connection will reject before the parent has a chance to start it. Also, under StrictMode (dev), effects run mount→cleanup→mount; don't reject in-flight promise waiters in cleanup — let them survive on a ref and settle on the second mount.

### shadcn/ui Component Map

Full component inventory and custom-component-to-primitive mapping: **`.claude/skills/nession-development/references/shadcn-components.md`**

Summary: 25 installed primitives + 2 custom wrappers, built on `@base-ui/react` (`alert-dialog` is the only Radix one). Four are currently unused — Resizable, Sheet, Sonner, Toggle — because their Dashboard-era consumers were deleted in #655. See the reference doc for the complete inventory, what is genuinely not installed, and the golden rules.

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
cargo run -p nession-server    # Start server (ws only — see port note below)
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

### tmux socket 隔离(nession 从不寄生在用户的 socket 上)

nession 的每一次 tmux 调用都带 **显式 `-S <绝对路径>`**,落在自己的 tmux server 上。它的 session 因此对 `tmux ls` 不可见,也不可能被和用户手工 session 一起端掉 —— tmux 的 `exit-empty` 默认 `on`,以前 nession 在默认 socket 上杀掉最后一个 session 会连带杀死用户整个 tmux server,2026-09-02 实际弄丢过一个 session(#574 / #575)。

**socket 路径解析顺序**(无任何回落到 tmux 默认 socket 的分支):

| 优先级 | 来源 | 值 |
|---|---|---|
| 1 | agent 配置 `tmux_socket_path` | 运维指定 |
| 2 | `$NESSION_TMUX_SOCKET` | 测试与 e2e 每轮唯一路径 |
| 3 | 默认 | `/tmp/nession-<uid>/tmux.sock` |

- **默认写死 `/tmp`,不用 `std::env::temp_dir()`。** macOS 上 `$TMPDIR` 是 `/var/folders/<hash>/T/` 且取决于进程怎么被启动(shell 与 LaunchAgent 看到的不一样)。agent 和 `nession` CLI 必须解析出**同一个** socket,否则 CLI 只会报空列表。tmux 自己写死 `/tmp` 也是这个原因。
- **不要把它指向 `$NESSION_HOME`。** 本项目 k8s 的 `/data` 是 NFS 挂载(`192.168.2.105:/mnt/share/k8s/production`),unix socket 在 NFS 上 bind 不可靠。socket 也不是需要持久化的状态。
- 路径长度上限 103 字节(macOS `sun_path` 104,留一位给 NUL)。超限在启动时报错并打出实际长度,不静默失败。
- socket 的父目录由 nession 用 0700 创建 —— **tmux 不会自己建**(实测报 `error creating <path> (No such file or directory)`)。
- 容器内可用 `AGENT_TMUX_SOCKET` 环境变量覆盖(`deploy/entrypoint-agent.sh` 会写进生成的配置)。

**手工 attach nession 的 session**(裸 `tmux attach` 接不到):

```bash
tmux -S /tmp/nession-$(id -u)/tmux.sock ls
tmux -S /tmp/nession-$(id -u)/tmux.sock attach -t <name>
```

agent 启动时会把实际路径和这条命令打进日志(`tmux socket: …`)。

**唯一收口点是 `crates/nession-agent/src/tmux/cmd.rs`** —— `TmuxCmd::tokio()` / `.std()` / `.pty()`(portable-pty 的 `CommandBuilder` 是另一套 API,单列一个构造器)。三者都会 `env_remove("TMUX")` 和 `env_remove("TMUX_TMPDIR")`:寻址只靠 `-S`,继承来的 `TMUX` 描述的是**别的** server。同理 `create_session` 往 session 里转发进程环境时会剔掉这两个变量,否则 nession session 里的 shell 会以为自己属于开发者那台 server。

- **⛔ 禁止 `TMUX_TMPDIR`。** 它不是隔离手段:`$TMUX` 一旦存在(从 tmux 里面跑任何东西时必然存在)tmux 就完全无视它,静默落回默认 socket;socket 目录不存在时同样静默回落。实测见 #574。
- **⛔ 禁止在 `cmd.rs` 之外派生 tmux 进程。** 门禁 `just check-tmux-socket`(`scripts/check-tmux-socket.sh`)会拦住三种形态:字面量 `Command::new("tmux")`、**变量形态 `Command::new(<expr>)`**(`&self.tmux_bin` 就是这种,只匹配字面量的门禁会对它报「零风险」)、以及 `CommandBuilder::new("tmux")`;另外扫 `scripts/**`、`e2e/**`、`deploy/**`、`justfile` 里不带 `-S` 的 shell 调用,和任何 `TMUX_TMPDIR` 赋值。已接入 `pre-commit` 与 `just check`(CI)。
  - 确实不是 tmux 的变量派生,在该行或其上三行内写 `// not-tmux: <理由>` 放行 —— 逐行、且必须写清理由,不给整文件开口子。
  - `just check-tmux-socket-selftest` 逐形态注入违规,证明门禁还真的抓得到。
- **测试与 e2e 每轮一个唯一 socket**:`scripts/tmux-run-socket.sh`(被 `filtered-test.sh`、`check-coverage.sh` source)用 `mktemp -d` 生成,并在退出时确认 `#{socket_path}` 后才 kill;e2e 由 `e2e/runtime.ts` 生成 `/tmp/nession-e2e-tmux-<8hex>/tmux.sock`。两者建目录时都写入 `owner.pid`(见下条孤儿回收)。**e2e 已移除开跑前的 `kill-server` 自愈**(那条命令正是打在真实 socket 上的那条),代价是被打断的轮次会留下孤儿 socket 且**跨轮累积**。
- **孤儿回收**:`scripts/sweep-test-sessions.sh`(列出 / `--kill`)只认两类项目自有的运行目录 —— Rust 测试的 `$TMPDIR/nession-test-tmux.*` 与 e2e 的 `/tmp/nession-e2e-tmux-*`(建/清规则分别在 `scripts/tmux-run-socket.sh` 与 `e2e/runtime.ts`)—— **目录模式即归属**,绝不碰默认 socket 或开发者的 session。每个运行目录在创建时写入 `owner.pid`(运行进程的 PID;此时 socket 上还不可能有 server),sweep 逐目录处理:`owner.pid` 中的 PID 存活(`kill -0`)→ **活轮次**,列出但不动;否则即孤儿,先做 `#{socket_path}` 断言再 kill-server,再删目录。无锁目录 = 旧遗留或锁未写入即被杀 —— 都不可能活着。正常退出时该轮的 trap/teardown 自己清理(Ctrl-C 走 trap),孤儿只来自 SIGKILL / kill -9 / 崩溃。实现 #582。

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
Server listens on `127.0.0.1:19090` (ws), agent on `:19091` — **no HTTP port
locally** (`10080` is nginx inside the image; see the port note above). In the
browser (http://localhost:13000), use any non-empty token to log in. Run
`localStorage.clear()` first to drop stale prefilled values. Clean up with
`pkill -f 'target/debug/nession-(server|agent)'` and `pkill -f vite`.

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

Five workflows, each with its own trigger — there is no single publish workflow:

| Workflow | Trigger | Does |
|---|---|---|
| `quality.yml` | PR → `staging` | `rust-check` + `web-check` (the required checks) |
| `e2e.yml` | PR / push / manual | Playwright; the `e2e` job is **not** a required check |
| `staging.yml` | push to `staging` | versions → build → multi-arch manifests → `deploy-staging-gitops` |
| `release.yml` | push to `main` | 15 of 16 jobs gated on `version_changed`; then `promote-production` |
| `deploy.yml` | manual dispatch | deploy any built sha to any env (except `production`) |

**Image naming:** **one** repository, `ghcr.io/<owner>/nession`, with a
per-component tag prefix — not three repositories:

```
ghcr.io/<owner>/nession:server-<short-sha>     # multi-arch manifest
ghcr.io/<owner>/nession:agent-<short-sha>
ghcr.io/<owner>/nession:ui-<short-sha>
```

`<component>-<version>` is the release-lane equivalent. The per-arch
intermediates `<component>-<short-sha>-amd64` / `-arm64` are build artifacts
that `docker buildx imagetools create` (`staging.yml`) folds into the
un-suffixed manifest above — the gitops overlays reference the un-suffixed
tag. There is no branch-name moving tag.

**Build matrix:** `linux/amd64` and `linux/arm64` (multi-arch).

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
| nession-agent | 19090 | WebSocket (P2P terminal) |
| nession-ui | 80 | nginx serving web/dist/ |

**`10080` is nginx, not a Rust listener.** Neither Rust binary opens an HTTP
port or serves `/health` — `grep -rn 10080 crates/` finds nothing. In the image,
`deploy/nginx.conf.template` listens on `${LISTEN_PORT}` (10080), serves
`/health` and `/` (the UI) itself, and proxies `/ws` to the Rust process on
19090 (`deploy/entrypoint-{server,agent}.sh`). So health checks and the UI
belong to the container's nginx; `cargo run` locally has neither.

Default listen addresses differ by how you start it, which is a common trap:

| | address |
|---|---|
| `ServerConfig::default()` | `0.0.0.0:19090` |
| `nession-server` with **no config file** | `127.0.0.1:8080` (`main.rs` `load_config` else-branch) |
| `nession-agent` default | `0.0.0.0:8080` (`config.rs` `default_listen_address`) |

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
```

**⚠ Everything is `--merge`. Nothing is ever rebased or squashed.** A merge commit records the head branch's tip as a second parent, so every branch that lands stays in the target's ancestry with its **original SHAs**; no orphaned commits exist anywhere, and `staging` never needs a force push.

**Why not `--rebase`.** GitHub's rebase-merge **always rewrites the commits and leaves the head branch pointing at the originals**. It rewrites even when nothing forces it to: measured on PR #305, whose branch was already a linear descendant of `main`, the landed commit `787f8be` and the branch tip `39825da` had the *identical* tree `deaf21f4` and differed only because the committer date moved 12:14:04 → 12:16:43.

Those orphans are usually harmless, because a later rebase skips them by patch-id — measured: orphan `67afd56` and its twin `62a5731` both hash to `e56a93b449d8`, and a controlled repro confirmed the replay is skipped. But an orphan whose rebase **resolved a conflict** carries a different patch-id, so it re-applies and re-conflicts on *every* subsequent release until someone drops it by hand. That is not hypothetical: the 0.29.0 release produced exactly one such orphan, `aeb25f8` (`fdf7df10c5d8`) against `8d0125d` (`be13108ebd0b`), from an overlay conflict. `--merge` removes the entire class rather than relying on de-duplication holding.

`--squash` is worse still: N commits collapse into one whose combined patch-id matches nothing, so a later replay re-applies all N. Measured: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

**Branch base.** New work stays on `origin/main` (step 1). The one exception is work that depends on code already on `staging` but not yet released — that bases on `origin/staging` instead.

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

Measured 2026-08-17 on the 0.29.0 release: `staging → main` reported `mergeable: false`, conflicting on `k8s/overlays/staging/kustomization.yaml`; the cherry-pick branch merged cleanly. Note `mergeable: false` blocks every merge method alike, so switching method never routes around a real conflict. That particular conflict came from the rebase flow rewriting an inherited overlay commit, which `--merge` no longer does — so a release conflict should now be rare enough to treat as a genuine content clash worth reading carefully.

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
- **One method everywhere, so ancestry is never rewritten.** Every landed branch stays reachable from the target with its original SHAs — which is why none of the orphan-and-patch-id reasoning that a rebase flow needs applies here.
- **The PR body never enters git history.** `--merge` writes `MERGE_MESSAGE` + `PR_TITLE`, not the body, and each commit keeps its own message. Only squash ever used the body, and nothing squashes. So commit messages are the permanent record — write them properly, and treat the PR body as review material.
- `--auto` only on PRs that have checks. `main`-targeted PRs have none — omit it there.
- Never put an empty commit on `staging`. Trigger workflows with `gh workflow run`, not `git commit --allow-empty`.
- **Never let a feature branch *edit* desired state.** Deploy commits live only on the `gitops` branch and are written solely by `scripts/gitops-commit.sh` (staging.yml / release.yml / deploy.yml) or by a human rollback (`git revert`). A branch touching `gitops` desired state would race the workflows that own it. (The old `k8s/overlays/**` on main is gone — moved to `gitops` in issue #592; the conflict class it caused at release died with it, because deploy commits never touch `main`.)
- **`staging` only ever moves through PRs.** Never push to it directly, and never force-push it.

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

**⚠ If the change alters chrome that a golden screenshot captures, the visual baseline moves in the same change set.** `e2e/specs/__snapshots__/fixture-visual.spec.ts/` holds the canonical baselines (`web-workspace`, `app-terminal`, …), and `FIXTURE_SCREENSHOT.maxDiffPixelRatio = 0.02` is wide enough to swallow a whole chrome change — so a stale baseline keeps passing and the gate silently stops protecting the current UI. Measured: PR #708 replaced the Workspace tool strip with the contextual bar, and the workspace baselines (last regenerated 2026-09-02) still passed.

The principle and the replace-don't-preserve rule live in `docs/design/design-system/validation.md` and `docs/design/migration.md`; this is the operational half:

- Regenerate in CI only — local e2e runs are banned (§ Quality Gates), so `--update-snapshots=all` happens on a CI runner (`CI=true npx playwright test fixture-visual --update-snapshots=all`) and the new golden images are committed. **`=all` is not optional:** a bare `--update-snapshots` means mode `changed`, which still compares through `maxDiffPixelRatio` and rewrites only what fails tolerance — drift smaller than the ratio is skipped, and the run says nothing about it.
- Never widen `maxDiffPixelRatio` to get green. If the diff cannot be explained, find the cause rather than absorbing it.
- Baseline drift that already shipped gets its own issue (see #714) — do not leave it for the next person to rediscover.

```bash
# 1. Start the app locally (server + agent + web)
cargo run -p nession-server &        # ws only; no HTTP/health locally
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
3. **Collect screenshots** via Playwright MCP for any functional UI change, and regenerate any affected golden baseline in the same change set (see **Screenshots with Playwright**)
4. PR to `staging` — 变更内容 + 测试报告 in the body, screenshots in a PR comment. No `Closes #N` here.
5. `gh pr merge <PR> --auto --merge` → verify with `./scripts/deploy-watch.sh staging`
6. Release: PR `staging` → `main` with every `Closes #<ISSUE>` in the body → `gh pr merge <PR> --merge`
7. Version bump only if warranted — see **Development Cycle** step 7
8. `./scripts/deploy-watch.sh prod`

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
- **hook 改动在当前 worktree 里立即生效。** `core.hooksPath` 是**相对值** `.githooks`（实测 `git config --get core.hooksPath` → `.githooks`），git 按各 worktree 自己的根解析它，所以**每个 worktree 跑的是自己那一份 hook**。改了 `.githooks/*` 之后，本 worktree 的下一次提交就走新步骤，不需要等合进 `main`。主检出用的是主检出那一份，两者互不影响。想在提交前单独跑一遍：直接调 `./.githooks/pre-commit`（需先 `git add` 一些文件，否则它因无 staged 内容直接 exit 0）。
- **`pre-commit` 只跑快检查**：`scripts/check-dev-workspace.sh commit`（禁止在根目录/`main` 上提交）→ `just quick`（`cargo fmt --check` → `cargo clippy --workspace -D warnings`）+ `just web-lint`（`eslint --max-warnings 0` → `tsc --noEmit`）。改了 `.rs` 会另跑 `just test-unit` 与 `check-test-isolation`；改到 tmux 面（`*.rs` / `scripts/` / `e2e/` / `deploy/` / `justfile`）跑 `check-tmux-socket`；**改到 design 面**（`design/` / `docs/design/` / `web/src/` / `web/eslint-plugin-nession/` / `.claude/skills/nession-web-design/` / `justfile`）跑 `just design-check fast`。不跑集成测试,不跑覆盖率。
- **`pre-push` 跑测试和覆盖率,且按改动范围收窄**：开头同样跑 `check-dev-workspace.sh push`；改了 `.rs` / `Cargo.{toml,lock}` / `rust-toolchain.toml` / `.cargo/` → `just test` + `just coverage`;改了 `web/**.{ts,tsx,js,css}` **或** 上面那个 design 面 → `just design-check full`,web 改动还跑 `just web-test` + `just web-coverage`。都没改则整个跳过。
- **Canonical design gate（#759）**：`just design-check [fast|full|browser]`（`design/scripts/design-gate.mjs`）是设计约束的**唯一**入口 —— pre-commit 跑 `fast`，pre-push 与 CI 跑 `full`，e2e 跑 `browser`。**hook 与 CI 不各自维护检查清单**，只选 profile；规则清单只由 `design-gate.mjs` 拥有，design 规则本身只由 `web/eslint.config.js` 声明。失败时输出 `DESIGN_SYSTEM_VIOLATION`（file/pattern/rule/actual/expected/owner/repair），按 owner 修，不要用 `eslint-disable`、放宽 contract 或调低视觉阈值消错。
- **手动检查**：`just check-workspace`（或 `./scripts/check-dev-workspace.sh session --fetch`）— Agent/开发者开新任务前确认根目录在最新 `main`、当前在 worktree 里开发。
- **测试并发安全**:测试之间隔离不够,**跑与跑之间**也必须隔离 —— 本仓库多 worktree 并存,CI 也可能和本地同时跑,共享状态会让两轮互相踩,失败看起来像随机的。三条硬规则:
  - 测试监听端口一律 `bind("127.0.0.1:0")` 由 OS 分配,**不准写死端口号,也不准用"预留端口段"** —— 段位在两轮并发时照样撞。需要一个"没人监听"的地址时,用 `free_port()`(bind :0 拿号后释放),helper 命名为 `*_on()`。
  - 每个测试用的数据库/临时文件走 `tempfile::tempdir()`,**不准用 `temp_dir()` 拼固定名**,也不准用"时间戳 + 进程内计数"(两个进程同一秒启动、计数都从 0 开始,拼出同一个路径)。
  - 碰 `paths::nession_home()` 的测试**必须先把 `NESSION_HOME` 指到临时目录** —— 否则它解析成 `$HOME/.nession`,直接改开发者的真实配置。

  **门禁是静态检查**:`just check-test-isolation`(`scripts/check-test-isolation.sh`),已接入 `pre-commit`,改了 `.rs` 就跑,约 1.5 秒。扫描范围是 `crates/*/tests/**` 加上每个 `src/` 文件第一个 `#[cfg(test)]` 之后的部分。`just check-test-isolation-selftest` 逐条注入违规,证明它还真的能抓到 —— 门禁静默失效比没门禁更糟。

- **tmux socket 门禁**:`just check-tmux-socket`(`scripts/check-tmux-socket.sh`),已接入 `pre-commit` 和 `just check`(CI)。拦住任何在 `crates/nession-agent/src/tmux/cmd.rs` 之外派生 tmux 的写法(含 `Command::new(<变量>)` 这种无字面量形态)、`scripts/**` `e2e/**` `deploy/**` `justfile` 里不带 `-S` 的 shell 调用,以及任何 `TMUX_TMPDIR` 赋值。`just check-tmux-socket-selftest` 逐形态注入违规自检。理由与解析规则见「tmux socket 隔离」。

- **协议门禁**:`just check-protocol`(`scripts/protocol-gate.mjs`,~0.3s),已接入 `pre-commit`(改了 `.rs` 或 `web/src/` 就跑)和 `just check`(CI)。**不认识的消息类型是被忽略而不是被拒绝的** —— 所以一个叫错名字的发送方不会报错、不会被拒,它只是永远等下去;**订阅方同样静默** —— `subscribe` 的 wire 拼错,handler 永远不触发,而「handler 没触发」和「推送没来」长得一模一样,这半边直到 #949 才被扫;`agent.env.resource` 就这样活了很久(#913)。**wire 分三类,名字即类别**(#953):操作 `<回答方>.<subject>.<操作>`,一个 runtime 答;通知 `<发出方>.<subject>.<事件>`,一个 runtime 发;控制 `control.<verb>`,**任何** runtime 都可发、**每个** runtime 都要处理。操作是 Protocol Unit,也是 manifest 唯一描述的一类 —— 所以「已声明但不带生成 binding」的 wire 就是通知或控制,前缀再分。规则五条:①调用点命名的 wire 必须按该调用点所在的那一半成立:**发送方**(`send`/`request`/`proto_msg`/`agent_command*`/`new_message`)命名的必须有人**答**,**订阅方**(`subscribe`)命名的必须有人**发** —— 把发送方的问题套到订阅上等于要求一条推送必须有回复,正是 #949 第一次改法误报三条的原因(拼错的报 1a,格式对但没人答/没人发的报 1b,分开是因为修法不同);②每一个被 advertise 的协议都必须有调用方;③`nession_common::protocol` 这条过渡别名路径不许回来(它 re-export 时不带 family/version,正是 Protocol Unit 模型要回答的问题)—— `crates/nession-common/src/protocol.rs` 已删除,恢复 `pub mod protocol;` 会让所有老 import 重新能编译,编译器看不见这一步,所以由门禁看。④通知的第一段必须是真 runtime 名(`server`/`agent`/`client`)—— `agents.changed` 这种没有发出方的拼写就是它要拦的;⑤每条控制 wire 必须在**每个** runtime 的路由表旁边有分支 —— 这是该类别唯一可静态检查的性质,也是它区别于前两类的全部内容(「每个 runtime」= 树里三张表:server 的 `server_routes!`,agent 的 `core_routes!` 与 `p2p_routes!`;浏览器按名订阅、没有表,CLI 不派发,两者不在检查范围内,这一限制写在 `docs/architecture/protocol.md`)。判定集合不在这里维护,读的是生成树(`just check-codegen` 保证它等于契约)+ 那些没有契约承载的 wire 的 `pub const` 声明(通知类由发送它的文件声明,控制类由处理它的文件声明;门禁只从「有路由宏的文件」和「自己拼 `"msg_type"` 信封的文件」里采信声明 —— 全树采信会把任何带点的 `pub const` 都变成广告,那就回到 #913 了)。它以前还会为每条 wire 推导 `<wire>.response` —— 那条拼写随 #953 规则一(一条 wire 一个操作、回复带请求自己的名字、靠 `id` 配对)一并删掉了,推导出来的名字现在没有任何 runtime 会答。**名字是解析出来的,不要求字面量** —— `msg_types::CONTROL_HEARTBEAT` 和 `import { WIRE as ... }` 都比字面量好,要求字面量等于要求更差的写法;报的是「解析不到任何已声明 wire」的名字。例外只有 `subscribe`:它同时是树里每个进程内观察者的名字(`store.subscribe(listener)`、`rt.subscribe(changes)`、socket 层自己的 `router.subscribe(type, …)` 转发口),形状上分不开,所以只把**带点的字面量**当 wire —— 实测去掉这条限制会误报 7 个正确调用点。代价是 4 个写生成 binding 的订阅点(`subscribe(SESSION_LIST_WIRE, …)`)不被读,这是刻意的:那名字就是契约自己的输出,解析出来必然等于它 unit 的 `PROTOCOL`、已在 advertised 集合里,读了也不可能有发现。两个逃生口,每次运行都会打印出来:行级 `// not-protocol: <理由>`,文件头 `// not-protocol-file: <理由>`(用于主题是传输层、wire 本身就是随便起的文件)。被豁免的调用点**仍然算作调用方**。`just protocol-check-selftest` 把每条规则(含 #913 那个形态)注入 fixture 树,要求门禁以该规则失败,并且**每条规则都有一条伴随的反例**(合规的 wire 不许被误报 —— 没有反例的规则正是 #949 那次误报的成因;订阅那组是正反成对的:合规的推送订阅不许被报、拼错的必须被报、非 wire 的 `subscribe` 不许被读) —— 静默失效的门禁会报成功,而成功和「什么都没错」长得一模一样。

  `just check-test-concurrency`(`scripts/check-test-concurrency.sh`,把每个测试二进制同时跑两遍)是**按需诊断工具,不是门禁**。它的价值是发现**未知类别**的共享状态(`NESSION_HOME` 那条就是它找到的,静态检查想不到要查)。但它不适合当门禁:竞态类问题它会漏报(实测同一份坏代码,一次 PASS 一次 FAIL),而并发让整机负载翻倍又可能让时序敏感的测试误报失败 —— 而 hook 不准绕,一次误报就把人卡死。
- **清理测试遗留的 tmux 孤儿**：`./scripts/sweep-test-sessions.sh`（列出）/ `--kill`（整目录回收）。它只认两类项目自有的运行目录 —— Rust 测试的 `$TMPDIR/nession-test-tmux.*` 与 e2e 的 `/tmp/nession-e2e-tmux-*`（目录模式即归属,绝不碰默认 socket 或开发者自己的会话）;目录 `owner.pid` 里的 PID 仍存活（`kill -0`)视为活轮次,列出但不动;对孤儿先做 `#{socket_path}` 断言再 kill-server,再删目录。集成测试的 `TestSession` guard 会在 panic 时自行清理,所以正常退出不该有残留 —— 孤儿只出现在测试进程被 SIGKILL / kill -9 / 崩溃(不走 trap)之后;Ctrl-C 会走 trap,正常清理。
- **CI 触发**：`quality.yml`（PR -> staging:rust-check = `just check` = fmt + lint + check-tmux-socket + check-protocol + check-codegen + coverage,web-check = `just design-check full` + `just web-lint` + `just web-test`）;`staging.yml`（push to staging,纯文档改动经 `paths-ignore` 跳过:完整 build + deploy）;`release.yml`（push to main:release,全部 job 门禁在 `version_changed` 上）。
- **⛔ 禁止任何手段跳过 git hooks**：`git commit --no-verify`、`git push --no-verify`、`--no-gpg-sign`、临时 unset `core.hooksPath` 等一律禁止。测试挂了修测试,覆盖率不够补测试,lint 报错修 lint——不准绕。pre-push hook 跑太久就等着,或者拆分 commit。
- **⛔ 禁止 `TMUX_TMPDIR`,禁止在 `crates/nession-agent/src/tmux/cmd.rs` 之外派生 tmux 进程。** 寻址一律显式 `-S <绝对路径>`;`TMUX_TMPDIR` 在 `$TMUX` 存在时被 tmux 完全无视并静默落回默认 socket(实测 #574)。有静态门禁,详见「tmux socket 隔离」。
- **⛔ 禁止擅自改动 lint 规则**:`[workspace.lints.*]`、`clippy.toml`、命令行 `-A`、`#[allow]` 一律需仓库所有者明确同意后才能改,收紧和放宽都算。报错修代码,不准改规则消错。测试代码同样必须受门禁覆盖,不靠"测试是特例"豁免。详见「Rust linting」。
- **⛔ 禁止 `tmux kill-server`,禁止不带 `-t <name>` 的 `kill-session`。** `kill-session -t <name>` 只允许针对本次自己创建的会话。`kill-server` 唯一例外:脚本对**自有** socket 的清理 —— `-S` 指向自己创建/持有的路径(sweep-test-sessions.sh、tmux-run-socket.sh、e2e teardown),且清理前先做 `#{socket_path}` 断言。需要临时 tmux 一律 `tmux -S /tmp/<唯一名>/sock`,清理前先用 `#{socket_path}` 断言路径。**`TMUX_TMPDIR=` 前缀不是隔离,不准拿它当保险。**
- **⛔ 禁止本地跑 e2e**(`npx playwright test`、为 e2e 跑 `cargo run`)。本地验 UI 只用 `cd web && npm run dev`;查 spec 语法用 `npx playwright test --list`。e2e spec 一律带 `test.skip(!process.env.CI, 'local only — runs in CI workflow only')`。与 §「Screenshots with Playwright」的 Playwright MCP 工具无关,那个照常用。

  以上两条的实测依据与修复进度见 #574、#575。
- **覆盖率阈值**（`scripts/check-coverage.sh` 是唯一来源,每次遍历全部登记的 crate,不按改动收窄）：

  | 目标 | 阈值 |
  |------|------|
  | `nession-common` / `nession-server` | 80% line |
  | `nession-agent` | 80% line（macOS 上 79%，control-mode 测试在 macOS 被跳过） |
  | `nession-cli` | 40% line（不可测的命令已排除） |
  | `nession-claude-code` | 55% line（**地板,不是目标** —— `check-coverage.sh` 里挂着一条 "raise to 80%" 的债务,尚未开 issue） |
  | web（`web/vite.config.ts`） | lines 80%，functions 72%，statements 78%，**branches 65%** |

- **CI 的 web-check 不跑 `just web-coverage`**。web 覆盖率阈值只由本地 pre-push 把关,PR 上没有独立验证。改动 web 代码时不要指望 CI 拦住覆盖率回退。
