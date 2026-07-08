---
name: nession-development
description: Use when developing Nession features, writing or running tests, deciding how to bump versions (minor vs patch), creating pull requests, or onboarding to the Nession development workflow
---

# Nession Development

## Overview

Monorepo (Rust workspace + React web UI). Develop locally with `cargo run`/`npm run dev`, test with `cargo test`, version bump in `Cargo.toml` + `web/package.json`, submit changes via PR. Never build Docker images locally — CI handles that.

## ⛔ Iron Law: Never Touch Main

```
主分支 (main) 是只读的。
绝对不要在 main 上直接开发、修改、或提交任何代码。
```

| 规则 | 说明 |
|------|------|
| **main 是只读的** | 永远不要直接 checkout 到 main，更不要在上面做任何修改 |
| **所有开发在 worktree 中进行** | 使用 `EnterWorktree` 创建隔离的工作目录 |
| **一个功能 = 一个 worktree** | 每个 feature/bugfix/release 都从 main 创建独立的 worktree |
| **合并后 worktree 即死** | PR 合并后，对应的 worktree 和分支不再使用 |

## 1. Worktree 开发流程

### 为什么必须用 Worktree

- **隔离工作目录** — 不污染 main，不阻塞 main 上的 checkout/pull
- **并行开发** — 多个 feature 可以同时进行，互不干扰
- **自动清理** — worktree 未被修改时自动删除，干净不留痕

### 创建 Worktree 开始开发

```bash
# Claude Code 中直接使用 EnterWorktree 工具创建隔离环境
# 或者手动：
git checkout main && git pull
git worktree add -b worktree/<slug> ../nession-<slug> main
cd ../nession-<slug>
```

**Claude Code 推荐方式** — 使用 `EnterWorktree` 工具（自动创建 worktree + 切换目录）。

### 验证当前环境

开始任何开发前，必须确认你**不在 main 上**：

```bash
git branch --show-current   # 必须显示 worktree/<slug>，绝对不能是 "main"
```

### 完成开发后

```bash
# 1. 推送分支，创建 PR
git push -u origin worktree/<slug>
gh pr create --title "feat: <description>" --body "..."

# 2. PR 合并后，清理 worktree
git checkout main && git pull
git worktree remove ../nession-<slug>
git worktree prune
git branch -d worktree/<slug>
```

**Claude Code 方式** — PR 合并后使用 `ExitWorktree` 退出并清理（action: "remove"）。

### ⚠ 常见违规

| 违规行为 | 正确做法 |
|----------|----------|
| 直接在 main 上 `git checkout -b` | 先确保 main 是干净的（`git status` 无修改），或直接用 worktree |
| 在 main 目录里切分支开发 | 用 `EnterWorktree` 或 `git worktree add` 创建隔离目录 |
| 多个 feature 共用一个 worktree | 每个 feature 独立 worktree，互不干扰 |
| PR 合并后还在旧分支上继续推 commit | 旧 worktree/分支已死，新建 worktree 从最新 main 开始 |

## 2. Local Development

Three terminals, from repo root:

```bash
# Terminal 1 — server (WebSocket :19090, HTTP :10080)
cargo run -p nession-server

# Terminal 2 — agent (needs tmux on the host)
cargo run -p nession-agent

# Terminal 3 — web UI (Vite dev server :13000, proxies /ws → :19090)
cd web && npm run dev
```

The UI is at `http://localhost:13000`.

```bash
cargo build                    # All Rust crates
cd web && npm run build        # Production web build → web/dist/
cargo fmt -- --check           # Check formatting
cargo clippy -- -D warnings    # Lint
cd web && npx tsc --noEmit     # TypeScript check
cd web && npm run lint         # ESLint
```

## 3. Tests

Rust unit tests go in `#[cfg(test)]` modules inside `src/` or standalone files under `crates/*/tests/`. All async, using `#[tokio::test]`. Web uses `tsc --noEmit` + `eslint` as quality gates (no test runner).

```bash
cargo test                  # All tests (unit + integration)
cargo test -p nession-server  # Single crate
cargo test --test '*'       # Integration tests only
```

### Testing Gates

Before merging any PR, these MUST pass:

| Gate | Command | Threshold |
|------|---------|-----------|
| Unit + integration tests | `cargo test` | 100% pass |
| Coverage (Rust) | `cargo tarpaulin --out Html` | **≥ 90%** line coverage |
| Clippy (no allow) | `cargo clippy -- -D warnings` | 0 warnings, **zero** `#[allow]` |
| Formatting | `cargo fmt -- --check` | clean |
| Web unit tests | `cd web && npm test` | 100% pass |
| Web coverage | `cd web && npm run coverage` | **≥ 80%** line coverage |
| TypeScript | `cd web && npx tsc --noEmit` | 0 errors |
| ESLint | `cd web && npm run lint` | 0 warnings |
| Build | `cd web && npm run build` | success |

Coverage is enforced per-crate. New code must maintain or improve coverage — PRs that drop coverage below 90% are rejected.

```bash
# Install tarpaulin (once)
cargo install cargo-tarpaulin

# Run coverage
cargo tarpaulin --out Html --output-dir target/tarpaulin
```

### Test Database

Integration tests use SQLite with unique temporary databases. Each test MUST clean up its own DB file:

```rust
let db_path = format!("./test_{}.db", uuid::Uuid::new_v4());
// ... run test ...
std::fs::remove_file(&db_path).ok();
```

## 4. Version Bumping

Single version across all components. `Cargo.toml` and `web/package.json` must always agree.

| Change | Bump | Example |
|--------|------|---------|
| New feature, behavior change | Minor | `0.3.1` → `0.4.0` |
| Bug fix, small tweak | Patch | `0.3.1` → `0.3.2` |

**When in doubt, choose patch.** Both files must be updated:

```toml
# Cargo.toml
version = "0.4.0"
```

```json
// web/package.json
"version": "0.4.0"
```

On merge to main, CI reads the version from these files and creates version-tagged Docker images automatically.

## 5. Development Cycle

**main 只读 → 创建 worktree → 开发 → PR → 合并 → 清理 worktree → 旧 worktree 已死 → 重复**

```bash
# STEP 1: 从 main 创建隔离 worktree（不要在 main 目录里开发）
# CC 方式：使用 EnterWorktree 工具（推荐）
# 手动方式：
git checkout main
git pull
git worktree add -b worktree/<slug> ../nession-<slug> main
cd ../nession-<slug>

# STEP 2: Develop, test, commit each logical unit

# STEP 3: Verify before push
cargo test
cargo clippy -- -D warnings
cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# STEP 4: Push and create PR
git push -u origin worktree/<slug>
gh pr create --title "feat: <description>" --body "..."

# STEP 5: After merge — cleanup. OLD WORKTREE IS DEAD.
# 返回 main 仓库目录，清理 worktree
git checkout main
git pull
git worktree remove ../nession-<slug>
git worktree prune
git branch -d worktree/<slug>
```

**⚠ CRITICAL: PR merged = worktree dead.** Never push more commits to a merged branch. Follow-up work — even a one-line fix — starts from a **new worktree** off latest main.

### PR Workflow

Before creating a PR, **always check** whether the current branch already has an open PR:

```bash
# List open PRs for the current branch
gh pr list --head "$(git branch --show-current)" --state open --json number,title,url
```

**If an open PR already exists** → update it with `gh pr edit`:

```bash
gh pr edit <PR-NUMBER> --title "..." --body "..."
```

**If no open PR exists** → create a new one:

```bash
git push origin <branch-name>
gh pr create --title "feat: description" --body "..."
```

### PR Body Template

Every PR must include these three sections:

```markdown
## 变更内容
- [简述改了什么]

## 测试报告
- `cargo test`: <N> passed, 0 failed
- `cargo tarpaulin`: <X>% coverage (threshold: 90%)
- `cargo fmt --all -- --check`: OK
- `cargo clippy -- -D warnings`: 0 errors
- `npm test`: <N> passed
- `npm run coverage`: <X>% (threshold: 80%)
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success

## 核心功能截图
<!-- 使用 Playwright MCP 收集，展示变更前后 UI 效果 -->
<!-- 命令：mcp__playwright__browser_navigate → browser_snapshot → browser_take_screenshot -->
```

CI triggers on merge to main — builds multi-arch Docker images, pushes tags, updates k8s manifests. No manual steps after merge.

### Screenshot Collection (Playwright MCP)

**Mandatory after any functional UI change.** Use Playwright MCP browser tools to capture before/after screenshots for the PR body.

```bash
# 1. Start the full stack locally (3 terminals)
cargo run -p nession-server &          # WebSocket :19090, HTTP :10080
cargo run -p nession-agent &            # needs tmux on host
cd web && npm run dev                   # Vite :13000, proxies /ws → :19090
```

Then use Playwright MCP tools:

| Step | Tool | Purpose |
|------|------|---------|
| Open app | `mcp__playwright__browser_navigate` → `http://localhost:13000` | Load the web UI |
| Inspect page | `mcp__playwright__browser_snapshot` | Find elements to interact with |
| Type text | `mcp__playwright__browser_type` | Fill search inputs, forms |
| Click elements | `mcp__playwright__browser_click` | Simulate button clicks, navigation |
| Fill forms | `mcp__playwright__browser_fill_form` | Batch form interactions |
| Screenshot | `mcp__playwright__browser_take_screenshot` | Capture page as PNG |

**What to screenshot:**
- Before/after state for each changed feature
- Empty states (no data, no results)
- Loading states (skeletons, spinners)
- Error states (error banners, toasts)
- Key interactions (search, filter, modal open/close, sort toggle)

Place screenshots in the PR body under **核心功能截图** using markdown image syntax.

## Quick Reference

| Task | Command |
|------|---------|
| Create worktree (CC) | `EnterWorktree` tool |
| Create worktree (manual) | `git worktree add -b worktree/<slug> ../nession-<slug> main` |
| Verify not on main | `git branch --show-current` |
| Run all tests | `cargo test` |
| Coverage | `cargo tarpaulin --out Html` |
| TypeScript | `cd web && npx tsc --noEmit` |
| Web build | `cd web && npm run build` |
| Start server | `cargo run -p nession-server` |
| Start UI dev | `cd web && npm run dev` |
| Version bump | Edit `Cargo.toml` + `web/package.json` |
| Cleanup worktree | `git worktree remove <path> && git worktree prune` |
| Create PR | `gh pr create --title "feat: ..." --body "..."` |

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| **Committing on `main` directly** | **FORBIDDEN.** main 是只读的。所有开发必须在 worktree 中进行。 |
| **在 main 目录中切分支开发** | **FORBIDDEN.** 不要在 main 的 git 目录里 checkout 分支。使用 `EnterWorktree` 或 `git worktree add` 创建隔离的工作目录。 |
| **PR 合并后继续往旧分支推 commit** | **FORBIDDEN.** PR 合并 = worktree/分支已死。任何后续修改都必须从最新 main 创建新 worktree。 |
| `docker build` for Nession | **Forbidden.** CI does that. |
| Pushing to main directly | Always use a feature branch + PR. |
| Reusing a merged branch/worktree | **DEAD.** PR merged = branch/worktree dead. Always create a new worktree from latest main. |
| Bumping only one version file | Both `Cargo.toml` and `web/package.json` must match. |
| Forgetting `cargo fmt`/`cargo clippy` before push | CI may reject the PR. |
| Integration tests leaving temp DB files | Each test must clean up its own DB. |
| PR missing test report or screenshots | All three sections are required. Screenshots MUST be collected via Playwright MCP (not manual screenshots). |
| `#[allow(clippy::*)]` in Rust | **FORBIDDEN.** Every clippy lint must be fixed properly. |
