# 测试三层化设计（单元 / 集成 / E2E）

## Problem

仓库有 1669 个测试，但没有分层。三个具体后果：

**1. 没有层的概念，只有一个 blob。**
`cargo test --workspace` 一锅全跑，`vitest run` 一锅全跑。想只跑纯逻辑测试快速定位问题做不到；想只跑跨进程集成测试也做不到。`crates/*/tests/` 下的命名毫无规律 —— `handler_test.rs`、`integration_test.rs`、`relay_integration_test.rs`、`e2e_test.rs`、`update_integration.rs` 混在一起，文件名不携带层信息。

**2. E2E 层根本不存在，但覆盖率配置假装它存在。**
仓库没有安装任何 Playwright test runner（`web/package.json` 和根 `package.json` 都没有），Playwright 只在 PR 前通过 MCP 手工截图时用。然而 `web/vite.config.ts` 的 coverage `exclude` 里有约 10 项理由写的是 **"covered by E2E"**（`EnvPanel.tsx`、`useProbePolling.ts`、`useQuickCommands.ts`、`src/extensions/**` 等）。这些文件既被排除在覆盖率之外，又没有任何 E2E 覆盖 —— 等于凭空消失。

同时 `crates/nession-agent/tests/e2e_test.rs` 名字叫 e2e，实际是进程内 Rust 集成测试，没有浏览器、没有真实部署。"e2e" 在这个仓库里有两个互相冲突的含义。

**3. coverage exclude 名单陈旧，在缩小的分母上算覆盖率。**
逐项核对被排除的文件，**10 个已经有测试了**：

| 被排除文件 | 原排除理由 | 实际情况 |
|---|---|---|
| `QuickCommandsPanel.tsx` | covered by integration | 已有 10 个测试 |
| `InputPanel.tsx` | covered by integration | 已有 10 个测试 |
| `env/EnvManager.tsx` | covered by E2E | 已有 6 个测试 |
| `Dashboard.tsx` | browser-only APIs | 已有 2 个测试 |
| `FileBrowser.tsx` | browser-only APIs | 已有 3 个测试 |
| `FileTabs.tsx` | browser-only APIs | 已有 5 个测试 |
| `FileViewer.tsx` | browser-only APIs | 已有 8 个测试 |
| `useTerminalStateMachine.ts` | browser-only internals | 已有 5 个测试 |
| `extensions/**`（ClaudeCodeSection） | covered by E2E | 已有 2 个测试 |
| `terminal/Renderer.ts` | requires GPU context, hard to unit test | 已有 5 个测试（mock `getContext` 覆盖 WebGL 路径） |

测试后来补上了，排除项没删。后果双向有害：已测代码的覆盖率贡献被丢弃（高估已覆盖比例），真正零覆盖的模块又躲在同一份名单里不被发现。

**附带问题：** `nession-claude-code`（485 行 src，16 个测试）完全没登记在 `scripts/check-coverage.sh` 里，不检查覆盖率。

## 现状基线

**Rust — 788 个测试函数**

| Crate | 内联 `#[cfg(test)]` | `tests/` 目录 |
|---|---|---|
| nession-common | 73 | 30 |
| nession-server | 154 | 111 |
| nession-agent | 207 | 45 |
| nession-cli | 111 | 41 |
| nession-claude-code | 3 | 13 |

**Web — 881 个测试，89 个文件**，全部 vitest + jsdom，colocated 在 `__tests__/`。按本设计的契约划分为单元 499 / 集成 382。

**E2E — 0 个。**

## Solution

### 层的契约

三层由**依赖什么**定义，不由文件放在哪定义。这是唯一判据，新增测试照它归类。

| 层 | 允许依赖 | 禁止 | 运行载体 |
|---|---|---|---|
| **单元** | 纯计算、tempdir 文件读写 | 开端口、起进程、tmux、真实 DB、DOM | Rust lib target（`--lib`）；vitest `node` env |
| **集成** | 进程内 WebSocket server、SQLite、真实 tmux、jsdom + 真实组件交互 | 浏览器、真实部署 | `tests/integration` harness；vitest `jsdom` project |
| **E2E** | 真实全栈 + 真实浏览器 | —— | Playwright |

两条推论：

1. **Rust 侧没有 E2E。** `crates/nession-agent/tests/e2e_test.rs` 按此定义是集成测试，改名 `full_chain.rs`。"e2e" 从此专指浏览器层，消除歧义。
2. **tempdir 算单元。** `nession-claude-code` 的 scanner 走真实文件系统但只在 tempdir 里，没有进程和端口 —— 是单元。该 crate 三个测试文件全归单元，零集成。

### Design Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| 首要目标 | 重新分层 + 补上 E2E | 单纯分层不解决 exclude 名单里的假理由 |
| E2E 运行环境 | 本地 + CI 都跑，自含栈 | 可重复、不依赖部署、PR 阶段就能拦住 |
| E2E 覆盖范围 | smoke（主干路径 + P2P/relay） | 与现有组件测试不重叠，维护成本可控 |
| exclude 名单处理 | 清除陈旧项 + 剩下的诚实标注 | smoke 级 E2E 救不了剩下那批，写"covered by E2E"就是假话 |
| Rust 分层机制 | 单一 harness 汇总 | `--lib` / `--test integration` 天然分层，且 16 个 test binary 降到 3 个 |
| Web 分层机制 | 移到 `__tests__/unit/` 与 `__tests__/integration/` 子目录 | 结构最直观，层信息写在路径上 |
| Web import 改写方式 | 改成 `@/` 别名，而非加一层 `../` | 168 行无论如何要改，别名换来深度无关 |
| gate 接线 | 单元→pre-commit，集成+覆盖率→pre-push，E2E→仅 CI + 手动 | 本地体验不变差，E2E 坏了在 PR 上拦住 |
| 覆盖率阈值 | 先实测再定 | 不预设数字，避免用调阈值掩盖下滑 |

## Rust 结构改造

### 分类结果

按契约对 29 个 `tests/` 文件实测归类（判据：`connect_async`/`WebSocketServer::`/`AgentServer::`/`TcpListener::bind` → 端口；`SessionManager::`/`Command::new("tmux")`/`ControlModeSession` → tmux；`Database::(new|open)` → 真实 DB）：

**单元层 —— 13 个文件搬进 lib target**

```
nession-common:      config_test.rs   → src/config.rs 内联
                     paths_test.rs    → src/paths.rs 内联
                     protocol_test.rs → src/protocol_tests.rs（sibling）
nession-agent:       config_test.rs   → src/config.rs 内联
nession-claude-code: handler_tests.rs  → src/agent.rs 内联
                     scanner_tests.rs  → src/scanner.rs 内联
                     security_tests.rs → src/security.rs 内联
nession-cli:         client_commands_test.rs, session_commands_test.rs,
                     terminal_test.rs, update_integration.rs → 各自 src 内联
nession-server:      broker_test.rs, client_registry_test.rs → 各自 src 内联
```

内联后源文件行数（已实测，均可接受）：

| 源文件 | src 行 | 测试行 | 合计 |
|---|---|---|---|
| `nession-common/src/config.rs` | 103 | 38 | 141 |
| `nession-common/src/paths.rs` | 187 | 55 | 242 |
| `nession-common/src/protocol.rs` | 970 | 377 | **1347** |
| `nession-agent/src/config.rs` | 318 | 82 | 400 |
| `nession-claude-code/src/scanner.rs` | 232 | 94 | 326 |
| `nession-claude-code/src/security.rs` | 55 | 40 | 95 |
| `nession-claude-code/src/agent.rs` | 191 | 56 | 247 |

只有 `protocol.rs` 过厚，用 sibling 文件：

```rust
// src/protocol.rs 末尾
#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
```

`#[path]` 相对当前文件所在目录解析，落到 `src/protocol_tests.rs`。测试仍编进 lib target，`cargo test --lib` 照样跑到，源文件不膨胀。**约定：以后任何超过约 600 行的源文件，其单元测试都用这个模式。**

**集成层 —— 16 个文件收成 3 个 harness**

```
crates/nession-server/tests/integration/
├── main.rs              # mod 声明 + 共享 helper
├── db.rs                # ← db_test.rs
├── websocket.rs         # ← websocket_test.rs
├── handler.rs           # ← handler_test.rs
├── agent_registry.rs    # ← agent_registry_test.rs
├── session_registry.rs  # ← session_registry_test.rs
├── session_command.rs   # ← session_command_test.rs
├── command_broker.rs    # ← command_broker_test.rs
├── relay.rs             # ← relay_integration_test.rs
└── full_stack.rs        # ← integration_test.rs

crates/nession-agent/tests/integration/
├── main.rs
├── connection.rs        # ← connection_test.rs
├── control_mode.rs      # ← control_mode_test.rs
├── server.rs            # ← server_test.rs
├── sync.rs              # ← sync_test.rs
├── tmux.rs              # ← tmux_test.rs
└── full_chain.rs        # ← e2e_test.rs（改名）

crates/nession-cli/tests/integration/
├── main.rs
└── attach_session.rs    # ← attach_session_test.rs
```

`nession-common` 和 `nession-claude-code` 分层后没有集成测试 —— 它们是纯库，符合预期。

**收益：**
- `cargo test --lib` 精确跑单元层，`cargo test --test integration -p <crate>` 精确跑集成层
- test binary 从 16 个降到 3 个，链接次数大幅下降，集成层编译显著变快
- `main.rs` 承接现在各文件重复的 helper（`TestServer`、`unique_session_name`、`current_timestamp` 至少在 3 个文件里各写了一遍），去重顺带做掉

**已验证无洞：** 三个 `main.rs`（cli/agent/server）里零测试，`--lib` 不会漏掉 bin target 的测试。

## Web 结构改造

### 文件移位

89 个测试文件按层落到子目录：

```
web/src/lib/__tests__/unit/                                     9
web/src/atoms/__tests__/unit/                                   3
web/src/services/__tests__/unit/                                4
web/src/services/websocket/__tests__/unit/                      1
web/src/services/websocket/plugins/__tests__/unit/              3
web/src/terminal/__tests__/unit/                                6
web/src/terminal/state/__tests__/unit/                          6
web/src/terminal/input/__tests__/unit/                          5
web/src/terminal/instance/__tests__/unit/                       1
web/src/terminal/controller/__tests__/unit/                     1
web/src/components/__tests__/unit/            quickCommands     1
web/src/components/env/__tests__/unit/        envRef            1
                                                        小计   41

web/src/components/__tests__/integration/                      27
web/src/hooks/__tests__/integration/                           12
web/src/components/env/__tests__/integration/                   4
web/src/terminal/components/__tests__/integration/              2
web/src/terminal/components/input/__tests__/integration/        1
web/src/terminal/hooks/__tests__/integration/                   1
web/src/extensions/claude-code/components/__tests__/integration/ 1
                                                        小计   48
```

分层判据是**是否需要 jsdom**。已实测：41 个纯逻辑测试中**零个**触碰 `localStorage`/`sessionStorage`/`navigator`/`window`/`document`/`matchMedia`/`IntersectionObserver`/`ResizeObserver`，node env 安全。

### import 改写

89 个文件全部使用相对 import，共 **168 行**需要改写（移位后深度 +1）。改成 `@/` 别名而非追加 `../`：

- 别名已在 `web/tsconfig.json`（`paths: {"@/*": ["src/*"]}`，`baseUrl: "."`）和 `web/vite.config.ts`（`resolve.alias`）配好，tsc 和 vitest 都能解析
- 这 168 行无论如何都要改，改成别名的 diff 大小一样
- 换来深度无关 —— 以后再动测试文件位置不需要再改 import

### vitest projects

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
        setupFiles: './src/test/setup.ts',
        include: ['src/**/__tests__/integration/**/*.test.{ts,tsx}'],
    }},
  ],
  coverage: { /* 保持在 root，跨 project 汇总 */ },
}
```

`setupFiles` 只挂在 integration 上 —— `src/test/setup.ts` import `@testing-library/jest-dom/vitest` 并 patch `Element.prototype.getAnimations`、`globalThis.ResizeObserver`、`HTMLCanvasElement.prototype.getContext`，在 node env 下会直接崩。

### coverage exclude 清理

| 动作 | 文件 |
|---|---|
| **删除排除项**（已有测试，让覆盖率算进分母） | `Dashboard.tsx` `FileBrowser.tsx` `FileTabs.tsx` `FileViewer.tsx` `QuickCommandsPanel.tsx` `InputPanel.tsx` `env/EnvManager.tsx` `useTerminalStateMachine.ts` `extensions/**` `terminal/Renderer.ts` |
| **保留排除，理由改成诚实措辞 + 登记欠账** | `EnvPanel.tsx` `EnvUploadDialog.tsx` `EnvInlineEditor.tsx` `useEnvManager.ts` `useProbePolling.ts` `useQuickCommands.ts` `useVisibilityReconnect.ts` `useDeepLinkRestore.ts` `TerminalView.tsx` `TerminalWorkspace.tsx` `TerminalLayout.tsx` `DashboardHeader.tsx` `ModeBar.tsx` `SessionsSection.tsx` `RenderTerminal.tsx` `TerminalBanner.tsx`(×2) `TerminalTabs.tsx` |
| **保留排除，理由本来就成立**（已逐项核对确为零测试） | `main.tsx` `vite-env.d.ts` `components/ui/**` `test/**` `MouseIntentResolver.ts` `useSwipeGesture.ts` `SwipeableViewport.tsx` `App.tsx` |

**"covered by E2E" 这个措辞从此不出现在 exclude 注释里** —— smoke 级 E2E 不覆盖这些模块。第二类统一写成 `// 未测 — 欠账 #<issue>`，并在本 spec 落一份清单（见"欠账清单"）。

## E2E 套件

### 位置与结构

放在顶层 `e2e/`，自带 `package.json`。理由：它编排 Rust 二进制 + tmux + 浏览器，不是 web 单独的事；也让 `web/npm ci` 不必背上 Playwright。

```
e2e/
├── package.json              # 只有 @playwright/test
├── playwright.config.ts
├── fixtures/
│   └── agent-config.e2e.toml
├── helpers/
│   ├── stack.ts              # 启栈/停栈、等健康检查
│   └── login.ts              # 登录 + localStorage.clear()
└── specs/
    ├── login.spec.ts
    ├── session-lifecycle.spec.ts
    └── terminal-io.spec.ts
```

### 栈启动

**必须自带 config fixture。** 仓库里的 `agent-config.toml` 不能直接用：

| 字段 | 仓库值 | 问题 | E2E fixture 值 |
|---|---|---|---|
| `server_url` | `ws://nession.nhome.local/ws` | 指向真实部署 | `ws://127.0.0.1:19090/ws` |
| `listen_address` | `0.0.0.0:19090` | 和 server 撞端口 | `127.0.0.1:19091` |
| `connect_url` | `ws://agent.nession.nhome.local/ws` | 指向真实部署 | `ws://127.0.0.1:19091/ws` |
| `auth_token` | `nession-token` | 需与 server 一致 | 空（no-auth 模式） |

**隔离 HOME：** `HOME=/tmp/nession-e2e`，和 CLAUDE.md 的本地 demo 约定一致，避免污染 `~/.nession`。

**Playwright `webServer` 起三个进程**，各自等健康检查通过。顺序有依赖 —— agent 要等 server 起来才能注册：

1. `nession-server`
2. `nession-agent -- fixtures/agent-config.e2e.toml`（依赖 1）
3. `vite preview`（web）

### smoke 覆盖

| spec | 断言 |
|---|---|
| `login.spec.ts` | 输入 token → 进 dashboard，连接状态变 connected |
| `session-lifecycle.spec.ts` | agent 卡片出现 → 建 session → 列表出现 → kill → 列表消失 |
| `terminal-io.spec.ts` | attach → 输入 `echo nession-e2e-ok` → 终端出现该输出；P2P 和 relay 各跑一遍 |

**终端断言读 xterm 的 DOM buffer，不做截图比对。** 截图对渲染差异过于敏感，在 CI 上必然退化成噪声。

### CI

`quality.yml` 加第三个 job `e2e-check`：
- `apt-get install -y tmux`
- `npx playwright install --with-deps chromium`（只装 chromium —— 三个引擎在 smoke 层没有额外价值）
- 失败时上传 Playwright trace 做诊断

## justfile 与 gate 接线

```makefile
# ── Rust 分层 ──
test-unit:                cargo test --workspace --lib
test-integration:         cargo test --workspace --test integration
test:        test-unit test-integration        # 保留原名

# ── Web 分层 ──
web-test-unit:            vitest run --project unit
web-test-integration:     vitest run --project integration
web-test:    web-test-unit web-test-integration

# ── E2E ──
e2e:                      cd e2e && npx playwright test
e2e-ui:                   cd e2e && npx playwright test --ui   # 本地排查

# ── 组合 ──
unit:        test-unit web-test-unit           # 新增，给 pre-commit
quick:       fmt lint                          # 不变
check:       fmt lint coverage                 # 不变（CI rust-check）
pre-push:    test coverage web-test web-coverage   # 不变
```

`test` / `check` / `pre-push` 的名字和语义都不变 —— 现有 hook 和 CI 无需改动就仍然正确，分层是纯增量。

| gate | 现在 | 之后 |
|---|---|---|
| `pre-commit` | fmt, clippy, eslint, tsc | **+ 单元层**（`cargo test --lib` + vitest node project） |
| `pre-push` | test, coverage, web-test, web-coverage | 不变（`test` 现在覆盖两层） |
| CI `quality.yml` | rust-check, web-check | **+ e2e-check** |
| 本地 E2E | —— | 手动 `just e2e` |

pre-commit 加单元层的代价不大：它已经在跑 `cargo clippy --workspace`，编译早就发生，`--lib` 只多出链接和执行；vitest node project 41 个文件不加载 jsdom，秒级。

**顺带修一个既有缺陷：** `pre-commit` 不像 `pre-push` 那样按改动范围收窄，纯 docs 提交也会跑全套。加上单元测试后这个税会被放大，所以同时给 pre-commit 加上 `git diff --cached --name-only` 收窄逻辑（Rust 改动跑 Rust 检查，web 改动跑 web 检查，都没改就跳过）。

## 覆盖率策略

1. **`nession-claude-code` 登记进 `scripts/check-coverage.sh`。** 先 `cargo llvm-cov -p nession-claude-code --json` 量实际值，向下取整到 5 的倍数作为阈值，同时补 `FIX_HINTS`。该 crate 分层后全是单元测试，485 行 src / 16 个测试。

2. **web 阈值重测。** 删掉第一类 exclude 后分母变大，`lines`/`functions`/`statements` 80 + `branches` 65 按实测值重定。**只降不升，且必须在 PR 里记录降的原因** —— 否则这一步就变成用调阈值掩盖覆盖率下滑。

3. **`--skip terminal_io --skip full_chain` 保留，注释写诚实。** 现注释只说了"instrumentation 下太慢"，漏了后半句。这 4 个测试是：

   | 测试 | 位置 | 层 |
   |---|---|---|
   | `test_terminal_io_flow` | `nession-agent/src/server/websocket.rs:1972` | 单元（内联） |
   | `integration_terminal_io_flow` | `nession-agent/tests/server_test.rs:182` | 集成 |
   | `test_terminal_io_through_full_chain` | `nession-agent/tests/e2e_test.rs:241` | 集成 |
   | `relay_attach_and_terminal_io` | `nession-server/tests/relay_integration_test.rs:200` | 集成 |

   补充说明：它们覆盖的代码在覆盖率里被算作未覆盖，现有阈值是在这个前提下定的；且它们仍在 `just test-unit` / `just test-integration` 里照跑 —— **跳过的是测量，不是执行**。

## 迁移顺序与风险

### 最大风险是改丢，不是改坏

这次要移动 118 个文件（16 个 Rust 合并进 3 个 harness、13 个 Rust 搬进内联、89 个 web 移位）。任何测试在搬迁中静默失联，现有 gate 都不会报错 —— 测试变少不会让 CI 变红，覆盖率下滑可以被 exclude 藏住。这个仓库已经踩过这个坑，那份陈旧 exclude 名单就是证据。

### 防线：`scripts/test-inventory.sh`

输出分层测试计数。迁移前基线（已实测）：

```
rust/unit         548
rust/integration  240
web/unit          499
web/integration   382
total            1669
```

在 PR 1 里先加这个脚本并固化上面这份基线，之后每个迁移 PR 前后各跑一次。

**不变量是 `total`，不是各层数字。** 分层本身就会在层间搬动测试 —— 13 个 Rust 文件从 `tests/` 搬进内联会让 `rust/unit` 上升、`rust/integration` 下降；web 的 499/382 划分本来就是按新契约算的，移位后应当保持。所以校验规则是：**`total` 必须恒等于 1669**，各层数字的变化必须能被搬迁计划逐一解释。

这是常驻工具而非一次性检查 —— 以后任何测试重构都用它兜底。

### PR 拆分

| PR | 内容 | base | 依据 |
|---|---|---|---|
| 1 | `test-inventory.sh` + 基线 + Rust 分层 + justfile + claude-code 覆盖率登记 | `staging` | 触碰 `crates/` |
| 2 | web 分层（移位 + `@/` 别名 + vitest projects）+ exclude 清理 + 阈值重定 | `staging` | 触碰 `web/src/` |
| 3 | `e2e/` 套件 + `quality.yml` 的 e2e-check job | `staging` | 触碰 CI + 新目录 |
| 4 | 欠账 issue 登记 | `main` | 纯 docs |

**每个 PR 自带对应的 CLAUDE.md 修改**（第 3 节 Quality Gates 会被 PR 1–3 逐步改旧），而不是最后统一补。文档和代码任何时刻都不脱节。

**顺序不能换。** PR 1 必须最先，因为 `test-inventory.sh` 是 PR 2 的安全网。

### 冲突窗口

PR 2 动 89 个 web 文件，和任何在飞的 web 分支必然冲突。开 PR 2 前先 `gh pr list --base staging` 确认没有在飞的 web 改动，且该 PR 要快进快出。同理 PR 1 之于 Rust 分支。

按 CLAUDE.md 的规则，这些 PR 都不得触碰 `k8s/overlays/**`。

## 欠账清单

以下模块保留 coverage 排除且**确实零覆盖**，需登记为 issue 后续补测试（PR 4）：

| 模块 | 为什么现在没测 |
|---|---|
| `env/EnvPanel.tsx` | WebSocket 集成 |
| `env/EnvUploadDialog.tsx` | 文件上传 + WebSocket |
| `env/EnvInlineEditor.tsx` | WebSocket |
| `env/useEnvManager.ts` | WebSocket |
| `hooks/useProbePolling.ts` | 定时器 + WebSocket |
| `hooks/useQuickCommands.ts` | WebSocket |
| `hooks/useVisibilityReconnect.ts` | 页面可见性 + WebSocket |
| `hooks/useDeepLinkRestore.ts` | react-router 集成 |
| `components/TerminalView.tsx` | 编排层 |
| `terminal/components/TerminalWorkspace.tsx` | 编排层 |
| layout/chrome 组件（`TerminalLayout` `DashboardHeader` `ModeBar` `SessionsSection` `RenderTerminal` `TerminalBanner`×2 `TerminalTabs`） | 纯布局 |

## 范围外（记录，不在本次处理）

1. **根 `package.json` 是垃圾。** 三个 CodeMirror 依赖躺在仓库根目录，其中 `@codemirror/lang-less` 连 `web/package.json` 里都没有。大概是某次在根目录误跑了 `npm install`。
2. **`web/src/test/setup.ts` 有一个 `eslint-disable-next-line`。** CLAUDE.md 明令禁止 `eslint-disable` 注释，这是既有违规（虽然有注释说明理由）。

## 不做什么（YAGNI）

- **不做全流程 E2E 覆盖。** 文件浏览器、各类 viewer、移动端布局、搜索、多标签终端都不进 E2E —— 它们已有组件测试，E2E 重复覆盖只会推高维护成本和 CI 时长。
- **不装三个浏览器引擎。** smoke 层只用 chromium。
- **不做截图回归比对。** 对渲染差异过于敏感，必然变成 CI 噪声。
- **不在 pre-push 跑 E2E。** CLAUDE.md 禁止 `--no-verify`，pre-push 加几分钟的全栈启动是跑不掉的税。
- **不给 E2E 设覆盖率阈值。** E2E 的价值是验证集成路径通不通，用行覆盖率衡量它会诱导写错类型的测试。
