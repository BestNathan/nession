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

按契约对 29 个 `tests/` 文件实测归类。判据：**起进程**（任何 `Command::new`）、**开端口**（`TcpListener` / `httptest` / `connect_async`）、**真实 DB**（`Database::new|open` / `NamedTempFile`）三者任一命中即为集成。

⚠️ **初稿此处判错了 3 个文件。** 初稿的 grep 只找 `Command::new("tmux"`，漏掉了 `Command::new("cargo")`。实际情况：

| 文件 | 实际行为 | 初稿判定 | 正确判定 |
|---|---|---|---|
| `nession-cli/tests/client_commands_test.rs` | spawn 5 个 `cargo` 子进程 | 单元 ❌ | **集成** |
| `nession-cli/tests/session_commands_test.rs` | spawn 5 个 `cargo` 子进程 | 单元 ❌ | **集成** |
| `nession-cli/tests/update_integration.rs` | 绑 14 个 httptest 端口 | 单元 ❌ | **集成** |

修正后剩余 10 个「单元」文件已用正确判据逐个复核，无更多漏网。**最终划分：10 单元 / 19 集成。**

这个修正顺带解决了一个隐患，见下文「nession-cli 的双重编译」。

**单元层 —— 10 个文件搬进 lib target**

```
nession-common:      config_test.rs   → src/config.rs 内联
                     paths_test.rs    → src/paths.rs 内联
                     protocol_test.rs → src/protocol_tests.rs（sibling）
nession-agent:       config_test.rs   → src/config.rs 内联
nession-claude-code: scanner_tests.rs  → src/scanner.rs 内联
                     security_tests.rs → src/security.rs 内联
                     handler_tests.rs  → 拆分，见下
nession-cli:         terminal_test.rs → src/terminal/raw.rs 内联（注意不是 terminal/mod.rs）
nession-server:      broker_test.rs           → src/broker.rs 内联
                     client_registry_test.rs  → src/server/client_registry.rs 内联
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

只有 `protocol.rs` 过厚，用 sibling 文件。**但模块不能叫 `tests`** —— `protocol.rs` 已有 `#[cfg(test)] mod tests`（739–970 行），再声明一个同名模块是 `E0428`：

```rust
// src/protocol.rs 末尾 —— 与已有的 mod tests 并存
#[cfg(test)]
mod protocol_tests;
```

`mod protocol_tests;` 本身就解析到 `src/protocol_tests.rs`，所以 `#[path]` 属性可以省掉。**约定：以后任何超过约 600 行的源文件，其单元测试都用 sibling 文件模式，模块名取 `<module>_tests` 避免与既有 `mod tests` 冲突。**

（已实测验证该模式：编译通过、`cargo test --lib` 能跑到、`use super::*` 可触及私有项、clippy `-D warnings` 干净、`cargo fmt` 正常格式化 sibling 文件。）

### 内联的逐文件适配

搬迁不是纯移动 —— `tests/` 里的测试把 crate 当**外部依赖**引用（`use nession_common::config::ServerConfig`），内联后它在 crate **内部**，路径全变。逐文件的实测适配点：

| 目标 | 已有 `mod tests`？ | 必须处理 |
|---|---|---|
| `common/src/config.rs` | ✅ 56–103 | 删 `use nession_common::config::…`；**函数体**内 `nession_common::paths::server_db_path()` → `crate::paths::server_db_path()` |
| `common/src/paths.rs` | ✅ 98–187 | 🔴 **6 个测试函数名硬冲突**，见下；🔴 移入的测试须取 `ENV_MUTEX` 锁；🔴 删掉 `#[allow(clippy::expect_used)]`（CLAUDE.md 禁止，且 `clippy.toml` 的 `allow-expect-in-tests` 已使其冗余） |
| `common/src/protocol_tests.rs` | ✅ 739–970（另一个模块） | 模块名必须是 `protocol_tests` 而非 `tests` |
| `agent/src/config.rs` | ✅ 177–318 | 删 `use nession_agent::config::AgentConfig` |
| `claude-code/src/scanner.rs` | ✅ 172–232 | 去掉 `scanner::` 前缀；🔴 **必须保留 `use std::path::PathBuf;`** —— `scanner.rs` 只 import 了 `Path`，`super::*` 供不上 `PathBuf` |
| `claude-code/src/security.rs` | ❌ 需新建 | 去掉 `security::` 前缀 |
| `cli/src/terminal/raw.rs` | ✅ 581–749 | 🔴 **删掉移入文件的 `use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};`** —— 目标模块 584 行已有完全相同的一行，重复显式 import 是 `E0252`；`use tokio::sync::{mpsc, watch}` 收窄为 `mpsc`（`watch` 由 `super::*` 提供） |
| `server/src/broker.rs` | ❌ 需新建 | 删 `use nession_server::broker::ConnectionBroker` |
| `server/src/server/client_registry.rs` | ❌ 需新建 | 两个 import 都删，`use super::*;` 覆盖（注意 `super` 深度：测试模块内 `super` = `client_registry`，而文件自身第 6 行的 `super` = `server`） |

**`paths.rs` 的 6 个硬冲突**（`test_nession_home`、`test_server_dir`、`test_agent_dir`、`test_server_db_path`、`test_server_pid_path`、`test_agent_pid_path` 六个名字目标模块里全都已存在）：

处置是**重命名而非删除**。已有的 6 个用 `.ends_with(...)` 断言，移入的 6 个断言与 `dirs::home_dir()/.nession` 精确相等 —— 后者是更强的断言，两者都有价值。移入的加 `_exact` 后缀。

**本次重构不删除任何测试。** 有若干测试与目标模块已有测试语义重叠（`protocol` 的 `test_message_new`、`agent/config` 的 `test_agent_config_default(s)`、`raw.rs` 的按键转换与 extract-output 系列），删掉它们或许是对的，但那是独立的判断题，混进结构性重构会让 `test-inventory.sh` 无法区分「搬丢了」和「故意删了」。**结构重构保持行为不变，语义剪枝另开 PR。**

**`claude-code/tests/handler_tests.rs` 目标要拆。** 它的 3 个测试没有一个碰 `agent.rs`：`full_scan_and_read_flow` 走 `scanner::scan_claude_dir` → 进 `scanner.rs`；`file_too_large_detection` 只用 `security::MAX_FILE_SIZE` → 进 `security.rs`；`pagination_logic` 对一个局部 `String` 做纯算术，**不碰 crate 里任何代码** —— 按不删除原则先随 `scanner.rs` 搬走，同时登记为欠账（它应该被删或改写成真正测分页逻辑）。

**nession-cli 的双重编译（既有问题，本次不修）。** `crates/nession-cli/src/main.rs` 第 6–14 行重新声明了 `mod commands / update / client / terminal / utils`，而不是依赖自己的 lib。这些文件因此同时编进 lib 和 bin 两个 target，其中的内联测试**跑两遍**（已实测确认：`update::tests::binary_status_name_*` 在 `unittests src/lib.rs` 和 `unittests src/main.rs` 各跑一次）。

上面把 3 个 CLI 文件正确归类为集成，顺带避开了最坏的后果 —— 那 10 个 `cargo run --bin nession` 子进程测试和 14 个 httptest 端口不会翻倍。留下的 `terminal_test.rs` 有 8 个纯内存测试，跑两遍无害只是浪费。

根治办法是让 `main.rs` 改用 `use nession_cli::…` 消费 lib，但那是独立的重构，登记为欠账，不塞进本次。

**集成层 —— 19 个文件收成 3 个 harness**

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
├── attach_session.rs    # ← attach_session_test.rs
├── client_commands.rs   # ← client_commands_test.rs（spawn 子进程）
├── session_commands.rs  # ← session_commands_test.rs（spawn 子进程）
└── update.rs            # ← update_integration.rs（绑 httptest 端口）
```

`nession-common` 和 `nession-claude-code` 分层后没有集成测试 —— 它们是纯库，符合预期。

**cargo 会自动发现 `tests/integration/main.rs` 并命名 target 为 `integration`**，无需改 `Cargo.toml`（三个 crate 都没有 `[[test]]` 段）。也无任何工具按 target 名引用测试 —— `justfile`、`scripts/filtered-test.sh` 用 `cargo test --workspace`，`check-coverage.sh` 用 `cargo llvm-cov -p <crate>`，所以重命名 target 是安全的。

**收益：**
- `cargo test --lib` 精确跑单元层，`cargo test --test integration -p <crate>` 精确跑集成层
- test binary 从 16 个降到 3 个，链接次数大幅下降，集成层编译显著变快
- `main.rs` 承接跨文件重复的 helper，去重顺带做掉

**helper 去重的实测范围**（比初稿预估的小得多 —— 初稿断言 `TestServer`/`unique_session_name`/`current_timestamp` 各重复 3 次以上，实测不成立）：

| Crate | helper | 实际情况 | 处置 |
|---|---|---|---|
| server | `current_timestamp` | 2 处定义，**字节相同** | 提到 `main.rs` |
| server | `TestServer` | **仅 1 处定义**（`integration_test.rs`），无重复 | 不动 |
| server | `unique_session_name` | **仅 1 处定义**（`relay_integration_test.rs`），无重复 | 留在 `relay.rs` |
| server | `ts()` | `current_timestamp` 的同义异名版 | 可选 `use crate::current_timestamp as ts;` |
| agent | `unique_session_name` | **5 处定义**，其中 4 处相同 | 相同的 4 处提到 `main.rs` |
| agent | └ `control_mode_test.rs` 的那份 | **语义不同** —— 前缀多一段 `ctrl-` | **保留为模块私有**，不引用 crate 根的版本 |
| agent | `start_mock_server` | 2 处，签名相同但**函数体不同**（channel 容量 100 vs 200；转发循环 clone-并忽略错误 vs 无 clone-出错即 break） | **本次不提取** —— 统一会改变 `connection.rs` 的行为 |
| agent | `start_server(_port)` / `start_test_agent_server()` | 函数体字节相同，仅名字不同且前者有个被丢弃的 `_port` 参数 | **本次不提取** —— 需改 18 处调用点，收益不抵风险 |
| cli | —— | 单文件，无重复 | 不动 |

**提取 helper 后必须裁剪 import，否则 `-D warnings` 直接失败。** 四个文件的 `std::time` import 会因为 helper 搬走而变成未使用：`websocket.rs`、`full_stack.rs`（server）、`server.rs`、`sync.rs`（agent）。CLAUDE.md 禁止 `#[allow(...)]`，所以这是硬失败而非警告。

**新增的并发暴露面。** `cargo test` 顺序跑各 test binary，但**同一 binary 内的测试并行跑**。agent 从 6 个 binary 合成 1 个，意味着 `tmux.rs`、`control_mode.rs`、`server.rs`、`sync.rs`、`full_chain.rs`、`connection.rs` 的测试第一次同时并发。这一点需要留意：`control_mode` 在 macOS 被跳过的原因恰恰是**并行**的 control-mode 客户端会让 tmux 3.6b 崩溃，合并后 Linux CI 上的并发暴露只增不减。固定端口已核对无冲突（`connection` 用 29081–29085，`sync` 用 29091–29095，其余绑 `127.0.0.1:0`）。若合并后出现 flake，处置手段是 `--test-threads` 或 `cargo-nextest`（按测试隔离进程），而不是把测试改脆。

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

已对实际安装的 vitest **4.1.9** 核验（读 `web/node_modules/vitest/` 的类型定义与运行时代码，非凭记忆）：

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
  // coverage / onConsoleLog / globals 必须留在 root —— 见下
}
```

核验结论：

| 事项 | 结论 |
|---|---|
| `test.projects` | ✅ 4.x 正确写法。`test.workspace` 与独立的 `vitest.workspace.ts` 在 4.x 已**移除**（`workspace?:` 在全部类型定义里零匹配） |
| `extends: true` | ✅ **必需，不是可选**。它让子 project 加载根配置文件本身，从而继承 `plugins`（react、tailwindcss）和 `resolve.alias`。不加则子 project 拿到裸 Vite server —— 没有别名、没有 react 插件，`.tsx` 测试**直接编译失败** |
| `coverage` 放哪 | ✅ 只能在 root。它在类型层面被 `NonProjectOptions` 排除，运行时也由 root 强制注入。已实测跨 project 汇总正常 |
| `onConsoleLog` | ✅ 同样在 `NonProjectOptions` 里，必须留 root（`reporters`/`silent`/`passWithNoTests` 同理） |
| `globals: true` | ✅ 经 `extends: true` 自动继承，**不要**在 project 里重复 |
| `--project unit` | ✅ 单数、可重复、支持 `*` 通配与 `!` 取反 |

**🔴 一个会让覆盖率门禁失效的陷阱:`--project` 过滤后的运行仍然按完整的 `coverage.include` glob 计算覆盖率。** 实测：只跑 `unit` project 加 `--coverage`，statements 掉到 40%、lines 33%，会直接跌破阈值 —— 因为分母仍是 `src/**/*.{ts,tsx}` 全量，而分子只有 unit 层跑到的部分。

所以 **`just web-coverage` 必须跑全部 project**，`--project` 只用于本地快速迭代，**永远不与 `--coverage` + 阈值同用**。`scripts/filtered-web-test.sh` 现在不传 `--project`，保持原样即可。

**🔴 配置改动与文件移动必须落在同一个 commit。** 上面的 include glob 今天匹配 **0 个文件**（`__tests__/unit/` 和 `__tests__/integration/` 目录都还不存在，89 个文件都直接躺在 17 个 `__tests__/` 里）。若先改配置后移文件，中间状态是一个「跑了 0 个测试却绿灯」的套件。

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
│   ├── server/
│   │   └── config.toml       # server 的 CWD 必须是这个目录，见下
│   └── agent-config.e2e.toml
├── helpers/
│   ├── reset.ts              # 清 localStorage + sessionStorage
│   └── dashboard.ts          # 等待 dashboard 就绪
└── specs/
    ├── login.spec.ts
    ├── session-lifecycle.spec.ts
    └── terminal-io.spec.ts
```

fixture 放 `e2e/fixtures/` 而不是仓库根 —— 根目录的 `agent-config.toml` 被 `.gitignore` 第 98 行以字面量忽略（且它本来就未被 git 跟踪，尽管 CLAUDE.md 把它列在项目结构里）。放 `e2e/fixtures/` 不受该规则影响，可以提交。

### 🔴 起栈:CLAUDE.md 记的运行时事实是错的

原稿基于 CLAUDE.md 设计了 HTTP 健康检查。实际核验后该方案不成立：

| CLAUDE.md 声称 | 代码实际 |
|---|---|
| server = 19090 ws + **10080 http**；agent = 19090 ws + 10080 http | **两个二进制都没有 HTTP 监听。** 整个工作区没有 axum / warp / hyper / actix 任何依赖，都是 `tokio-tungstenite` 的 `accept_async` 直接架在裸 `TcpListener` 上，每进程**只有一个**监听 socket |
| 存在 `/health` 健康检查 | `/health` 只出现在 `deploy/nginx.conf.template` 和 `deploy/entrypoint-server.sh` —— 它是 **nginx sidecar 的产物**，不是二进制的能力。端口 10080 同理，是 nginx 的端口 |
| server 监听 `127.0.0.1:19090` | server 硬编码读 **CWD 下的 `config.toml`**，无 CLI 参数、无环境变量覆盖；文件不存在时回落到 **`127.0.0.1:8080`**（刻意覆盖了结构体默认的 `0.0.0.0:19090`）。而 `config.toml` 在仓库里**不存在** |
| agent 监听 `19091` | agent 默认 `default_listen_address()` = **`0.0.0.0:8080`** |

由此得出三条硬约束：

**1. 健康检查只能用 TCP 连接探测，不能用 HTTP。** Playwright 的 `webServer` 支持 `url`（HTTP GET）或 `port`（TCP connect）二者之一。两个 Rust 进程必须用 **`port:`**；只有 `vite preview` 能用 `url:`。已实测：向 server 端口发普通 `curl` 返回空响应 —— 非 WebSocket 升级请求会被直接丢弃。（另实测：WS 升级在**任意路径**上都成功，`/` 和 `/ws` 都返回 101，所以探测路径无关紧要。）

**2. server 的配置只能通过 CWD 下的 `config.toml` 注入。** 没有第二种机制。所以 Playwright 启 server 时必须设 `cwd: 'fixtures/server'`，并把 `config.toml` 放在那里。`ServerConfig` 的前四个字段（`listen_address`、`tls_cert_path`、`tls_key_path`、`auth_token`）**没有 serde 默认值**，TOML 里必须全写。`db_path` 指向临时目录，避免碰 `~/.nession`。

**3. 两边端口必须显式写死 —— 默认值会撞,而且撞法因平台而异。** server 默认 `127.0.0.1:8080`、agent 默认 `0.0.0.0:8080`。已实测（macOS）：特定地址绑定与通配地址绑定同一端口**双双成功、零报错**，两个进程共用一个端口，连接由内核按地址 specificity 分流；Linux 上通常直接 `EADDRINUSE`。**依赖默认端口的 fixture 会在本地和 CI 上表现不同** —— 这类 bug 极难查，必须从一开始就写死。

另一个坑：仓库根的 `agent-config.toml` 把 `listen_address` 设成 `0.0.0.0:19090`，而那正是 `web/vite.config.ts` 给 **server** 代理 `/ws` 的目标端口。拿它跑 agent 会让 agent 占住 server 的代理目标。

**端口分配（fixture 写死）：** server `127.0.0.1:19090`（必须是这个 —— vite 代理目标写死了它），agent `127.0.0.1:19091`。

### vite preview 可用 —— 已核验它继承 /ws 代理

读 Vite 源码 `resolvePreviewOptions` 确认：`proxy: preview?.proxy ?? server.proxy` —— **`server.proxy` 会被继承**；而 `port: preview?.port` —— **`server.port` 不继承**，回落到 `DEFAULT_PREVIEW_PORT = 4173`。实测也确认 `/ws` 在 preview 上被代理（后端未起时返回 500，证明中间件已挂载）。

所以构建产物是**经 vite 代理**访问 server 的：`DEFAULT_SERVER_URL` = `ws://${window.location.host}/ws` → `ws://localhost:4173/ws` → 代理到 `ws://localhost:19090`。这也是上面 server 端口必须是 19090 的原因。

**🔴 `baseURL` 必须写 `http://localhost:4173`,不能写 `127.0.0.1`。** 实测 preview 默认只绑 `[::1]`（IPv6 localhost）：`curl http://127.0.0.1:4173/` 返回 `000`，`curl http://localhost:4173/` 返回 `200`。（或者给 preview 命令加 `--host 127.0.0.1`。）

**preview 的健康检查不能用路径判断。** SPA fallback 让**任意路径**都返回 200，所以 200 只能证明静态服务器起来了，不能证明应用就绪。就绪判断交给测试里的 dashboard 等待。

### smoke 覆盖

| spec | 断言 |
|---|---|
| `login.spec.ts` | 走**真实表单**：填 `#serverUrl` + `#authToken` → 点 `Connect` → dashboard 出现 |
| `session-lifecycle.spec.ts` | agent 卡片出现 → 建 session → 列表出现 → kill → 列表消失 |
| `terminal-io.spec.ts` | attach → 输入 `echo nession-e2e-ok` → 终端出现该输出；P2P 和 relay 各跑一遍 |

**终端断言读 xterm 的 DOM buffer，不做截图比对。** 截图对渲染差异过于敏感，在 CI 上必然退化成噪声。

**选择器（已从代码核验）：**

- 登录：`#serverUrl`（`Server URL` label）、`#authToken`（`Auth Token` label）、按钮可访问名 `Connect`。表单在 `isConnecting` 时全部 disabled，点击后不能再改填。
- **🔴 不要用 `h1` 判断是否已登录。** `<h1>Nession</h1>` 在 `LoginPage.tsx` 和 `DashboardHeader.tsx` 里**都有**，无法区分。用 `[data-testid="filter-row"]`（`SearchBar.tsx`，全宽度渲染，从不隐藏）。避免 `data-testid="agent-summary-bar"`（`md:hidden`，仅移动端）和 `features-card`（`hidden md:block`）。

**其余两个 spec 用 URL 参数免登录。** `App.tsx` 支持 `?token=<非空值>` 自动连接，跳过整个表单。查询串必须在 hash **之前**（应用用 `createHashRouter` 但读 `window.location.search`）；`?token=` 空值会设置 autoConnect 但 `authToken` 为假值，**不会**连接。server 处于 no-auth 模式时任意非空值都通过。只有 `login.spec.ts` 走真实表单 —— 那正是它要测的东西。

**重置必须清两个 storage。** `web/src/lib/auth.ts` 的 `getToken()` 先读 **sessionStorage** 再读 localStorage。只清 localStorage 不够。需清的键：`token`、`remember`、`nession_server_url`。

**no-auth 模式条件（已核验）：** `handler.rs` 两处守卫都是 `self.config.server_auth_token.is_empty() || 提交值 == 配置值`。所以 server 端 `auth_token` 留空即为 no-auth，客户端任意非空 token 均可 —— 但客户端必须**发**点什么。

### CI

`quality.yml` 加第三个 job `e2e-check`：
- `apt-get install -y tmux`
- `npx playwright install --with-deps chromium`（只装 chromium —— 三个引擎在 smoke 层没有额外价值）
- 失败时上传 Playwright trace 做诊断

## justfile 与 gate 接线

```makefile
# ── Rust 分层 ──
test-unit:                ./scripts/filtered-test.sh --lib
test-integration:         ./scripts/filtered-test.sh --test integration
test:        test-unit test-integration        # 保留原名

# ── Web 分层 ──
web-test-unit:            ./scripts/filtered-web-test.sh --project unit
web-test-integration:     ./scripts/filtered-web-test.sh --project integration
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

**新 recipe 必须走两个 filter 脚本，不能直接调 cargo / vitest。** `filtered-test.sh` 把 cargo 输出收敛成「失败 + panic + 汇总」并附调试提示，`filtered-web-test.sh` 过滤 jsdom 噪音、预检 `node_modules`、按失败模式给针对性建议。绕过它们会让分层顺带把这些诊断能力删掉。两个脚本目前都写死了 cargo/vitest 参数，需要改成透传 `"$@"`：

| 脚本 | 现在 | 改成 |
|---|---|---|
| `filtered-test.sh` | `cargo test --workspace --color=always` | `cargo test --workspace --color=always "$@"` |
| `filtered-web-test.sh` | `if [ "$1" = "--coverage" ]` 二选一分支 | 透传 `"$@"`，`--coverage` 不再特殊处理（vitest 自己认这个 flag） |

**`--lib` + `--test integration` 覆盖面已核验，不比 `cargo test --workspace` 少任何唯一测试：**

| target 类型 | `cargo test --workspace` 跑 | 分层后 | 结论 |
|---|---|---|---|
| lib | ✅ | ✅ `--lib` | —— |
| `tests/*` | ✅ | ✅ `--test integration`（分层后只剩这一个 target） | —— |
| bin | ✅ | ❌ 不跑 | `server`/`agent` 的 `main.rs` 零测试；`cli` 的 bin target 只含**与 lib 重复**的那批（见「双重编译」），无唯一测试丢失 —— 反而少跑一遍 |
| doc | ✅ | ❌ 不跑 | 已实测全仓库仅 1 处 ``` 围栏，是 `logging.rs` 的 ```toml 配置示例，rustdoc 不当 doctest 编译。**零 doctest** |

**`--workspace --test integration` 对没有该 target 的 crate 不报错。** 已实测：`cargo test --workspace --test db_test --no-run` 在只有 `nession-server` 拥有该 target 的情况下正常完成，未对其余 4 个 crate 报「no test target」。所以 `nession-common` / `nession-claude-code` 分层后没有 `tests/integration/` 也不会让这条 recipe 失败。（三个 crate 的 `Cargo.toml` 均无 `[[test]]` 段，target 名由 cargo 自动取目录名 `integration`。）

`test` / `check` / `pre-push` 的名字和语义都不变 —— 现有 hook 和 CI 无需改动就仍然正确，分层是纯增量。

| gate | 现在 | 之后 |
|---|---|---|
| `pre-commit` | fmt, clippy, eslint, tsc | **+ 单元层**（`cargo test --lib` + vitest node project） |
| `pre-push` | test, coverage, web-test, web-coverage | 不变（`test` 现在覆盖两层） |
| CI `quality.yml` | rust-check, web-check | **+ e2e-check** |
| 本地 E2E | —— | 手动 `just e2e` |

pre-commit 加单元层的代价不大：它已经在跑 `cargo clippy --workspace`，编译早就发生，`--lib` 只多出链接和执行；vitest node project 41 个文件不加载 jsdom，秒级。

**修正初稿的一个错判：`pre-commit` 已经按改动范围收窄了。** 初稿说它「不像 pre-push 那样收窄」，读代码后不成立 —— `.githooks/pre-commit` 第 10–12 行就在读 `git diff --cached --name-only`，第 21 行 `[ -n "$STAGED_RUST" ]` 与第 32 行 `[ -n "$STAGED_TSX" ]` 已经是范围守卫。所以**没有缺陷要修**，只需把单元测试步骤加进这两个既有分支里（Rust 分支加 `just test-unit`，web 分支加 `just web-test-unit`），范围收窄自动继承。

## 覆盖率策略

1. **`nession-claude-code` 登记进 `scripts/check-coverage.sh`，阈值 55%。** 已实测：**56%**（174/309 可执行行）。按"向下取整到 5 的倍数"定 55%，同时补 `FIX_HINTS`。

   **这个数字比预期低得多**，与其他核心 crate 的 80% 差距明显。登记 55% 的作用是**锁住地板、防止继续下滑**，不代表达标。把"将 `nession-claude-code` 提到 80%"登记为欠账 issue。不在本次补测试 —— 那会把一个结构性重构 PR 变成混合了新测试的大 PR，评审质量下降。

2. **另需实测的一处：helper 搬迁对分母的影响。** `check-coverage.sh` 用 `endswith("/main.rs")` 排除文件。旧的 `tests/db_test.rs` 等不以 `main.rs` 结尾、其行数计入分母；新增的 `tests/integration/main.rs` 会被排除。所以被提取到 `main.rs` 的 helper 行数从"计入"变为"排除"。影响应该很小，但必须在迁移前后各跑一次 `./scripts/check-coverage.sh` 对比 `[covered/count]` 实数，而不是只看百分比。

3. **web 阈值重测。** 删掉第一类 exclude 后分母变大，`lines`/`functions`/`statements` 80 + `branches` 65 按实测值重定。**只降不升，且必须在 PR 里记录降的原因** —— 否则这一步就变成用调阈值掩盖覆盖率下滑。

4. **`--skip terminal_io` 保留、`--skip full_chain` 删除。** 现注释只说了"instrumentation 下太慢"，漏了后半句。这 4 个测试是：

   | 测试 | 位置 | 层 |
   |---|---|---|
   | `test_terminal_io_flow` | `nession-agent/src/server/websocket.rs:1972` | 单元（内联） |
   | `integration_terminal_io_flow` | `nession-agent/tests/server_test.rs:182` | 集成 |
   | `test_terminal_io_through_full_chain` | `nession-agent/tests/e2e_test.rs:241` | 集成 |
   | `relay_attach_and_terminal_io` | `nession-server/tests/relay_integration_test.rs:200` | 集成 |

   补充说明：它们覆盖的代码在覆盖率里被算作未覆盖，现有阈值是在这个前提下定的；且它们仍在 `just test-unit` / `just test-integration` 里照跑 —— **跳过的是测量，不是执行**。

   **`--skip full_chain` 必须在本次删除，否则分层会静默破坏覆盖率。** libtest 的 `--skip` 是对**完整测试路径**做子串匹配。`e2e_test.rs` 含 7 个测试，改名为 `full_chain.rs` 后它们全部变成 `full_chain::*`，于是 `--skip full_chain` 会把 7 个全部排除在测量之外，而非预期的 1 个：

   ```
   full_chain::test_terminal_io_through_full_chain        ← 唯一想跳过的
   full_chain::test_full_agent_server_integration         ← 会被误跳
   full_chain::test_client_connects_to_agent_via_p2p      ← 会被误跳
   full_chain::test_session_lifecycle                     ← 会被误跳
   full_chain::test_agent_reconnects_after_server_restart ← 会被误跳
   full_chain::test_multiple_agents_register              ← 会被误跳
   full_chain::test_graceful_shutdown                     ← 会被误跳
   ```

   `nession-agent` 阈值卡在 80%（macOS 79%）的边缘，少 6 个测试的覆盖贡献很可能直接跌破。

   而 `--skip full_chain` **现在就已经是冗余的** —— 它唯一要跳过的 `test_terminal_io_through_full_chain` 名字里含 `terminal_io`，已被另一个 filter 匹配。所以删掉它既消除隐患又不改变当前行为。

   不采用「把模块改名成 `e2e.rs` 来避开子串」的做法 —— 那与本设计"Rust 侧不使用 e2e 一词"的决定冲突。模块名保持 `full_chain.rs`，改的是脚本。

## 迁移顺序与风险

### 最大风险是改丢，不是改坏

这次要移动 118 个文件（19 个 Rust 合并进 3 个 harness、10 个 Rust 搬进内联、89 个 web 移位）。任何测试在搬迁中静默失联，现有 gate 都不会报错 —— 测试变少不会让 CI 变红，覆盖率下滑可以被 exclude 藏住。这个仓库已经踩过这个坑，那份陈旧 exclude 名单就是证据。

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

**PR 3 另需修正 CLAUDE.md 里的错误运行时事实**（不是被本次改动改旧的，是本来就写错的）：

| 位置 | 现在写的 | 应改成 |
|---|---|---|
| Service ports 表 | `nession-server 10080 HTTP (health, UI)`、`nession-agent 10080 HTTP (health)` | 二进制无 HTTP 监听；10080 与 `/health` 属于 nginx sidecar，只在 Docker/k8s 运行时存在 |
| 本地 demo 段 | 「Server listens on 127.0.0.1:19090 (ws) + :10080 (http), agent on :19091」 | server 无 config.toml 时回落 `127.0.0.1:8080`；agent 默认 `0.0.0.0:8080`；两者默认撞端口，必须显式配置 |
| 项目结构 | 把 `agent-config.toml` 列为「Default agent config」 | 该文件被 `.gitignore` 忽略且未被跟踪，是本地文件而非仓库内容 |

这三条是排查 E2E 起栈问题时踩出来的。留着它们，下一个照文档搭本地环境的人会踩同样的坑。

**顺序不能换。** PR 1 必须最先，因为 `test-inventory.sh` 是 PR 2 的安全网。

### 冲突窗口

PR 2 动 89 个 web 文件，和任何在飞的 web 分支必然冲突。开 PR 2 前先 `gh pr list --base staging` 确认没有在飞的 web 改动，且该 PR 要快进快出。同理 PR 1 之于 Rust 分支。

按 CLAUDE.md 的规则，这些 PR 都不得触碰 `k8s/overlays/**`。

## 欠账清单

以下模块保留 coverage 排除且**确实零覆盖**，需登记为 issue 后续补测试（PR 4）：

| 模块 | 为什么现在没测 |
|---|---|
| `nession-claude-code` 整个 crate | 覆盖率仅 56%，本次只锁 55% 地板，需提到 80% |
| `nession-cli/src/main.rs` 的模块重复声明 | 它重新声明 `mod commands/update/client/terminal/utils` 而不消费自己的 lib，导致内联测试跑两遍。根治需独立重构。 |
| `claude-code` 的 `pagination_logic` 测试 | 对局部 `String` 做纯算术，不碰 crate 任何代码 —— 应删除或改写成真正测分页 |
| 语义重叠的重复测试 | `protocol::test_message_new`、`agent/config` 的 `test_agent_config_default(s)`、`raw.rs` 的按键转换系列 —— 结构重构不动它们，剪枝另开 PR |
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
