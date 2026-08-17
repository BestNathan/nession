---
name: nession-development
description: Use when developing Nession features, writing or running tests, deciding how to bump versions (minor vs patch), creating pull requests, or onboarding to the Nession development workflow
---

# Nession Development

## Overview

Monorepo (Rust workspace + React web UI). Develop locally with `cargo run`/`npm run dev`, test with `cargo test`, version bump in `Cargo.toml` + `web/package.json`, submit changes via PR. Never build Docker images locally — CI handles that.

**⚠ UI/交互改动必须用 Playwright 验证**：任何涉及 WebUI 视觉、交互、布局、终端行为的改动，必须在本地运行完整栈（server + agent + web），通过 Playwright MCP 在浏览器中验证功能正确后才算完成。仅靠单元测试和类型检查不够。

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

## ⛔ Iron Law: Branch Naming Must Trigger CI/CD

```
分支名必须匹配 feat/<slug> 或 fix/<slug>，否则 CI 不会触发。
EnterWorktree 的 name 参数必须使用完整前缀。
```

**CI 触发规则：** `.github/workflows/quality.yml` 在 PR 目标为 `staging` 时触发；`.github/workflows/staging.yml` 在 push 到 `staging` 分支时触发。feat/fix 分支的 PR 必须目标为 `staging`。

| ✅ 正确 | ❌ 错误 | 后果 |
|---------|---------|------|
| `feat/agent-display-name` | `worktree-feat+agent-display-name` | CI 不触发 |
| `feat/add-login` | `feat_add_login` | CI 不触发 |
| `fix/oom-on-attach` | `bugfix/oom` | CI 不触发 |

**创建 worktree 时：**
```bash
# ✅ 正确 — EnterWorktree 传入完整分支名
EnterWorktree name: "feat/<slug>"

# ❌ 错误 — 使用随机名或 worktree- 前缀
EnterWorktree name: "my-feature"
```

**如果分支名已错误：**
```bash
git branch -m <旧名> feat/<正确名>   # 本地重命名
git push -u origin feat/<正确名>      # 推送正确分支
git push origin --delete <旧名>       # 删除旧远程分支
gh pr close <旧PR号>                  # 关闭旧 PR
gh pr create --title "..." --body "..."  # 创建新 PR
```

## 1. Worktree 开发流程

### 为什么必须用 Worktree

- **隔离工作目录** — 不污染 main，不阻塞 main 上的 checkout/pull
- **并行开发** — 多个 feature 可以同时进行，互不干扰
- **自动清理** — worktree 未被修改时自动删除，干净不留痕

### 创建 Worktree 开始开发

```bash
# Claude Code 中直接使用 EnterWorktree 工具创建隔离环境
# 或者手动：feature 分支的 base 是 origin/staging，不是 main
git fetch origin
git worktree add -b feat/<slug> ../nession-<slug> origin/staging
cd ../nession-<slug>
```

**Claude Code 推荐方式** — 使用 `EnterWorktree` 工具（自动创建 worktree + 切换目录）。

### 验证当前环境

开始任何开发前，必须确认你**不在 main 上**：

```bash
git branch --show-current   # 必须显示 feat/<slug>，绝对不能是 "main"
```

### 完成开发后

```bash
# 1. 推送分支，创建 PR
git push -u origin feat/<slug>
gh pr create --title "feat: <description>" --body "..."

# 2. PR 合并后，清理 worktree
git checkout main && git pull
git worktree remove ../nession-<slug>
git worktree prune
git branch -d feat/<slug>
```

**Claude Code 方式** — PR 合并后使用 `ExitWorktree` 退出并清理（action: "remove"）。

### ⚠ 常见违规

| 违规行为 | 正确做法 |
|----------|----------|
| 直接在 main 上 `git checkout -b` | 先确保 main 是干净的（`git status` 无修改），或直接用 worktree |
| 在 main 目录里切分支开发 | 用 `EnterWorktree` 或 `git worktree add` 创建隔离目录 |
| 多个 feature 共用一个 worktree | 每个 feature 独立 worktree，互不干扰 |
| PR 合并后还在旧分支上继续推 commit | 旧 worktree/分支已死，新建 worktree 从最新 main 开始 |
| **分支名不是 `feat/` 或 `fix/` 前缀** | **CI 不会触发！必须用 `feat/<slug>` 或 `fix/<slug>`** |
| **EnterWorktree 未传完整分支名** | 传入 `feat/<slug>` 而非裸名，保证 CI 能触发 |

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

### shadcn/ui Component Conventions

**Before building any new UI pattern, check if shadcn has a primitive for it.**

**📋 Full inventory:** [`references/shadcn-components.md`](references/shadcn-components.md) — installed primitives, custom-component-to-shadcn mapping, priority queue for uninstalled components, golden rules. Always consult this before hand-rolling a layout pattern.

**Golden rules (condensed):**
1. **Check the inventory first** — shadcn likely has a primitive for tabs, tooltips, resizable panels, command palettes, etc.
2. **Install via CLI only** — `npx shadcn@latest add <name> --yes`, never hand-write shadcn components
3. **Custom wrappers are the intended pattern** — thin domain wrappers over shadcn primitives (e.g., `ConnectionStatusBadge` wraps `Badge`)
4. **Destructive confirms → AlertDialog** (not Dialog)
5. **Hand-rolled tab strips → use shadcn Tabs** (duplicated in 5 sites)
6. **Raw resize listeners → use shadcn Resizable** (currently in SidePanel)

**Installed (18 primitives):** AlertDialog, Badge, Button, Card, Checkbox, Collapsible, ContextMenu, Dialog, DropdownMenu, Input, Label, ScrollArea, Select, Separator, Sheet, Skeleton, Sonner, Textarea

**High-priority to install:** Tabs, Resizable, Tooltip, Command

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

### Error Reporting Convention

**All failures in scripts and code MUST include: (1) what happened (原因), (2) how to fix it (解决方案).** Keep it short — just enough to guide the next action.

**Scripts (shell/just):**

```bash
# ❌ Bad — no clue what's wrong
echo "✗ test failed"

# ✅ Good — cause + fix
echo "✗ node_modules/ not found in web/"
echo "  Fix: cd web && npm install"
```

Each script's failure output must answer: *"I see this error. What do I type next?"*

**Rust error messages (anyhow/context):**

```rust
// ❌ Bad — caller doesn't know how to recover
fn load_identity(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).context("failed to read")?;
}

// ✅ Good — tells caller what to do
fn load_identity(path: &Path) -> Result<String> {
    std::fs::read_to_string(path)
        .with_context(|| format!("identity file missing; run agent once to create {path:?}"))?;
}

// ❌ Bad — bare "not found" is useless
anyhow::bail!("not found")

// ✅ Good — actionable
anyhow::bail!("agent not registered; has the agent connected? run: nession-agent --config ...")
```

**CLI/log output:**

```
# ❌ Bad
Error: Connection refused

# ✅ Good
Error: Connection refused (server_url: ws://localhost:19090)
  Fix: start the server → cargo run -p nession-server
       check the URL → verify agent-config.toml server_url field
```

**The rule:** After any failed command, the user should be able to fix it by reading the output — no need to open source code or search logs.

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

**When in doubt, choose patch.** **Four** files must be updated, and they must all agree:

| File | What to change |
|------|----------------|
| `Cargo.toml` | `[workspace.package]` → `version = "0.4.0"` |
| `Cargo.lock` | the `version` entry of each workspace crate (5 of them) |
| `web/package.json` | top-level `"version": "0.4.0"` |
| `web/package-lock.json` | **two** places: the top-level `"version"` and `packages[""].version` |

`Cargo.lock` is not optional — leaving it stale means the next `cargo` invocation rewrites it and dirties the working tree. Refresh it with `cargo metadata --format-version 1 --offline >/dev/null` after editing `Cargo.toml`.

⚠ In `web/package-lock.json`, only change the two entries that belong to `nession-web`. Transitive dependencies can coincidentally carry the same version string (e.g. `@ts-morph/common` was also at `0.27.0`) — a blind find-and-replace corrupts the lockfile.

On merge to main, CI reads the version from `Cargo.toml` and `web/package.json` and creates version-tagged Docker images automatically.

## 5. Development Cycle

**main 只读 → 创建 worktree → 开发 → PR → staging 验收 → 合并到 main 发布 → 清理 worktree → 旧 worktree 已死 → 重复**

```bash
# STEP 1: 从 origin/staging 创建隔离 worktree（不要在 main 目录里开发）
# feature PR 的目标是 staging，所以 base 必须是 origin/staging 而不是 main
# CC 方式：使用 EnterWorktree 工具（推荐）
# 手动方式：
git fetch origin
git worktree add -b feat/<slug> ../nession-<slug> origin/staging
cd ../nession-<slug>

# STEP 2: Develop, test, commit each logical unit

# STEP 3: Verify before push
cargo test
cargo clippy -- -D warnings
cargo fmt --all -- --check
cd web && npm run build && npm run lint && cd ..

# STEP 3.5: Playwright verification (MANDATORY for UI/interaction changes)
# Start the full local stack and use Playwright MCP browser tools
# to functionally verify the change in a real browser.
# See "Playwright Functional Verification" section above.

# STEP 4: Push and create PR targeting staging
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."

# STEP 5: After merge to staging — cleanup. OLD WORKTREE IS DEAD.
# 返回 main 仓库目录，清理 worktree
git checkout main
git pull
git worktree remove ../nession-<slug>
git worktree prune
git branch -d feat/<slug>
```

**⚠ CRITICAL: PR merged = worktree dead.** Never push more commits to a merged branch. Follow-up work — even a one-line fix — starts from a **new worktree** off latest main.

### PR Workflow

Before pushing, **always check** the PR state for the current branch:

```bash
# Check ALL PRs for this branch (open + merged)
gh pr list --head "$(git branch --show-current)" --state all --json number,state,title,url
```

Then follow the decision tree:

```
当前分支的 PR 状态?
├─ 没有 PR → git push + gh pr create（正常流程）
├─ 有 OPEN PR → gh pr edit 更新同一个 PR（继续迭代）
└─ 有 MERGED PR → ⛔ 分支已死！新建分支 + 新 PR
```

| PR 状态 | 操作 | 原因 |
|---------|------|------|
| **无 PR** | `git push` + `gh pr create` | 正常新功能 |
| **OPEN** (未合并) | `gh pr edit` 更新已有 PR | 同一个 PR 继续 review |
| **MERGED** (已合并) | ⛔ 新建 branch/worktree + 新 PR | 已合并的分支已死，不能再推 commit |

**⚠ 常见错误：PR 已合并后继续 `gh pr edit` 往同一个 PR 推 commit**

已合并的 PR 无法通过 `gh pr edit` 追加 commit。GitHub 不会自动重新打开它。正确做法：

```bash
# ❌ 错误 — PR 已合并，再推 commit 也进不了同一个 PR
git commit -m "more changes"
git push                    # commit 推到了已死的远程分支
gh pr edit <old-pr> --body "..."  # 这个 PR 已经合并了！

# ✅ 正确 — 从最新 origin/staging 新建分支，创建全新 PR
git fetch origin
git worktree add -b worktree/<new-slug> ../nession-<new-slug> origin/staging
cd ../nession-<new-slug>
# ... 开发 ...
git push -u origin worktree/<new-slug>
gh pr create --title "..." --body "..."
```

**If an open PR already exists** → update it with `gh pr edit`:

```bash
gh pr edit <PR-NUMBER> --title "..." --body "..."
```

**If no open PR exists** → create a new one:

```bash
git push origin <branch-name>
gh pr create --base staging --title "feat: description" --body "..."
```

**When development is complete**, use auto-merge to merge the feature branch to staging automatically once the quality gate passes:

```bash
# Enable auto-merge for feat/fix PRs targeting staging
gh pr merge <PR-NUMBER> --auto --squash
```

**⚠ `Closes #N` goes in the PR body, and the body becomes the commit message.** The repo sets `squash_merge_commit_message = PR_BODY`, so the squash commit's message *is* the PR description. Closing keywords are ignored outside the default branch, so nothing happens at the staging merge — but `--rebase` carries the message to `main`, where the issue closes. See the `nession-cicd` skill for the full chain and its two caveats.

**Auto-merge to staging is safe** — staging is the integration environment. The quality gate ensures correctness. Human validation happens on staging before the staging → main merge.

**After staging validation**, release to main from a bump branch cut off `origin/staging`:

```bash
# After staging validation passes
git fetch origin
git checkout -b chore/bump-version-X.Y.Z origin/staging
# Bump version in all four files (see "Version Bumping" above)
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "Version bump"
gh pr merge <PR-NUMBER> --rebase  # No --auto: chore/** has no checks, auto-merge is rejected
```

**Do not cut the bump branch from `main`, and do not rebase onto `origin/staging`.** `main` keeps accumulating staging-image-tag commits that never reach `staging`, so that path replays `main`'s own commits onto an older base and conflicts. See `nession-cicd` for the measurement.

**`--rebase` for the bump PR into main; `--squash` for feature PRs into staging.** Squashing at the `staging → main` step destroys the 1:1 patch-id mapping between `staging` and `main`, so already-released work gets replayed on later releases and conflicts as soon as `main` has touched the same files (measured: release PR #268 was squashed, and the next release conflicted on `web/src/terminal/DeviceProfile.ts`). Squashing `feature → staging` is fine — that single commit is what gets rebased onto `main`, patch intact — and it is what lets `Closes #N` reach `main`.

### PR Body Template

**The PR body becomes the squash commit message** (`squash_merge_commit_message = PR_BODY`), so write it as a permanent change record. Screenshots go in a PR comment, never here.

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

Closes #<ISSUE>
```

`Closes #<ISSUE>` in the body is all that is required. It has no effect at the staging merge (closing keywords are ignored outside the default branch), but the body becomes the staging commit message, `--rebase` carries that message to `main`, and GitHub closes the issue there.

One consequence: because the keyword arrives via a commit message rather than a default-branch PR, the issue sidebar will not show a linked PR. The issue still closes. Link it manually via the Development sidebar if that association matters.

Quality gate triggers on PR to staging. After merge to staging, CI builds Docker images, pushes hash tags, updates staging kustomize. After staging validation and merge to main (with version bump), release workflow builds version-tagged images and updates production kustomize.

**Monitor deployment:** Use `./scripts/deploy-watch.sh staging` after merging PR to staging, or `./scripts/deploy-watch.sh prod` after merging to main. See `nession-cicd` skill for details.

### Playwright Functional Verification

**⚠ CRITICAL: Any change involving WebUI interaction, layout, terminal behavior, or visual appearance MUST be verified in a real browser via Playwright MCP before the change is considered complete.** Tests and type checks catch logic errors but cannot verify visual correctness, interaction flows, or terminal rendering — only a real browser can.

This is NOT optional. This is NOT just for screenshots. This is functional verification.

**When Playwright verification is required:**

| Change type | Example | Must verify? |
|-------------|---------|-------------|
| Terminal behavior | Font scaling, resize, input handling, ANSI rendering | ✅ YES |
| UI layout/styling | CSS changes, responsive breakpoints, component sizing | ✅ YES |
| User interaction | Button clicks, form submissions, modal dialogs, keyboard shortcuts | ✅ YES |
| Connection/state | Login flow, reconnection banner, error states | ✅ YES |
| New components | Any new React component | ✅ YES |
| Pure logic (no UI surface) | websocket.ts protocol parsing, utility functions | ❌ No (tests suffice) |
| Config/CI changes | package.json, vite.config.ts, GitHub Actions | ❌ No |

**Setup — start the full local stack:**

```bash
# Use isolated HOME so env/DB files don't pollute ~/.nession
# Terminal 1 — server (WebSocket :19090, HTTP :10080)
HOME=/tmp/nession-demo cargo run -p nession-server

# Terminal 2 — agent (needs tmux)
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml

# Terminal 3 — web (Vite :13000, proxies /ws → :19090)
cd web && npm run dev
```

**Verification workflow:**

```
代码改动 → 启动本地栈 → Playwright 浏览器验证 → 通过 → 继续
                                      ↓ 失败
                                   修复 → 重新验证
```

**Playwright MCP tool reference:**

| Tool | Purpose | Example |
|------|---------|---------|
| `mcp__playwright__browser_navigate` | Open a URL | `http://localhost:13000` |
| `mcp__playwright__browser_snapshot` | Inspect page structure (acc tree) | Find elements, check text content |
| `mcp__playwright__browser_take_screenshot` | Capture visual state | Before/after comparisons |
| `mcp__playwright__browser_click` | Click elements | Buttons, links, toggles |
| `mcp__playwright__browser_type` | Type into fields | Form inputs, terminal text |
| `mcp__playwright__browser_fill_form` | Batch form fill | Login form |
| `mcp__playwright__browser_resize` | Resize viewport | Test responsive behavior |
| `mcp__playwright__browser_press_key` | Press keyboard keys | Test keyboard shortcuts |
| `mcp__playwright__browser_evaluate` | Run JS in page | `localStorage.clear()` |
| `mcp__playwright__browser_console_messages` | Read browser console | Check for JS errors |
| `mcp__playwright__browser_network_requests` | Inspect network traffic | Verify WebSocket messages |

**What to verify (checklist):**

- [ ] **正常流程** — 核心功能在浏览器中按预期工作
- [ ] **交互状态** — 按钮、输入框、模态框有正确的 hover/focus/active 状态
- [ ] **响应式** — `browser_resize` 切换不同视口宽度（375px 手机 / 768px 平板 / 1280px 桌面），布局不出错
- [ ] **终端渲染** — ANSI 颜色、光标、滚动均正常
- [ ] **连接状态** — 断开/重连 banner 显示正确
- [ ] **控制台** — 浏览器 console 无 error/warning（`browser_console_messages`）
- [ ] **网络** — WebSocket 消息类型符合预期，无不必要的消息

**Collecting screenshots (posted as a PR comment, not in the body):**

After functional verification passes, take screenshots of key states:

- Before/after state for each changed feature
- Empty states (no data, no results)
- Loading states (skeletons, spinners)
- Error states (error banners, toasts)
- Key interactions (modal open/close, terminal output)

Save to `.playwright-mcp/screenshots/` (gitignored). Post them as a **PR comment** — the PR body becomes the squash commit message, so image markdown there would land in git history permanently.

```bash
gh pr comment <PR-NUMBER> --body "## 核心功能截图

![feature-name](.playwright-mcp/screenshots/feature-after.png)"
```

## Quick Reference

| Task | Command |
|------|---------|
| Create worktree (CC) | `EnterWorktree` tool |
| Create worktree (manual) | `git worktree add -b feat/<slug> ../nession-<slug> main` |
| Verify not on main | `git branch --show-current` |
| Run all tests | `cargo test` |
| Coverage | `cargo tarpaulin --out Html` |
| TypeScript | `cd web && npx tsc --noEmit` |
| Web build | `cd web && npm run build` |
| Start server | `cargo run -p nession-server` |
| Start UI dev | `cd web && npm run dev` |
| Version bump | Edit `Cargo.toml` + `web/package.json` |
| Cleanup worktree | `git worktree remove <path> && git worktree prune` |
| Check PR state | `gh pr list --head $(git branch --show-current) --state all` |
| Update existing PR | `gh pr edit <N> --title "..." --body "..."` |
| Create PR | `gh pr create --title "feat: ..." --body "..."` |

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| **Committing on `main` directly** | **FORBIDDEN.** main 是只读的。所有开发必须在 worktree 中进行。 |
| **feat/fix PR 直接提交到 main** | **FORBIDDEN.** feat/fix PR 必须提交到 staging。只有 staging → main 的发布 PR 才直接提交到 main。 |
| **在 main 目录中切分支开发** | **FORBIDDEN.** 不要在 main 的 git 目录里 checkout 分支。使用 `EnterWorktree` 或 `git worktree add` 创建隔离的工作目录。 |
| **PR 合并后继续往旧分支推 commit** | **FORBIDDEN.** PR 合并 = worktree/分支已死。任何后续修改都必须从最新 main 创建新 worktree。 |
| **PR 已合并还用 `gh pr edit` 更新** | **FORBIDDEN.** 已合并的 PR 不能追加 commit。必须新建分支 + 新 PR。 |
| `docker build` for Nession | **Forbidden.** CI does that. |
| Pushing to main directly | Always use a feature branch + PR. |
| Reusing a merged branch/worktree | **DEAD.** PR merged = branch/worktree dead. Always create a new worktree from latest main. |
| Bumping only one version file | Both `Cargo.toml` and `web/package.json` must match. |
| Forgetting `cargo fmt`/`cargo clippy` before push | CI may reject the PR. |
| Integration tests leaving temp DB files | Each test must clean up its own DB. |
| PR missing test report or screenshots | All three sections are required. Screenshots MUST be collected via Playwright MCP (not manual screenshots). |
| **Skipping Playwright verification for UI changes** | **FORBIDDEN.** Any UI/interaction change MUST be verified in a real browser with Playwright MCP before pushing. Tests alone are not enough for visual correctness. |
| `#[allow(clippy::*)]` in Rust | **FORBIDDEN.** Every clippy lint must be fixed properly. |
