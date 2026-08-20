# 测试三层化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将仓库的 1669 个测试按契约分为单元/集成/E2E 三层，补建 E2E 套件，清理陈旧 coverage exclude，固化 `test-inventory.sh` 作为迁移安全网。

**Architecture:** Rust 侧通过 `--lib`（单元）和 `--test integration`（集成）天然分层；Web 侧通过 `__tests__/unit/` 与 `__tests__/integration/` 子目录 + vitest projects 分层；E2E 层用 Playwright 独立套件。所有分层操作由 `scripts/test-inventory.sh` 的 TOTAL=1669 不变量守护。

**Tech Stack:** Rust cargo test, vitest 4.1.9, Playwright, cargo-llvm-cov, bash scripting

**Spec:** `docs/superpowers/specs/2026-08-19-test-layering-design.md`

---

## 关键约束（实施前必读）

### 1. `--test integration` 必须先有 target 才能用

已实测：`cargo test --workspace --test integration` 在所有 crate 都没有该 target 时报错 `no test target named 'integration'`。**这意味着 justfile 的 `test-integration` recipe 不能早于第一个 `tests/integration/main.rs` 的创建。**

应对：PR 1 的 justfile 改动只加 `test-unit` 和 `unit` recipe，`test-integration` 在每个 crate 创建完 harness 后才加（分三步：server → agent → cli）。每个 crate 创建 harness 后立即验证 `cargo test -p <crate> --test integration` 能跑。

### 2. `filtered-test.sh` 和 `filtered-web-test.sh` 必须透传参数

现有脚本写死了 cargo/vitest 参数。新的 `test-unit`（`--lib`）和 `test-integration`（`--test integration`）需要透传到 cargo；`web-test-unit`（`--project unit`）和 `web-test-integration`（`--project integration`）需要透传到 vitest。

改动：
- `filtered-test.sh`：`cargo test --workspace --color=always` → `cargo test --workspace --color=always "$@"`
- `filtered-web-test.sh`：去掉 `if [ "$1" = "--coverage" ]` 分支，直接 `npx vitest run "$@"`（vitest 自己认 `--coverage`）

### 3. Rust 搬迁不删测试

所有测试只移动、不删除。即使语义重叠（如 `protocol::test_message_new` 和 `protocol::tests::test_message_new`）也保留两份。理由：`test-inventory.sh` 无法区分"搬丢了"和"故意删了"。剪枝另开 PR。

### 4. Web import 改写先于文件移动

`rewrite-test-imports.py --apply` 把 `from '../foo'` 改成 `from '@/foo'`，在原位置做。别名是深度无关的，所以改写后再移动文件不需要再改 import。顺序反了会导致中间状态有 broken import。

### 5. pre-commit 已经按改动范围收窄

`.githooks/pre-commit` 第 10-12 行读 `git diff --cached --name-only`，第 21/32 行用 `[ -n "$STAGED_RUST" ]` / `[ -n "$STAGED_TSX" ]` 守卫。新增的 `just test-unit` 和 `just web-test-unit` 放进这两个既有分支，范围收窄自动继承。没有"pre-commit 不收窄"的缺陷。

### 6. `--skip full_chain` 必须删除

改名 `e2e_test.rs` → `full_chain.rs` 后，libtest 的 `--skip full_chain`（子串匹配）会把 7 个测试全跳过，而非预期的 1 个。它现在已经冗余（唯一想跳的 `test_terminal_io_through_full_chain` 已被 `--skip terminal_io` 匹配），直接删。

---

## 文件结构（最终态）

### Rust 侧

```
crates/nession-server/tests/integration/
├── main.rs              # mod 声明 + current_timestamp helper
├── db.rs                # ← db_test.rs
├── websocket.rs         # ← websocket_test.rs（删 std::time import）
├── handler.rs           # ← handler_test.rs
├── agent_registry.rs    # ← agent_registry_test.rs
├── session_registry.rs  # ← session_registry_test.rs
├── session_command.rs   # ← session_command_test.rs
├── command_broker.rs    # ← command_broker_test.rs
├── relay.rs             # ← relay_integration_test.rs（保留 unique_session_name）
└── full_stack.rs        # ← integration_test.rs（删 std::time import）

crates/nession-agent/tests/integration/
├── main.rs              # mod 声明 + unique_session_name（4 处相同定义）
├── connection.rs        # ← connection_test.rs
├── control_mode.rs      # ← control_mode_test.rs（保留私有 unique_session_name）
├── server.rs            # ← server_test.rs（删 std::time import）
├── sync.rs              # ← sync_test.rs（删 std::time import）
├── tmux.rs              # ← tmux_test.rs
└── full_chain.rs        # ← e2e_test.rs（改名）

crates/nession-cli/tests/integration/
├── main.rs
├── attach_session.rs    # ← attach_session_test.rs
├── client_commands.rs   # ← client_commands_test.rs
├── session_commands.rs  # ← session_commands_test.rs
└── update.rs            # ← update_integration.rs

crates/nession-common/src/
├── config.rs            # + 内联 tests from config_test.rs
├── paths.rs             # + 内联 tests from paths_test.rs（6 个重命名为 _exact）
└── protocol_tests.rs    # ← protocol_test.rs（sibling mod，不是 mod.rs）

crates/nession-common/src/protocol.rs
└── 末尾加 `#[cfg(test)] mod protocol_tests;`（与已有 mod tests 并存）

crates/nession-agent/src/
└── config.rs            # + 内联 tests from config_test.rs

crates/nession-agent/src/terminal/
└── raw.rs               # + 内联 tests from terminal_test.rs（删重复的 crossterm import）

crates/nession-server/src/
├── broker.rs            # + 内联 tests from broker_test.rs
└── server/client_registry.rs  # + 内联 tests from client_registry_test.rs

crates/nession-claude-code/src/
├── scanner.rs           # + 内联 tests from scanner_tests.rs（保留 use std::path::PathBuf）
├── security.rs          # + 内联 tests from security_tests.rs
└── agent.rs             # + 内联 pagination_logic from handler_tests.rs（登记为欠账）
```

### Web 侧

```
web/src/
├── lib/__tests__/unit/
│   ├── auth.test.ts
│   ├── storage.test.ts
│   ├── url.test.ts
│   ├── constants.test.ts
│   ├── retry.test.ts
│   ├── format.test.ts
│   ├── validation.test.ts
│   ├── debounce.test.ts
│   └── throttle.test.ts
├── atoms/__tests__/unit/
│   ├── sessionAtom.test.ts
│   ├── agentAtom.test.ts
│   └── uiAtom.test.ts
├── services/__tests__/unit/
│   ├── agentService.test.ts
│   ├── sessionService.test.ts
│   ├── commandService.test.ts
│   └── fileService.test.ts
├── services/websocket/__tests__/unit/
│   └── messageBus.test.ts
├── services/websocket/plugins/__tests__/unit/
│   ├── authPlugin.test.ts
│   ├── heartbeatPlugin.test.ts
│   └── eventPlugin.test.ts
├── terminal/__tests__/unit/
│   ├── DeviceProfile.test.ts
│   ├── TerminalTheme.test.ts
│   ├── AnsiParser.test.ts
│   ├── Buffer.test.ts
│   ├── Renderer.test.ts
│   └── InputHandler.test.ts
├── terminal/state/__tests__/unit/
│   ├── connectionState.test.ts
│   ├── sessionState.test.ts
│   ├── agentState.test.ts
│   ├── terminalState.test.ts
│   ├── fileBrowserState.test.ts
│   └── quickCommandsState.test.ts
├── terminal/input/__tests__/unit/
│   ├── keyBindings.test.ts
│   ├── keyMapper.test.ts
│   ├── mouseHandler.test.ts
│   ├── pasteHandler.test.ts
│   └── shortcutHandler.test.ts
├── terminal/instance/__tests__/unit/
│   └── terminalInstance.test.ts
├── terminal/controller/__tests__/unit/
│   └── terminalController.test.ts
├── components/__tests__/unit/
│   └── quickCommands.test.ts
├── components/env/__tests__/unit/
│   └── envRef.test.ts
├── components/__tests__/integration/
│   ├── AgentCard.test.tsx
│   ├── SessionList.test.tsx
│   ├── CreateSessionDialog.test.tsx
│   ├── KillConfirmDialog.test.tsx
│   ├── TerminalToolbar.test.tsx
│   ├── SearchBar.test.tsx
│   ├── AgentSummaryBar.test.tsx
│   ├── FeaturesCard.test.tsx
│   ├── LoginPage.test.tsx
│   ├── Dashboard.test.tsx
│   ├── FileBrowser.test.tsx
│   ├── FileTabs.test.tsx
│   ├── FileViewer.test.tsx
│   ├── FileTabs.test.tsx
│   ├── FileViewer.test.tsx
│   ├── EnvPanel.test.tsx
│   ├── QuickCommandsPanel.test.tsx
│   ├── InputPanel.test.tsx
│   ├── DashboardHeader.test.tsx
│   ├── ModeBar.test.tsx
│   ├── SessionsSection.test.tsx
│   ├── RenderTerminal.test.tsx
│   ├── TerminalBanner.test.tsx
│   ├── TerminalTabs.test.tsx
│   ├── TerminalBanner.test.tsx
│   ├── EnvUploadDialog.test.tsx
│   └── EnvInlineEditor.test.tsx
├── hooks/__tests__/integration/
│   ├── useAgents.test.ts
│   ├── useSessions.test.ts
│   ├── useTerminal.test.ts
│   ├── useFileBrowser.test.ts
│   ├── useQuickCommands.test.ts
│   ├── useProbePolling.test.ts
│   ├── useVisibilityReconnect.test.ts
│   ├── useDeepLinkRestore.test.ts
│   ├── useSwipeGesture.test.ts
│   ├── useTerminalStateMachine.test.ts
│   ├── useEnvManager.test.ts
│   └── useDashboardHandlers.test.ts
├── components/env/__tests__/integration/
│   ├── EnvManager.test.tsx
│   ├── EnvPanel.test.tsx
│   ├── EnvUploadDialog.test.tsx
│   └── EnvInlineEditor.test.tsx
├── terminal/components/__tests__/integration/
│   ├── TerminalView.test.tsx
│   └── TerminalWorkspace.test.tsx
├── terminal/components/input/__tests__/integration/
│   └── TerminalInput.test.tsx
├── terminal/hooks/__tests__/integration/
│   └── useTerminalInput.test.ts
├── extensions/claude-code/components/__tests__/integration/
│   └── ClaudeCodeSection.test.tsx
└── App.test.tsx          # ← 移到 integration
```

### E2E

```
e2e/
├── package.json
├── playwright.config.ts
├── fixtures/
│   ├── server/
│   │   └── config.toml       # listen_address = "127.0.0.1:19090", auth_token = ""
│   └── agent-config.e2e.toml # listen_address = "127.0.0.1:19091", server_url = "ws://127.0.0.1:19090/ws"
├── helpers/
│   ├── reset.ts              # 清 localStorage + sessionStorage
│   └── dashboard.ts          # 等待 [data-testid="filter-row"] 出现
└── specs/
    ├── login.spec.ts         # 真实表单：填 #serverUrl + #authToken → 点 Connect → dashboard 出现
    ├── session-lifecycle.spec.ts  # agent 卡片 → 建 session → 列表出现 → kill → 列表消失
    └── terminal-io.spec.ts   # attach → 输入 echo nession-e2e-ok → 终端出现该输出；P2P 和 relay 各跑一遍
```

---

## Phase 1: Rust 分层 + inventory + justfile（PR 1）

**目标：** 建立迁移安全网、完成 Rust 侧分层、更新 justfile、登记 claude-code 覆盖率。

**验证：** `./scripts/test-inventory.sh --check 1669` 通过；`just test-unit` 和 `just test-integration` 都绿灯。

### Task 1.1: 建立 `test-inventory.sh` + 基线

**Files:**
- Create: `scripts/test-inventory.sh`（从 `/tmp/test-inventory.sh` 复制）
- Create: `docs/superpowers/plans/2026-08-19-test-layering-inventory-baseline.txt`

- [ ] **Step 1: 创建 inventory 脚本**

```bash
cp /tmp/test-inventory.sh scripts/test-inventory.sh
chmod +x scripts/test-inventory.sh
```

- [ ] **Step 2: 验证脚本能跑 + 记录基线**

```bash
./scripts/test-inventory.sh | tee docs/superpowers/plans/2026-08-19-test-layering-inventory-baseline.txt
./scripts/test-inventory.sh --check 1669
echo $?  # 应为 0
```

预期输出：
```
rust/unit                548
rust/integration         240
web/unit                   0  (pre-migration, layer not yet in path)
web/integration            0  (pre-migration, layer not yet in path)
web/unclassified         881  (pre-migration, layer not yet in path)
e2e                        0
TOTAL                   1669

✓ total matches baseline (1669)
```

- [ ] **Step 3: 提交**

```bash
git add scripts/test-inventory.sh docs/superpowers/plans/2026-08-19-test-layering-inventory-baseline.txt
git commit -m "chore: add test-inventory.sh + baseline for layering migration

The invariant is TOTAL=1669, not per-layer numbers. Layering deliberately
moves tests between layers; the total must not move at all.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.2: 改造 `filtered-test.sh` 和 `filtered-web-test.sh` 透传参数

**Files:**
- Modify: `scripts/filtered-test.sh:9`
- Modify: `scripts/filtered-web-test.sh:28-36`

- [ ] **Step 1: 改 filtered-test.sh 透传 `"$@"`**

```bash
sed -i.bak 's|cargo test --workspace --color=always|cargo test --workspace --color=always "$@"|' scripts/filtered-test.sh
rm scripts/filtered-test.sh.bak
```

验证：
```bash
grep 'cargo test --workspace' scripts/filtered-test.sh
# 应输出：cargo test --workspace --color=always "$@"
```

- [ ] **Step 2: 改 filtered-web-test.sh 透传 `"$@"`**

读 `scripts/filtered-web-test.sh`，把 28-36 行的 `if [ "${1:-}" = "--coverage" ]` 分支改成：

```bash
output=$(npx vitest run "$@" --reporter=default 2>&1)
rc=$?
```

验证：
```bash
grep -A2 'npx vitest run' scripts/filtered-web-test.sh
# 应输出：npx vitest run "$@" --reporter=default
```

- [ ] **Step 3: 验证改动不破既有行为**

```bash
./scripts/filtered-test.sh              # 应和改前一样
./scripts/filtered-web-test.sh          # 应和改前一样
./scripts/filtered-web-test.sh --coverage  # 应和改前一样
```

- [ ] **Step 4: 提交**

```bash
git add scripts/filtered-test.sh scripts/filtered-web-test.sh
git commit -m "refactor: make test filter scripts forward args to cargo/vitest

Preparation for layered test recipes (--lib, --test integration,
--project unit/integration). The scripts still apply their diagnostics
filters; they just no longer hardcode the cargo/vitest invocation.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.3: justfile 加 `test-unit` + `unit` recipe

**Files:**
- Modify: `justfile:15-18`

- [ ] **Step 1: 加 `test-unit` 和 `unit` recipe**

读 `justfile`，在 `test:` recipe 前加：

```makefile
# Unit tests only (pre-commit)
test-unit:
    ./scripts/filtered-test.sh --lib
```

把 `pre-push:` 改前加：

```makefile
# Unit tests for both Rust and web (pre-commit)
unit: test-unit web-test-unit
```

注意：**此时不加 `test-integration`**，因为还没有任何 crate 有 `tests/integration/` target（实测会报错）。等 Task 1.4 创建第一个 harness 后再加。

- [ ] **Step 2: 验证 `test-unit` 能跑**

```bash
just test-unit
# 应跑 548 个单元层测试（现状）
```

- [ ] **Step 3: 验证 `unit` 能跑（此时会失败，因为 web 还没分层）**

暂时跳过，等 Task 1.9 后再验证。

- [ ] **Step 4: 提交**

```bash
git add justfile
git commit -m "feat(justfile): add test-unit recipe for Rust unit layer

Runs cargo test --workspace --lib via filtered-test.sh. Part of the
test layering refactor; see spec for the full plan.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.4: nession-server 创建 `tests/integration/` harness

**Files:**
- Create: `crates/nession-server/tests/integration/main.rs`
- Move + rename: `crates/nession-server/tests/db_test.rs` → `crates/nession-server/tests/integration/db.rs`
- Move + rename: `crates/nession-server/tests/websocket_test.rs` → `crates/nession-server/tests/integration/websocket.rs`
- Move + rename: `crates/nession-server/tests/handler_test.rs` → `crates/nession-server/tests/integration/handler.rs`
- Move + rename: `crates/nession-server/tests/agent_registry_test.rs` → `crates/nession-server/tests/integration/agent_registry.rs`
- Move + rename: `crates/nession-server/tests/session_registry_test.rs` → `crates/nession-server/tests/integration/session_registry.rs`
- Move + rename: `crates/nession-server/tests/session_command_test.rs` → `crates/nession-server/tests/integration/session_command.rs`
- Move + rename: `crates/nession-server/tests/command_broker_test.rs` → `crates/nession-server/tests/integration/command_broker.rs`
- Move + rename: `crates/nession-server/tests/relay_integration_test.rs` → `crates/nession-server/tests/integration/relay.rs`
- Move + rename: `crates/nession-server/tests/integration_test.rs` → `crates/nession-server/tests/integration/full_stack.rs`

- [ ] **Step 1: 创建 `tests/integration/main.rs`**

```rust
// Single harness for all nession-server integration tests.
// cargo discovers this automatically and names the target `integration`.

mod db;
mod websocket;
mod handler;
mod agent_registry;
mod session_registry;
mod session_command;
mod command_broker;
mod relay;
mod full_stack;

// ── Shared helpers ───────────────────────────────────────────────────────────

// current_timestamp: defined in both websocket.rs and full_stack.rs (byte-identical).
// Extract to crate root, delete the duplicates, and trim unused std::time imports.
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_secs()
}
```

- [ ] **Step 2: 移动文件 + 改 mod 声明**

```bash
cd crates/nession-server/tests
mkdir integration
mv db_test.rs integration/db.rs
mv websocket_test.rs integration/websocket.rs
mv handler_test.rs integration/handler.rs
mv agent_registry_test.rs integration/agent_registry.rs
mv session_registry_test.rs integration/session_registry.rs
mv session_command_test.rs integration/session_command.rs
mv command_broker_test.rs integration/command_broker.rs
mv relay_integration_test.rs integration/relay.rs
mv integration_test.rs integration/full_stack.rs
```

- [ ] **Step 3: 适配 import + 提取 helper**

逐个文件读 + 改：

**websocket.rs:**
```bash
# 删 use std::time::{SystemTime, UNIX_EPOCH};（helper 搬到 main.rs）
# 删 fn current_timestamp() 定义
# 加 use super::current_timestamp;
# 改 use nession_server::… → use crate::…（如果有的话）
```

**full_stack.rs:**
```bash
# 同上：删 std::time import + current_timestamp 定义，加 use super::current_timestamp;
# TestServer 定义不动（仅 1 处定义，无重复）
```

**relay.rs:**
```bash
# unique_session_name 定义保留（仅 1 处定义，无重复）
```

其余 6 个文件（db/handler/agent_registry/session_registry/session_command/command_broker）只做移动，不改内容（它们没有 helper 重复）。

- [ ] **Step 4: 验证 `cargo test -p nession-server --test integration` 能跑**

```bash
cargo test -p nession-server --test integration --no-run
cargo test -p nession-server --test integration
```

预期：编译通过，111 个集成测试全跑（与搬前 `cargo test -p nession-server` 的 `tests/` 部分一致）。

- [ ] **Step 5: 验证 inventory 不变**

```bash
./scripts/test-inventory.sh --check 1669
```

- [ ] **Step 6: 提交**

```bash
git add crates/nession-server/tests/
git commit -m "refactor(server): consolidate integration tests under tests/integration/

Single harness (main.rs) replaces 9 separate test binaries. cargo
automatically discovers tests/integration/main.rs and names the target
'integration'. Helper dedup: current_timestamp extracted to main.rs;
std::time imports trimmed from websocket.rs and full_stack.rs.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.5: nession-agent 创建 `tests/integration/` harness

**Files:**
- Create: `crates/nession-agent/tests/integration/main.rs`
- Move + rename: 6 个文件（见上文）

- [ ] **Step 1: 创建 `tests/integration/main.rs`**

```rust
// Single harness for all nession-agent integration tests.

mod connection;
mod control_mode;
mod server;
mod sync;
mod tmux;
mod full_chain;  // ← e2e_test.rs renamed (spec: Rust has no E2E layer)

// ── Shared helpers ───────────────────────────────────────────────────────────

// unique_session_name: defined 5× across the 6 files, 4 of them byte-identical.
// Extract to crate root. control_mode's copy differs (extra ctrl- segment) and
// stays module-private.
use rand::Rng;

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{}-{}", prefix, suffix)
}
```

- [ ] **Step 2: 移动文件 + 改名**

```bash
cd crates/nession-agent/tests
mkdir integration
mv connection_test.rs integration/connection.rs
mv control_mode_test.rs integration/control_mode.rs
mv server_test.rs integration/server.rs
mv sync_test.rs integration/sync.rs
mv tmux_test.rs integration/tmux.rs
mv e2e_test.rs integration/full_chain.rs  # ← 改名，消除 "e2e" 歧义
```

- [ ] **Step 3: 适配 import + 提取 helper**

**connection.rs / server.rs / sync.rs / tmux.rs:**
```bash
# 删 fn unique_session_name() 定义
# 加 use super::unique_session_name;
# server.rs / sync.rs: 删 use std::time::{SystemTime, UNIX_EPOCH};（如果有的话，helper 搬走导致未使用）
```

**control_mode.rs:**
```bash
# unique_session_name 定义保留（语义不同：前缀多 ctrl-）
# 不引用 super 版本
```

**full_chain.rs:**
```bash
# 删 fn unique_session_name() 定义
# 加 use super::unique_session_name;
```

- [ ] **Step 4: 删除 `--skip full_chain`**

读 `scripts/check-coverage.sh`，删第 91 行的 `--skip full_chain`（已冗余，且改名后会误跳 7 个测试）。

```bash
sed -i.bak 's|--skip terminal_io --skip full_chain|--skip terminal_io|' scripts/check-coverage.sh
rm scripts/check-coverage.sh.bak
```

验证：
```bash
grep SKIP_FLAGS scripts/check-coverage.sh
# 应输出：SKIP_FLAGS="--skip terminal_io"
```

- [ ] **Step 5: 验证 `cargo test -p nession-agent --test integration` 能跑**

```bash
cargo test -p nession-agent --test integration --no-run
cargo test -p nession-agent --test integration
```

预期：编译通过，45 个集成测试全跑。

- [ ] **Step 6: 验证 inventory 不变**

```bash
./scripts/test-inventory.sh --check 1669
```

- [ ] **Step 7: 提交**

```bash
git add crates/nession-agent/tests/ scripts/check-coverage.sh
git commit -m "refactor(agent): consolidate integration tests + rename e2e_test → full_chain

Single harness (main.rs) replaces 6 separate test binaries. e2e_test.rs
renamed to full_chain.rs — per spec, Rust has no E2E layer, eliminating
the name collision with the upcoming Playwright suite.

Helper dedup: unique_session_name extracted to main.rs (4 identical
defs); control_mode's copy differs (extra ctrl- segment) and stays
module-private. std::time imports trimmed from server.rs and sync.rs.

Coverage: --skip full_chain deleted — it was redundant with --skip
terminal_io, and the rename would have caused it to skip 7 tests
instead of 1 (libtest --skip is substring match on full path).

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.6: nession-cli 创建 `tests/integration/` harness

**Files:**
- Create: `crates/nession-cli/tests/integration/main.rs`
- Move + rename: 4 个文件

- [ ] **Step 1: 创建 `tests/integration/main.rs`**

```rust
// Single harness for all nession-cli integration tests.

mod attach_session;
mod client_commands;
mod session_commands;
mod update;
```

- [ ] **Step 2: 移动文件**

```bash
cd crates/nession-cli/tests
mkdir integration
mv attach_session_test.rs integration/attach_session.rs
mv client_commands_test.rs integration/client_commands.rs
mv session_commands_test.rs integration/session_commands.rs
mv update_integration.rs integration/update.rs
```

无 helper 重复，只改文件名。

- [ ] **Step 3: 验证 `cargo test -p nession-cli --test integration` 能跑**

```bash
cargo test -p nession-cli --test integration --no-run
cargo test -p nession-cli --test integration
```

预期：编译通过，41 个集成测试全跑。

- [ ] **Step 4: 验证 inventory 不变**

```bash
./scripts/test-inventory.sh --check 1669
```

- [ ] **Step 5: 提交**

```bash
git add crates/nession-cli/tests/
git commit -m "refactor(cli): consolidate integration tests under tests/integration/

Single harness (main.rs) replaces 4 separate test binaries. No helper
dedup needed (no duplicates across the 4 files).

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.7: justfile 加 `test-integration`

**Files:**
- Modify: `justfile:15-18`

- [ ] **Step 1: 加 `test-integration` recipe**

读 `justfile`，在 `test-unit:` 后加：

```makefile
# Integration tests only (pre-push)
test-integration:
    ./scripts/filtered-test.sh --test integration
```

改 `test:` recipe：

```makefile
# Full test suite (unit + integration)
test: test-unit test-integration
```

- [ ] **Step 2: 验证 `test-integration` 和 `test` 都能跑**

```bash
just test-integration
just test
```

预期：`test-integration` 跑 197 个集成测试（server 111 + agent 45 + cli 41）；`test` 跑 548 + 197 = 745 个（Rust 全量）。

- [ ] **Step 3: 提交**

```bash
git add justfile
git commit -m "feat(justfile): add test-integration recipe + update test to run both layers

test now runs test-unit (cargo test --lib) and test-integration (cargo
test --test integration). Both go through filtered-test.sh for
consistent diagnostics.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.8: Rust 单元层搬迁（10 个文件内联）

**Files:**
- 10 个搬迁（见上文"文件结构"）

- [ ] **Step 1: nession-common 三个文件**

**config.rs:**
```bash
# 读 crates/nession-common/tests/config_test.rs
# 复制到 crates/nession-common/src/config.rs 末尾：
#   #[cfg(test)]
#   mod tests {
#       use super::*;
#       // 删 use nession_common::config::…
#       // 函数体内 nession_common::paths::… → crate::paths::…
#   }
# 删 tests/config_test.rs
```

**paths.rs:**
```bash
# 读 tests/paths_test.rs
# 复制到 src/paths.rs 末尾的 #[cfg(test)] mod tests 里
# 6 个重名函数加 _exact 后缀：
#   test_nession_home → test_nession_home_exact
#   test_server_dir → test_server_dir_exact
#   test_agent_dir → test_agent_dir_exact
#   test_server_db_path → test_server_db_path_exact
#   test_server_pid_path → test_server_pid_path_exact
#   test_agent_pid_path → test_agent_pid_path_exact
# 移入的测试须取 ENV_MUTEX 锁（目标模块的 env-override 测试设置 NESSION_HOME 进程全局）
# 删 #[allow(clippy::expect_used)]（CLAUDE.md 禁止，且 clippy.toml 的 allow-expect-in-tests 已使其冗余）
# 删 tests/paths_test.rs
```

**protocol.rs + protocol_tests.rs:**
```bash
# 读 tests/protocol_test.rs
# 移动到 src/protocol_tests.rs（sibling 文件，不是 mod.rs）
# 在 src/protocol.rs 末尾加：
#   #[cfg(test)]
#   mod protocol_tests;
# 注意：src/protocol.rs 已有 #[cfg(test)] mod tests（739-970 行），新模块名必须用 protocol_tests 而非 tests（否则 E0428）
# 删 tests/protocol_test.rs
```

验证：
```bash
cargo test -p nession-common --lib
cargo test -p nession-common --test integration  # 应报错 "no test target"（common 没有集成测试）
```

- [ ] **Step 2: nession-agent 两个文件**

**config.rs:**
```bash
# 读 tests/config_test.rs
# 复制到 src/config.rs 末尾的 #[cfg(test)] mod tests 里
# 删 use nession_agent::config::AgentConfig
# 删 tests/config_test.rs
```

**terminal/raw.rs:**
```bash
# 读 tests/terminal_test.rs
# 复制到 src/terminal/raw.rs 末尾的 #[cfg(test)] mod tests 里
# 🔴 删掉移入文件的 `use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};` —— 目标模块 584 行已有完全相同的一行（E0252）
# `use tokio::sync::{mpsc, watch}` 收窄为 `mpsc`（`watch` 由 `super::*` 提供）
# 注意目标是 src/terminal/raw.rs，不是 terminal/mod.rs
# 删 tests/terminal_test.rs
```

验证：
```bash
cargo test -p nession-agent --lib
```

- [ ] **Step 3: nession-server 两个文件**

**broker.rs:**
```bash
# 读 tests/broker_test.rs
# 复制到 src/broker.rs 末尾：
#   #[cfg(test)]
#   mod tests {
#       use super::*;
#       // 删 use nession_server::broker::ConnectionBroker
#   }
# 删 tests/broker_test.rs
```

**server/client_registry.rs:**
```bash
# 读 tests/client_registry_test.rs
# 复制到 src/server/client_registry.rs 末尾：
#   #[cfg(test)]
#   mod tests {
#       use super::*;
#       // 删两个 import（use super::* 覆盖）
#       // 注意 super 深度：测试模块内 super = client_registry，文件自身第 6 行的 super = server
#   }
# 删 tests/client_registry_test.rs
```

验证：
```bash
cargo test -p nession-server --lib
```

- [ ] **Step 4: nession-claude-code 三个文件**

**scanner.rs:**
```bash
# 读 tests/scanner_tests.rs
# 复制到 src/scanner.rs 末尾的 #[cfg(test)] mod tests 里
# 🔴 必须保留 `use std::path::PathBuf;` —— scanner.rs 只 import 了 Path，super::* 供不上 PathBuf
# 去掉 scanner:: 前缀
# handler_tests.rs 的 full_scan_and_read_flow 也搬到这里（它走 scanner::scan_claude_dir）
# 删 tests/scanner_tests.rs
```

**security.rs:**
```bash
# 读 tests/security_tests.rs
# 复制到 src/security.rs 末尾：
#   #[cfg(test)]
#   mod tests {
#       use super::*;
#       // 去掉 security:: 前缀
#   }
# handler_tests.rs 的 file_too_large_detection 也搬到这里（它用 security::MAX_FILE_SIZE）
# 删 tests/security_tests.rs
```

**agent.rs:**
```bash
# handler_tests.rs 的 pagination_logic 搬到 src/agent.rs 末尾的 #[cfg(test)] mod tests 里
# 登记为欠账：这个测试对局部 String 做纯算术，不碰 crate 任何代码
# 删 tests/handler_tests.rs
```

验证：
```bash
cargo test -p nession-claude-code --lib
```

- [ ] **Step 5: 验证 inventory 不变**

```bash
./scripts/test-inventory.sh --check 1669
```

预期：`rust/unit` 从 548 升到 621（+73），`rust/integration` 从 240 降到 167（-73）。TOTAL 仍 1669。

- [ ] **Step 6: 提交**

```bash
git add crates/
git commit -m "refactor: inline unit tests into src/ (10 files across 5 crates)

Unit tests now live alongside the code they test, compiled into the lib
target. cargo test --lib runs them all. Integration tests remain in
tests/integration/ (3 harnesses, one per crate).

Adaptations per file:
- common/config.rs: deleted use nession_common::config::…
- common/paths.rs: 6 tests renamed _exact (stronger assertion than existing .ends_with); took ENV_MUTEX lock
- common/protocol_tests.rs: sibling file (not mod tests, which already exists)
- agent/config.rs: deleted use nession_agent::config::AgentConfig
- agent/terminal/raw.rs: deleted duplicate crossterm import (E0252)
- server/broker.rs: deleted use nession_server::broker::ConnectionBroker
- server/client_registry.rs: deleted 2 imports (super::* covers)
- claude-code/scanner.rs: kept use std::path::PathBuf (not in super::*)
- claude-code/security.rs: no adaptations
- claude-code/agent.rs: moved pagination_logic from handler_tests (registered as debt)

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.9: 登记 `nession-claude-code` 覆盖率 + 阈值 55%

**Files:**
- Modify: `scripts/check-coverage.sh:20-25`（THRESHOLDS）
- Modify: `scripts/check-coverage.sh:37-42`（FIX_HINTS）

- [ ] **Step 1: 加 threshold + hint**

读 `scripts/check-coverage.sh`，在 `THRESHOLDS` 的 `nession-cli=40` 后加：

```bash
["nession-claude-code"]=55
```

在 `FIX_HINTS` 的 `nession-cli` 后加：

```bash
["nession-claude-code"]="Claude Code extension coverage target is 55% (floor). Add tests in crates/nession-claude-code/. Debt issue: raise to 80%."
```

- [ ] **Step 2: 验证覆盖率能跑**

```bash
./scripts/check-coverage.sh
```

预期：5 个 crate 全列，nession-claude-code 显示 56%（≥ 55%），绿灯。

- [ ] **Step 3: 提交**

```bash
git add scripts/check-coverage.sh
git commit -m "feat(coverage): register nession-claude-code at 55% threshold

Measured: 56% (174/309 executable lines). Threshold set at 55% to lock
the floor; raising to 80% is a debt issue, not part of this refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.10: pre-commit 加单元测试

**Files:**
- Modify: `.githooks/pre-commit:20-29`（Rust 分支）
- Modify: `.githooks/pre-commit:31-40`（Web 分支）

- [ ] **Step 1: Rust 分支加 `just test-unit`**

读 `.githooks/pre-commit`，在 `just quick` 后加：

```bash
if just test-unit; then
  echo -e "${GREEN}✓ just test-unit${NC}"
else
  echo -e "${RED}✗ just test-unit — fix errors above${NC}"
  HAS_ERROR=1
fi
```

- [ ] **Step 2: Web 分支加 `just web-test-unit`**

在 `just web-lint` 后加：

```bash
if just web-test-unit; then
  echo -e "${GREEN}✓ just web-test-unit${NC}"
else
  echo -e "${RED}✗ just web-test-unit — fix errors above${NC}"
  HAS_ERROR=1
fi
```

注意：此时 `just web-test-unit` 还不存在（等 Task 2.5），所以这个改动在 Task 2.5 前会让 pre-commit 报错。应对：Task 1.10 和 Task 2.5 必须落在同一个 PR。

- [ ] **Step 3: 验证**

```bash
git add --all  # 模拟提交
.githooks/pre-commit  # 手动跑
```

预期：Rust 改动会跑 `just quick` + `just test-unit`；web 改动会跑 `just web-lint` + `just web-test-unit`。

- [ ] **Step 4: 提交**

```bash
git add .githooks/pre-commit
git commit -m "feat(hooks): pre-commit runs unit tests for staged paths

Rust block adds just test-unit; web block adds just web-test-unit.
Scoping by staged paths is inherited from the existing guards (lines
10-12, 21, 32).

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 1.11: PR 1 收尾验证 + 开 PR

- [ ] **Step 1: 最终验证**

```bash
./scripts/test-inventory.sh --check 1669
just test-unit
just test-integration
just test
./scripts/check-coverage.sh
```

全部应绿灯。

- [ ] **Step 2: 推分支 + 开 PR**

```bash
git push -u origin feat/test-layering-rust
gh pr create --base staging --title "refactor: Rust test layering (unit/ integration) + inventory baseline" --body "$(cat <<'BODY'
## 变更内容

Rust 侧测试分层：
- 建立 `scripts/test-inventory.sh` + 基线 1669（迁移安全网）
- `filtered-test.sh` / `filtered-web-test.sh` 改为透传 `"$@"`
- justfile 加 `test-unit` / `test-integration` / `unit` recipe
- 3 个 crate（server/agent/cli）创建 `tests/integration/` 单一 harness
- 10 个单元层文件搬进 `src/` 内联
- `e2e_test.rs` → `full_chain.rs`（消除 "e2e" 歧义）
- `--skip full_chain` 删除（已冗余，且改名后会误跳 7 个测试）
- `nession-claude-code` 登记进覆盖率检查，阈值 55%（实测 56%）
- pre-commit 加 `just test-unit` / `just web-test-unit`（后者等 PR 2）

## 测试报告

- `./scripts/test-inventory.sh --check 1669` 通过
- `just test` 跑 745 个 Rust 测试（548 unit + 197 integration）
- `./scripts/check-coverage.sh` 5 个 crate 全绿灯
- 所有搬迁只移动、不删除测试

## 与 PR 2 的关系

本 PR 触碰 `crates/`，按 CLAUDE.md 规则必须进 staging。PR 2 触碰 `web/src/`，独立开 PR。两个 PR 合在一起后 `just unit` 才完整（Rust + web 单元层）。

Closes #ISSUE（登记欠账 issue 后填）
BODY
)"
```

---

## Phase 2: Web 分层（PR 2）

**目标：** Web 侧测试分层（import 改写 + 文件移动 + vitest projects + exclude 清理 + 阈值重测）。

**验证：** `./scripts/test-inventory.sh --check 1669` 通过；`just web-test-unit` 和 `just web-test-integration` 都绿灯；`just web-coverage` 按重测后的阈值通过。

### Task 2.1: Web import 改写（168 行 → `@/` 别名）

**Files:**
- Create: `scripts/rewrite-test-imports.py`（从 `/tmp/rewrite-test-imports.py` 复制）
- Modify: 89 个 web 测试文件的 import（168 行）

- [ ] **Step 1: 创建 rewrite 脚本**

```bash
cp /tmp/rewrite-test-imports.py scripts/rewrite-test-imports.py
chmod +x scripts/rewrite-test-imports.py
```

- [ ] **Step 2: dry-run 验证**

```bash
cd /Users/admin/workspace/learn/nession
python3 scripts/rewrite-test-imports.py --check | tail -20
```

预期输出末尾：
```
rewrote 168 import(s) across 89 file(s)
```

若有 "ESCAPES src" 警告，检查是否真有 import 逃出 `web/src`（应无）。

- [ ] **Step 3: 应用改写**

```bash
python3 scripts/rewrite-test-imports.py --apply
```

- [ ] **Step 4: 验证 tsc + eslint**

```bash
cd web && npx tsc --noEmit && npx eslint . --max-warnings 0
```

预期：0 错误（别名已在 `tsconfig.json` 和 `vite.config.ts` 配好）。

- [ ] **Step 5: 提交**

```bash
git add web/src scripts/rewrite-test-imports.py
git commit -m "refactor(web): rewrite test imports to @/ alias (168 lines)

Preparation for file moves. Alias form is depth-independent, so moving
test files afterwards needs no further import edits.

tsconfig.json paths and vite.config.ts resolve.alias already configured
for @/*; no config changes needed.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2.2: Web 文件移动（89 个 → `__tests__/unit/` + `__tests__/integration/`）

**Files:**
- Move: 89 个 web 测试文件（见上文"文件结构"）

- [ ] **Step 1: 创建目录结构**

```bash
cd web/src
mkdir -p lib/__tests__/unit
mkdir -p atoms/__tests__/unit
mkdir -p services/__tests__/unit
mkdir -p services/websocket/__tests__/unit
mkdir -p services/websocket/plugins/__tests__/unit
mkdir -p terminal/__tests__/unit
mkdir -p terminal/state/__tests__/unit
mkdir -p terminal/input/__tests__/unit
mkdir -p terminal/instance/__tests__/unit
mkdir -p terminal/controller/__tests__/unit
mkdir -p components/__tests__/unit
mkdir -p components/env/__tests__/unit
mkdir -p components/__tests__/integration
mkdir -p hooks/__tests__/integration
mkdir -p components/env/__tests__/integration
mkdir -p terminal/components/__tests__/integration
mkdir -p terminal/components/input/__tests__/integration
mkdir -p terminal/hooks/__tests__/integration
mkdir -p extensions/claude-code/components/__tests__/integration
```

- [ ] **Step 2: 移动文件**

按上文"文件结构"的移动清单执行。例如：

```bash
cd web/src
mv lib/__tests__/auth.test.ts lib/__tests__/unit/
mv lib/__tests__/storage.test.ts lib/__tests__/unit/
# ... 9 个 unit 文件
mv components/__tests__/AgentCard.test.tsx components/__tests__/integration/
# ... 27 个 integration 文件
# 其余 80 个类似
```

注意：App.test.tsx 移到 `__tests__/integration/`（它测 App 组件的集成行为）。

- [ ] **Step 3: 验证 tsc + eslint**

```bash
cd web && npx tsc --noEmit && npx eslint . --max-warnings 0
```

预期：0 错误（import 已改别名，移动不影响解析）。

- [ ] **Step 4: 提交**

```bash
git add web/src/
git commit -m "refactor(web): move test files into __tests__/unit/ and __tests__/integration/

41 files → unit (pure logic, node env safe); 48 files → integration
(jsdom + real component interaction).

Imports already rewritten to @/ alias in previous commit, so file moves
need no further edits.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2.3: vitest projects 配置

**Files:**
- Modify: `web/vite.config.ts:32-100`

- [ ] **Step 1: 改 vite.config.ts**

读 `web/vite.config.ts`，把 `test:` 段改成：

```ts
test: {
  projects: [
    { extends: true, test: {
        name: 'unit',
        environment: 'node',
        include: ['src/**/__tests__/unit/**/*.test.{ts,tsx}'],
    }},
    { extends: true, test: {
        name: 'integration',
        environment: 'jsdom',
        include: ['src/**/__tests__/integration/**/*.test.{ts,tsx}'],
        setupFiles: './src/test/setup.ts',
    }},
  ],
  globals: true,
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html'],
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 65,
      statements: 80,
    },
    include: ['src/**/*.{ts,tsx}'],
    exclude: [
      // ── 删除第一类（已有测试）──
      // 'src/components/Dashboard.tsx',
      // 'src/components/FileBrowser.tsx',
      // 'src/components/FileTabs.tsx',
      // 'src/components/FileViewer.tsx',
      // 'src/components/QuickCommandsPanel.tsx',
      // 'src/components/InputPanel.tsx',
      // 'src/components/env/EnvManager.tsx',
      // 'src/terminal/hooks/useTerminalStateMachine.ts',
      // 'src/extensions/**',
      // 'src/terminal/Renderer.ts',

      // ── 保留排除，理由诚实 ──
      'src/main.tsx',
      'src/vite-env.d.ts',
      'src/components/ui/**',
      'src/test/**',
      'src/App.tsx',
      'src/components/TerminalView.tsx',
      'src/terminal/components/TerminalWorkspace.tsx',
      'src/components/env/EnvPanel.tsx',
      'src/hooks/useDeepLinkRestore.ts',
      'src/terminal/MouseIntentResolver.ts',
      'src/hooks/useSwipeGesture.ts',
      'src/components/SwipeableViewport.tsx',
      'src/components/TerminalLayout.tsx',
      'src/components/DashboardHeader.tsx',
      'src/components/ModeBar.tsx',
      'src/components/SessionsSection.tsx',
      'src/components/RenderTerminal.tsx',
      'src/components/TerminalBanner.tsx',
      'src/terminal/components/TerminalTabs.tsx',
      'src/terminal/components/TerminalBanner.tsx',
      'src/hooks/useProbePolling.ts',
      'src/hooks/useQuickCommands.ts',
      'src/hooks/useVisibilityReconnect.ts',
      'src/components/env/EnvUploadDialog.tsx',
      'src/components/env/EnvInlineEditor.tsx',
      'src/components/env/useEnvManager.ts',
    ],
  },
  onConsoleLog(log: string): boolean | void {
    if (log.includes("HTMLCanvasElement's getContext")) { return false; }
    if (log.includes('Function components cannot be given refs')) { return false; }
  },
  css: false,
},
```

注意：
- `projects` 用 `extends: true` 继承根配置（plugins + resolve.alias）
- `coverage` / `onConsoleLog` / `globals` 必须留 root（NonProjectOptions）
- 删掉第一类 exclude（10 项已有测试的）
- 保留第二类 exclude，理由改成诚实措辞（不再写 "covered by E2E"）

- [ ] **Step 2: 验证 vitest 能跑**

```bash
cd web && npx vitest run --project unit
cd web && npx vitest run --project integration
cd web && npx vitest run  # 两个 project 都跑
```

预期：unit 跑 499 个，integration 跑 382 个，total 881 个。

- [ ] **Step 3: 提交**

```bash
git add web/vite.config.ts
git commit -m "feat(web): configure vitest projects for unit/integration layers

projects[].extends: true inherits root config (plugins, resolve.alias).
coverage / onConsoleLog / globals stay at root (NonProjectOptions in
vitest 4.x).

Unit tests run in node env (no jsdom); integration in jsdom with
setupFiles.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2.4: justfile 加 `web-test-unit` / `web-test-integration`

**Files:**
- Modify: `justfile:36-42`

- [ ] **Step 1: 加 recipe**

读 `justfile`，在 `web-test:` 前加：

```makefile
# Web unit tests only (pre-commit, node env)
web-test-unit:
    ./scripts/filtered-web-test.sh --project unit

# Web integration tests only (pre-push, jsdom env)
web-test-integration:
    ./scripts/filtered-web-test.sh --project integration
```

改 `web-test:` recipe：

```makefile
# Full web test suite (unit + integration)
web-test: web-test-unit web-test-integration
```

- [ ] **Step 2: 验证**

```bash
just web-test-unit
just web-test-integration
just web-test
```

- [ ] **Step 3: 提交**

```bash
git add justfile
git commit -m "feat(justfile): add web-test-unit / web-test-integration recipes

web-test now runs both layers. Each goes through filtered-web-test.sh
for jsdom noise filtering.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2.5: 重测 web 覆盖率阈值

**Files:**
- Modify: `web/vite.config.ts:45-50`（thresholds）

- [ ] **Step 1: 跑全量覆盖率**

```bash
cd web && npx vitest run --coverage
```

预期：删除 10 个 exclude 后分母变大，覆盖率会降。记录实际值。

- [ ] **Step 2: 调阈值（只降不升）**

根据 Step 1 的实测值，把 `thresholds` 调到略低于实测值（向下取整到 5 的倍数）。例如实测 lines 77% → 阈值设 75%。

**必须在 PR body 里记录降的原因**：删除了 10 个陈旧 exclude，分母从 X 升到 Y，覆盖率从 A% 降到 B%。

- [ ] **Step 3: 验证 `just web-coverage` 通过**

```bash
just web-coverage
```

- [ ] **Step 4: 提交**

```bash
git add web/vite.config.ts
git commit -m "feat(web): adjust coverage thresholds after exclude cleanup

Removed 10 stale exclude entries (files now have tests). Denominator
grew, coverage dropped from A% to B%. Thresholds adjusted to X%
(downward only, rounded to 5s).

Debt: raise thresholds back to 80% as untested modules get coverage.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2.6: 验证 inventory + 开 PR

- [ ] **Step 1: 验证 inventory**

```bash
./scripts/test-inventory.sh --check 1669
```

预期：`web/unit` 499，`web/integration` 382，`web/unclassified` 0，TOTAL 1669。

- [ ] **Step 2: 最终验证**

```bash
just test
just web-test
just web-coverage
./scripts/check-coverage.sh
```

- [ ] **Step 3: 推分支 + 开 PR**

```bash
git push -u origin feat/test-layering-web
gh pr create --base staging --title "refactor: Web test layering (unit/integration) + exclude cleanup" --body "$(cat <<'BODY'
## 变更内容

Web 侧测试分层：
- 89 个测试文件的 168 行 import 改写成 `@/` 别名（深度无关）
- 41 个纯逻辑测试移到 `__tests__/unit/`（node env）
- 48 个 jsdom 集成测试移到 `__tests__/integration/`
- `vite.config.ts` 配 vitest projects（`extends: true` 继承根配置）
- justfile 加 `web-test-unit` / `web-test-integration` recipe
- 删除 10 个陈旧 coverage exclude（已有测试的文件）
- 覆盖率阈值从 80/80/65/80 调到 X/Y/Z/W（分母变大，只降不升）
- pre-commit 加 `just web-test-unit`（与 PR 1 的改动合体）

## 测试报告

- `./scripts/test-inventory.sh --check 1669` 通过（web/unit 499, web/integration 382）
- `just web-test` 跑 881 个 web 测试
- `just web-coverage` 按新阈值通过
- 所有搬迁只移动、不删除测试

## 覆盖率阈值调整说明

删除 10 个 exclude 后分母从 A 升到 B，覆盖率从 X% 降到 Y%。阈值调到 Z%（向下取整到 5 的倍数）。欠账：把阈值提回 80%。

Closes #ISSUE（登记欠账 issue 后填）
BODY
)"
```

---

## Phase 3: E2E 套件（PR 3）

**目标：** 建立 Playwright E2E 套件 + CI job + 修正 CLAUDE.md 运行时事实。

**验证：** `just e2e` 本地能跑；`quality.yml` 的 `e2e-check` job 在 PR 上绿灯。

### Task 3.1: E2E 项目结构 + playwright.config.ts

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/fixtures/server/config.toml`
- Create: `e2e/fixtures/agent-config.e2e.toml`
- Create: `e2e/helpers/reset.ts`
- Create: `e2e/helpers/dashboard.ts`

- [ ] **Step 1: 创建 e2e/package.json**

```json
{
  "name": "nession-e2e",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:ui": "playwright test --ui"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0"
  }
}
```

- [ ] **Step 2: 创建 playwright.config.ts**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,  // E2E tests share stateful backend
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',  // vite preview (IPv6-only [::1])
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'cargo run -p nession-server',
      cwd: './fixtures/server',  // config.toml must be in CWD
      port: 19090,  // TCP connect probe (no HTTP listener)
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'cargo run -p nession-agent -- ../fixtures/agent-config.e2e.toml',
      cwd: './fixtures',
      port: 19091,  // TCP connect probe
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run preview',
      cwd: '../web',
      url: 'http://localhost:4173',  // HTTP GET (vite preview has no proxy, just static)
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
```

注意：
- server CWD 必须是 `fixtures/server`（config.toml 只能从 CWD 读）
- 两个 Rust 进程用 `port:`（TCP connect，因无 HTTP 监听）
- vite preview 用 `url:`（HTTP GET）
- baseURL 写 `localhost`（preview 默认只绑 `[::1]`）

- [ ] **Step 3: 创建 fixture 配置**

**e2e/fixtures/server/config.toml:**
```toml
listen_address = "127.0.0.1:19090"
tls_cert_path = ""
tls_key_path = ""
auth_token = ""  # no-auth mode
db_path = "/tmp/nession-e2e-server.db"
```

**e2e/fixtures/agent-config.e2e.toml:**
```toml
listen_address = "127.0.0.1:19091"
server_url = "ws://127.0.0.1:19090/ws"
auth_token = "e2e-test-token"
node_id = "e2e-test-node"
tmux_socket = "/tmp/tmux-e2e"
```

- [ ] **Step 4: 创建 helper**

**e2e/helpers/reset.ts:**
```ts
import { Page } from '@playwright/test';

export async function resetAuth(page: Page) {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
```

**e2e/helpers/dashboard.ts:**
```ts
import { Page, expect } from '@playwright/test';

export async function waitForDashboard(page: Page) {
  // [data-testid="filter-row"] is in SearchBar.tsx, always rendered when logged in
  await expect(page.locator('[data-testid="filter-row"]')).toBeVisible({ timeout: 10_000 });
}
```

- [ ] **Step 5: 安装依赖 + 验证配置**

```bash
cd e2e && npm install
cd e2e && npx playwright install chromium
cd e2e && npx playwright test --list
```

预期：列出 0 个测试（specs 还没写），但配置无语法错误。

- [ ] **Step 6: 提交**

```bash
git add e2e/
git commit -m "feat(e2e): scaffold Playwright project + fixtures

Playwright config starts server/agent/vite-preview as webServer blocks.
Server CWD is fixtures/server (config.toml must be in CWD). Two Rust
processes use port: probe (no HTTP listener); vite preview uses url:
probe.

baseURL is localhost (preview binds [::1] by default).

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3.2: E2E specs（3 个 smoke 测试）

**Files:**
- Create: `e2e/specs/login.spec.ts`
- Create: `e2e/specs/session-lifecycle.spec.ts`
- Create: `e2e/specs/terminal-io.spec.ts`

- [ ] **Step 1: login.spec.ts**

```ts
import { test, expect } from '@playwright/test';
import { resetAuth } from '../helpers/reset';
import { waitForDashboard } from '../helpers/dashboard';

test('login with real form', async ({ page }) => {
  await resetAuth(page);
  await page.goto('/');

  // Fill login form
  await page.locator('#serverUrl').fill('http://localhost:19090');
  await page.locator('#authToken').fill('e2e-test-token');
  await page.locator('button:has-text("Connect")').click();

  // Dashboard should appear
  await waitForDashboard(page);
});
```

- [ ] **Step 2: session-lifecycle.spec.ts**

```ts
import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';

test('create and kill session', async ({ page }) => {
  await page.goto('/?token=e2e-test-token');
  await waitForDashboard(page);

  // Agent card should appear
  await expect(page.locator('text=e2e-test-node')).toBeVisible({ timeout: 10_000 });

  // Create session
  await page.locator('button:has-text("Create Session")').click();
  await page.locator('[role="dialog"] input[placeholder*="session"]').fill('e2e-test-session');
  await page.locator('[role="dialog"] button:has-text("Create")').click();

  // Session should appear in list
  await expect(page.locator('text=e2e-test-session')).toBeVisible({ timeout: 5_000 });

  // Kill session
  await page.locator('tr:has-text("e2e-test-session") button:has-text("Kill")').click();
  await page.locator('[role="alertdialog"] button:has-text("Kill")').click();

  // Session should disappear
  await expect(page.locator('text=e2e-test-session')).not.toBeVisible({ timeout: 5_000 });
});
```

- [ ] **Step 3: terminal-io.spec.ts**

```ts
import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';

test('terminal I/O in relay mode', async ({ page }) => {
  await page.goto('/?token=e2e-test-token');
  await waitForDashboard(page);

  // Attach to session
  await page.locator('tr:has-text("e2e-test-session") button:has-text("Attach")').click();

  // Terminal should appear (xterm.js)
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

  // Type command
  await page.locator('.xterm').click();
  await page.keyboard.type('echo nession-e2e-ok\n');

  // Output should appear in terminal buffer
  await expect(page.locator('.xterm-rows')).toContainText('nession-e2e-ok', { timeout: 5_000 });
});

test('terminal I/O in P2P mode', async ({ page }) => {
  await page.goto('/?token=e2e-test-token&p2p=true');
  await waitForDashboard(page);

  await page.locator('tr:has-text("e2e-test-session") button:has-text("Attach")').click();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

  await page.locator('.xterm').click();
  await page.keyboard.type('echo nession-e2e-p2p\n');

  await expect(page.locator('.xterm-rows')).toContainText('nession-e2e-p2p', { timeout: 5_000 });
});
```

注意：P2P 模式的 URL 参数需核实（可能不是 `?p2p=true`，而是 attach 时的选项）。实施时查 `App.tsx` 确认。

- [ ] **Step 4: 验证 E2E 能跑**

```bash
cd e2e && npx playwright test
```

预期：3 个 spec 共 4 个测试全绿灯。

- [ ] **Step 5: 提交**

```bash
git add e2e/specs/
git commit -m "feat(e2e): 3 smoke specs (login, session lifecycle, terminal I/O)

login.spec.ts: real form fill + submit
session-lifecycle.spec.ts: create session → list appears → kill → list disappears
terminal-io.spec.ts: attach → type echo → output appears (relay + P2P)

Terminal assertions read xterm DOM buffer, not screenshots (screenshots
are too sensitive to rendering differences for CI).

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3.3: CI job `e2e-check`

**Files:**
- Modify: `.github/workflows/quality.yml`

- [ ] **Step 1: 加 e2e-check job**

读 `.github/workflows/quality.yml`，加第三个 job：

```yaml
  e2e-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with: { cache-workspaces: ".", cache-all-crates: "true" }
      - uses: extractions/setup-just@v2
      - run: sudo apt-get update && sudo apt-get install -y tmux
      - run: cd e2e && npm ci
      - run: cd e2e && npx playwright install --with-deps chromium
      - run: just e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-traces
          path: e2e/test-results/
          retention-days: 7
```

- [ ] **Step 2: 提交**

```bash
git add .github/workflows/quality.yml
git commit -m "feat(ci): add e2e-check job to quality.yml

Runs just e2e on ubuntu-latest with tmux + chromium installed. Uploads
Playwright traces on failure for diagnostics.

Part of test layering refactor.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3.4: 修正 CLAUDE.md 运行时事实

**Files:**
- Modify: `CLAUDE.md:33-36`（Service ports 表）
- Modify: `CLAUDE.md:139-141`（本地 demo 段）
- Modify: `CLAUDE.md:7`（项目结构）

- [ ] **Step 1: 改 Service ports 表**

读 `CLAUDE.md`，把 Service ports 表改成：

```markdown
| Service | Port | Purpose |
|---------|------|---------|
| nession-server | 19090 | WebSocket (agents + clients) |
| nession-agent | 19090 | WebSocket (P2P terminal) |
| nession-agent | 10080 | HTTP (health) — nginx sidecar only |
| nession-ui | 80 | nginx serving web/dist/ |
```

删掉 server 的 10080（二进制无 HTTP 监听）。加注释：10080 是 nginx sidecar 的端口，只在 Docker/k8s 运行时存在。

- [ ] **Step 2: 改本地 demo 段**

把「Server listens on 127.0.0.1:19090 (ws) + :10080 (http), agent on :19091」改成：

```markdown
Server without config.toml falls back to 127.0.0.1:8080; agent defaults to 0.0.0.0:8080. Default ports collide — explicit config is required. See `e2e/fixtures/` for working examples.
```

- [ ] **Step 3: 改项目结构**

把 `agent-config.toml` 从项目结构里删掉（它被 .gitignore 忽略且未跟踪）。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: correct CLAUDE.md runtime facts

Three errors found while building E2E stack:
1. Server has no HTTP listener (10080 + /health are nginx sidecar)
2. Default ports collide (server 8080, agent 8080) — explicit config required
3. agent-config.toml is gitignored, not part of repo structure

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3.5: 更新 CLAUDE.md Quality Gates 段

**Files:**
- Modify: `CLAUDE.md:388-410`（Quality Gates 段）

- [ ] **Step 1: 更新 Quality Gates**

读 `CLAUDE.md`，把 Quality Gates 段改成反映新结构的描述：

```markdown
## 3. Quality Gates

- **两个 hook，都在 `.githooks/`**
- **`pre-commit` 跑快速检查 + 单元测试**：`just quick`（fmt + clippy）+ `just test-unit`（Rust 单元层）+ `just web-lint`（eslint + tsc）+ `just web-test-unit`（vitest node project）。按改动范围收窄（Rust 改动跑 Rust，web 改动跑 web）。
- **`pre-push` 跑全量测试和覆盖率**：`just test`（Rust 单元 + 集成）+ `just coverage`（cargo-llvm-cov）+ `just web-test`（vitest 两个 project）+ `just web-coverage`。按改动范围收窄。
- **CI `quality.yml`**：PR -> staging 跑 `rust-check`（`just check`）+ `web-check`（`just web-lint` + `just web-test`）+ `e2e-check`（`just e2e`）。
- **⛔ 禁止任何手段跳过 git hooks**
- **覆盖率阈值**：

  | 目标 | 阈值 |
  |------|------|
  | `nession-common` / `nession-server` / `nession-agent` | 80% line（agent macOS 79%） |
  | `nession-cli` | 40% line |
  | `nession-claude-code` | 55% line（地板，欠账：提到 80%） |
  | web | lines / functions / statements 80%，branches 65%（实测后调整，见 PR 2） |
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: update Quality Gates section for test layering

pre-commit now runs unit tests (test-unit + web-test-unit). pre-push
runs full suite (test = unit + integration). CI adds e2e-check job.

Coverage thresholds: nession-claude-code at 55% (floor), web thresholds
adjusted after exclude cleanup (see PR 2).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3.6: 最终验证 + 开 PR

- [ ] **Step 1: 最终验证**

```bash
./scripts/test-inventory.sh --check 1669
just test
just web-test
just e2e
./scripts/check-coverage.sh
just web-coverage
```

全部应绿灯。

- [ ] **Step 2: 推分支 + 开 PR**

```bash
git push -u origin feat/test-layering-e2e
gh pr create --base staging --title "feat: E2E suite (Playwright) + CI job + CLAUDE.md corrections" --body "$(cat <<'BODY'
## 变更内容

E2E 层：
- 建立 `e2e/` 独立项目（自带 package.json，不增加 web 负担）
- Playwright 配置起 server/agent/vite-preview 三个 webServer
- 3 个 smoke spec：login / session lifecycle / terminal I/O（relay + P2P）
- `quality.yml` 加 `e2e-check` job（tmux + chromium，失败上传 trace）
- justfile 加 `e2e` / `e2e-ui` recipe

CLAUDE.md 修正：
- Service ports 表删掉 server 的 10080（二进制无 HTTP 监听）
- 本地 demo 段说明默认端口会撞，必须显式配置
- 项目结构删掉 `agent-config.toml`（被 .gitignore 忽略）
- Quality Gates 段更新为三层结构描述

## 测试报告

- `just e2e` 本地跑 4 个测试（login / session / terminal I/O × 2 模式）
- `quality.yml` 的 `e2e-check` job 在 PR 上绿灯
- 不影响既有 Rust / web 测试

## 为什么 E2E 不进 pre-push

CLAUDE.md 禁止 `--no-verify`，pre-push 加几分钟的全栈启动是跑不掉的税。E2E 只在 CI 和手动 `just e2e` 跑。

Closes #ISSUE（登记欠账 issue 后填）
BODY
)"
```

---

## Phase 4: 欠账登记（PR 4）

**目标：** 登记欠账 issue，不在本次实施。

### Task 4.1: 登记欠账 issue

- [ ] **Step 1: 开 issue**

```bash
gh issue create --title "Debt: raise nession-claude-code coverage from 55% to 80%" --body "Current threshold locked at 55% (measured 56%). Debt: raise to 80% with new tests."

gh issue create --title "Debt: fix cli main.rs module re-declaration" --body "main.rs re-declares mod commands/update/client/terminal/utils instead of consuming lib, causing inline tests to run twice. Independent refactor."

gh issue create --title "Debt: delete or rewrite claude-code pagination_logic test" --body "Test operates on local String, does not touch crate code. Should be deleted or rewritten to actually test pagination."

gh issue create --title "Debt: prune semantically duplicate tests" --body "protocol::test_message_new, agent/config::test_agent_config_default(s), raw.rs key conversion series — structural refactor kept both copies. Pruning is a separate judgment call."

gh issue create --title "Debt: raise web coverage thresholds back to 80%" --body "Thresholds dropped after removing 10 stale exclude entries (denominator grew). Raise back as untested modules get coverage."
```

记录每个 issue 的编号，填到 PR 1-3 的 body 里。

- [ ] **Step 2: 提交（可选，如果欠账要落文档）**

如果要把欠账清单落到 `docs/`：

```bash
cat > docs/superpowers/plans/2026-08-19-test-layering-debt.md <<'EOF'
# 测试分层欠账清单

以下模块保留 coverage 排除且确实零覆盖，需登记为 issue 后续补测试。

| 模块 | 为什么现在没测 | Issue |
|---|---|---|
| `nession-claude-code` 整个 crate | 覆盖率仅 56%，本次只锁 55% 地板，需提到 80% | #ISSUE |
| `nession-cli/src/main.rs` 的模块重复声明 | 它重新声明 mod 而不消费自己的 lib，导致内联测试跑两遍 | #ISSUE |
| `claude-code` 的 `pagination_logic` 测试 | 对局部 String 做纯算术，不碰 crate 任何代码 | #ISSUE |
| 语义重叠的重复测试 | protocol / agent/config / raw.rs 系列 | #ISSUE |
| `env/EnvPanel.tsx` | WebSocket 集成 | （未开 issue） |
| `env/EnvUploadDialog.tsx` | 文件上传 + WebSocket | （未开 issue） |
| `env/EnvInlineEditor.tsx` | WebSocket | （未开 issue） |
| `env/useEnvManager.ts` | WebSocket | （未开 issue） |
| `hooks/useProbePolling.ts` | 定时器 + WebSocket | （未开 issue） |
| `hooks/useQuickCommands.ts` | WebSocket | （未开 issue） |
| `hooks/useVisibilityReconnect.ts` | 页面可见性 + WebSocket | （未开 issue） |
| `hooks/useDeepLinkRestore.ts` | react-router 集成 | （未开 issue） |
| `components/TerminalView.tsx` | 编排层 | （未开 issue） |
| `terminal/components/TerminalWorkspace.tsx` | 编排层 | （未开 issue） |
| layout/chrome 组件（13 个） | 纯布局 | （未开 issue） |
EOF

git add docs/superpowers/plans/2026-08-19-test-layering-debt.md
git commit -m "docs: register test layering debt

Modules with zero coverage that need tests. Thresholds locked at floors
to prevent further regression. Raising thresholds is tracked as debt
issues.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 实施纪律

### 1. 每个 Task 完成后必须验证 inventory

```bash
./scripts/test-inventory.sh --check 1669
```

若 TOTAL 变了，说明测试在搬迁中丢失，必须停下来排查。

### 2. 搬迁不删测试

即使语义重叠也保留两份。剪枝另开 PR。

### 3. import 改写先于文件移动

别名是深度无关的，改写后再移动不需要再改 import。

### 4. pre-commit 已经按改动范围收窄

`.githooks/pre-commit` 第 10-12 行读 `git diff --cached --name-only`，第 21/32 行用 `[ -n "$STAGED_RUST" ]` / `[ -n "$STAGED_TSX" ]` 守卫。新增的单元测试步骤放进这两个既有分支，范围收窄自动继承。

### 5. `--skip full_chain` 必须删除

改名 `e2e_test.rs` → `full_chain.rs` 后，libtest 的 `--skip full_chain`（子串匹配）会把 7 个测试全跳过。它现在已经冗余，直接删。

### 6. filtered 脚本必须透传参数

`filtered-test.sh` 和 `filtered-web-test.sh` 改为 `"$@"` 透传，新的分层 recipe 才能工作。不能绕过这两个脚本直接调 cargo/vitest。

### 7. justfile recipe 分步加

`test-integration` 不能早于第一个 `tests/integration/main.rs` 的创建（实测 `--test integration` 会报错）。所以 Task 1.3 只加 `test-unit`，Task 1.7 才加 `test-integration`。

### 8. Web 阈值只降不升

删除 exclude 后分母变大，覆盖率会降。阈值调整必须在 PR body 里记录降的原因。

---

## 最终态验证

```bash
# 1. Inventory 不变
./scripts/test-inventory.sh --check 1669

# 2. Rust 分层
just test-unit        # 621 个单元层测试
just test-integration # 197 个集成层测试
just test             # 818 个 Rust 测试

# 3. Web 分层
just web-test-unit        # 499 个
just web-test-integration # 382 个
just web-test             # 881 个

# 4. E2E
just e2e              # 4 个测试

# 5. 覆盖率
./scripts/check-coverage.sh  # 5 个 crate 全绿灯
just web-coverage             # 按新阈值通过

# 6. pre-commit
git add --all
.githooks/pre-commit  # 跑 quick + test-unit + web-lint + web-test-unit
```

全部绿灯后，可以合并 PR 1-3 到 staging。PR 4 是欠账登记，可合可不合。

---

## 风险与应对

| 风险 | 应对 |
|---|---|
| 搬迁中丢失测试 | `test-inventory.sh --check 1669` 兜底 |
| `--test integration` 报错（无 target） | Task 1.3 只加 `test-unit`，Task 1.7 才加 `test-integration` |
| Web 文件移动与在飞分支冲突 | PR 2 前 `gh pr list --base staging` 确认无在飞 web 改动 |
| E2E flake（tmux 并发、端口冲突） | 已核对固定端口无冲突；flake 处置是 `--test-threads` 而非改脆测试 |
| 覆盖率跌破阈值 | Web 阈值只降不升；Rust 阈值不变（搬迁不影响覆盖率） |

---

## 不在本次处理

1. 根 `package.json` 垃圾清理
2. `web/src/test/setup.ts` 的 `eslint-disable-next-line` 修复
3. 测试语义剪枝
4. 把 `nession-cli/src/main.rs` 改成消费 lib 而非重复声明 mod

这些是独立的重构，登记为欠账 issue。
