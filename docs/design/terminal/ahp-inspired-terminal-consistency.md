# Terminal 一致性与恢复：借鉴 AHP 的专项目设计

> Requirement: [#1645](https://github.com/BestNathan/nession/issues/1645)
> Status: Proposed / design only. 本文仅讨论 **Nession Terminal**，不引入通用 AHP Host/Channel Framework。
> 对应现有需求：[Terminal Stream & Replay #1094](https://github.com/BestNathan/nession/issues/1094)、[Controller/Observer #1095](https://github.com/BestNathan/nession/issues/1095)、[PTY/TUI #1096](https://github.com/BestNathan/nession/issues/1096)、[Input Delivery #1307](https://github.com/BestNathan/nession/issues/1307)、[SessionRuntime #1309](https://github.com/BestNathan/nession/issues/1309)、[Bootstrap #1491](https://github.com/BestNathan/nession/issues/1491)。
>
> 本文与 [Nession Protocol Unit 规范](../../architecture/protocol.md)、[Terminal Replay](stream-replay.md)、[Terminal 生命周期归属](session-runtime-ownership.md)、[Multi-client ownership](multi-client-ownership.md) 同源；不改变既有协议治理规则。

## 1. 范围与核心判断

唯一目标：**Agent/tmux 与一个或多个 Web/App/CLI xterm 客户端的 Terminal 数据，如何在实时传输、慢消费者、断线、重连、P2P/Relay 切换及进程恢复时保持有序、可验证、可恢复。**

AHP 作为研究参考：[AHP Terminal Channel](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/terminal-channel.md)、[AHP Subscriptions](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/subscriptions.md)、[AHP Reconciliation](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/reconciliation.md)、[AHP TS Broadcast Queue](https://github.com/microsoft/agent-host-protocol/blob/main/clients/typescript/src/client/async-queue.ts)。

借鉴 AHP 的：
- 单个 Terminal 是独立的、具有稳定 identity 的可订阅资源。
- Agent 是权威所有者，客户端通过 Snapshot + 有序增量事件恢复视图。
- 能连续 Replay 时重放缺口，否则重建 Snapshot；不能静默 fast-forward 后宣称一致。
- 多客户端读取同一 Terminal，输入/resize 由 Agent 授权和排序。

**不借鉴/不扩展**：
- 不实现通用 Resource/Channel Registry、Root/Chat/Session/Plugin Channels。
- 不迁移 AI Conversation、Files、Git、Capsule、插件及无关协议。
- 不改变 Nession Server 的 Agent Registry / routing 分工。
- 不采用 AHP 所有的 JSON-RPC/全局 SemVer 或通用 write-ahead optimistic reducers。
- 不将 Terminal input 当作可乐观预测的 state mutation（AHP 也明确禁止）。
- 不声称 bounded replay 可以永远无损；需要公开 retention 截断边界。

## 2. 实际角色与权威

```text
tmux / PTY
   │ (single producer with session-scoped serialization barrier)
   ▼
nession-agent: TerminalStreamOwner
   ├─ stream epoch + ordered (output, resize, reset) events
   ├─ bounded byte-aware replay window
   ├─ checkpoint provider with explicit fidelity
   └─ per-subscriber cursor/queue and control lease
   │
   ├──────── P2P WebSocket ──────────→ Web/App xterm
   │
   └──────── Server Relay ──────────→ Web/App xterm
              (transport only;
               no independently sequenced output)
```

SessionName / TerminalID 复用已有模型；一个 tmux pane/Session 的 Terminal Stream 只有一个 Agent 权威，不能因多个 WebSocket 连接创建多个彼此独立的序列。Observer 和 Controller 均观察同一事件时间线；现有 ControlLease/generation 决定谁可写入 PTY、谁可变更权威尺寸。Server 不维护第二份 Terminal 状态，也不分配 Terminal seq。

xterm Buffer 是可销毁的**客户端物化视图**，不是 Agent stream 的字节级镜像。PTY 输出包含 ANSI 控制序列，输入/尺寸/模式改变会影响最后渲染状态；重绘输出不等于新的历史行。

## 3. AHP 和 VS Code 的适用边界

AHP TerminalState 是 `content[]`（VT output + command metadata），历史保留由 Host 决定；它不是保证完整 alternate-screen、鼠标模式等的 xterm VT checkpoint。AHP 的 `terminal/input` 是 server-side effect-only，不在 reducer 乐观修改 TerminalState。AHP SDK 的 subscription buffers 会在消费者滞后时丢旧事件；Nession 不应复制 silent drop 语义。

VS Code 的 PTY host 支持 headless terminal serializer 与 xterm parser callback 驱动 `acknowledgeDataEvent` / high-low watermark 流控：
- [ptyService.ts XtermSerializer](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts)
- [terminalInstance.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)
- [FlowControlConstants](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts)

**选择**：先保留 tmux，不引入第二套 headless VT emulator；但要证明 tmux 现有 Control Mode capture 与 Agent Stream 的 checkpoint barrier。若无法保证完整 VT 恢复，标记为 `screen-only`，后续通过真实 TUI fixtures 再决定是否加 headless terminal。

## 4. 现有 Nession 代码和差距

| Layer | Existing | Gap |
| --- | --- | --- |
| Agent stream | `crates/nession-agent/src/server/session_terminal.rs`: epoch/seq + 4096-event ring | 仅以事件数量限流，非字节界限；需要可证明 checkpoint cut |
| Agent bootstrap | `crates/nession-agent/src/server/websocket.rs`, tmux capture/control-mode | 失败/无 capture 可能继续 attach；某些 capture 通过独立 tmux 进程，无法自动声称原子边界 |
| Web ordering | `web/src/platform/terminal-runtime/streamReconciler.ts` | frontier 目前代表同步交付 sink，不代表 xterm async parser 已完成 |
| Web renderer | `TerminalController.ts` | 需要统一 SerializedWriter + parser-applied cursor |
| Route | `ConnectionManager.ts`, `SessionRuntime.ts` | P2P 能输出 resume，Relay 需同样 event/cursor；attach成功 ≠ renderer同步完成 |
| History | tmux history, xterm local scrollback, Agent ring | 不能把三种不同 retention 保证混为一谈 |

## 5. Terminal 协议（仅 Terminal，不做泛化）

按现有 [Protocol Unit 命名与版本规范](../../architecture/protocol.md) 增加/升级 Agent-owned Terminal Unit，具体名称须通过协议门禁；候选语义如下：

- `agent.terminal.stream.resume`：用 `stream_epoch + applied_seq` 请求增量事件；返回 `Replay | CheckpointRequired | Unavailable`。
- `agent.terminal.checkpoint`：请求权威 Terminal Checkpoint；返回从哪个有序切点继续。
- `agent.terminal.stream.applied`（或同语义通知）：报告客户端 xterm parser 完成的连续进度。
- 既有 `agent.terminal.output` / resize event：统一在相同 timeline 传送，P2P/Relay 接受相同逻辑载荷。
- 既有 `agent.terminal.input`、Input ACK 与 ControlLease：保持现有专门语义，不混入 output applied cursor。

建议数据（伪类型，实际以 Rust 源码定义并生成 TS）：

```ts
type TerminalEvent =
  | { kind: 'output'; streamEpoch: string; seq: string; bytes: Uint8Array }
  | { kind: 'resize'; streamEpoch: string; seq: string; cols: number; rows: number }
  | { kind: 'reset'; streamEpoch: string; seq: string; reason: string };

type Checkpoint = {
  streamEpoch: string;
  throughSeq: string; // 原子一致的确切边界
  cols: number;
  rows: number;
  representation: 'tmux-pane-capture' | 'vt-serialized';
  fidelity: 'full-vt' | 'screen-only' | 'partial';
  truncated: boolean;
  data: Uint8Array;
};

type Resume =
  | { kind: 'replay'; epoch: string; events: TerminalEvent[]; firstAvailableSeq: string }
  | { kind: 'checkpoint-required'; reason: 'expired' | 'epoch-changed' | 'gap' }
  | { kind: 'unavailable'; reason: string };
```

当前协议的 stream epochs/sequences 是 `u64`，Web 使用 JS number；新契约必须处理 JS safe integer 上限，选 decimal string 或其他精确编码。不要破坏现有旧版客户端，使用 Protocol Unit contract version 与 capabilities 逐步迁移。

### 5.1 不能遗漏的 Snapshot Barrier

```text
Producer writes output seq=100
Producer serializes checkpoint at exact stream cut 100
Producer buffers/retains seq>=101
Client receives checkpoint@100 and applies it completely
Client then applies 101,102,... in order
```

**关键要求**：Checkpoint 是 **截至 seq=100 的 VT 状态**，不是异步 `tmux capture-pane` 之后随便读取当前 seq 再标注 100。独立的 capture 过程有竞态，可能让同一输出存在于快照和增量两处，也可能两者都没有。

首版可以利用 tmux Control Mode 的订阅/捕获同序通道来建立 barrier，并验证多个已附着客户端的 capture 路径；如无法证明线性化，应显式降级为 `partial`/要求后续 TUI redraw，而非称其 complete。

### 5.2 三个独立进度

```text
receivedSeq=120   // transport arrived
appliedSeq=108    // serial xterm.write(data, callback) completed parsing
ackedSeq=100      // this applied cursor acknowledged to Agent
```

不变式 `acked <= applied <= received`（同一 epoch / 同一 xterm instance generation）。

- `StreamReconciler` 的队列用于去重、排序、填缺口，不再直接代表 applied cursor。
- `SerializedXtermWriter` 严格排序 output、resize、checkpoint/reset，完成 xterm write callback 才推进 applied。
- ACK 可按字节/时间/事件批量发送；每个订阅者有独立的未确认字节预算。
- 若 xterm instance 被销毁，原 applied cursor 失效：先重新创建并应用 checkpoint；不能沿用旧 UI 的 ACK。
- `write()` 回调证明解析完成，不证明浏览器已经绘制最后一帧；验收需要区分 parser progress 与 paint latency。

### 5.3 快慢消费者、P2P 与 Relay

- 在 **每客户端** 输出缓冲设置按字节的高/低水位；不能让慢手机用户无限阻塞所有客户端共同的 PTY。
- Agent 内存 replay ring 同时按字节、事件和时间界限裁剪；超过 retention 的 replay 返回明确 `checkpoint-required`。
- Relay 传同一 Agent-assigned epoch/seq，不能用独立 Server seq 代替；经过 P2P→Relay→P2P 切换，客户端逻辑 cursor 与 Agent session 不变。
- 接收队列若 overflow，不许静默跳到最新 seq。状态转为 `needs-resync` 并请求 checkpoint。
- 缺失 capture / 截断 / 无法完成 VT 快照必须是客户端可观察的恢复结果，而不是把 attach 视为同步成功。
- 平台 resize（Observer 本地 viewport 调整）和权威 PTY resize 区分，后者仍须 ControlLease 与 timeline 排序。

## 6. 恢复状态机

```text
Disconnected
  → Attach/Resume
  → ResumeReplay | CheckpointPending | Unavailable
  → ApplyingCheckpoint (if required)
  → CatchingUp (serial output+resize, applied callback)
  → Live (fully applied through known contiguous watermark)
  → Disconnected / NeedsResync (on drop or gap)
```

`transportConnected`、`attached`、`snapshotReceived`、`checkpointApplied`、`caughtUp` 是不同的事实。不得在 attach 成功但 bootstrap 缺失或尚未完成 parser callback 时清除 `historyMayHaveGap`。

## 7. 验收场景（需 E2E 与故障注入）

1. 100k+/1m 编号输出、ANSI 密集 bursts：未超过 retention 的有效窗口无重复/漏序；内存按 bytes 有界。
2. xterm parser 人工降速：received 领先 applied；ACK 不提前；慢客户端退出后健康观察者继续。
3. Snapshot 与高频 live output 并行：切点前后无重复、无缺口，包含多客户端 already-attached。
4. WebSocket 在 Snapshot 中途/Parser backlog 中途断开；保留 xterm 与重建 xterm 两种路径都正确。
5. P2P↔Relay↔P2P：同一 stream epoch、seq，既有事件正常恢复。
6. `claude` / `codex` / `htop` 或等效 fixtures：alternate screen enter/exit、mouse/bracketed paste、resize、redraw 后可见屏幕正确或明确标记 fidelity 限制。
7. 超过 Agent replay retention：绝不静默跳过；请求 checkpoint 或清楚报告历史不可恢复。
8. Agent 重启/stream owner 重建：新的 epoch 防止旧 seq 误去重；tmux 保留 session 仍可重建可见屏幕。
9. 多客户端 Controller/Observer 输入、resize 和控制权转移；observer 无权写入 PTY。
10. Capture 故障：attach 不虚报 `synchronized`，可重试或清楚报告 `partial/unavailable`。

## 8. 最小迁移方案

| Step | Work | Acceptance gate |
| --- | --- | --- |
| A. 基线修正 | Terminal attach/synchronized 明确分离，capture 失败状态可观察；现有 #1491 关联 | 无伪成功 |
| B. Applied ACK | SerializedXtermWriter、parser callback、独立 3 cursors 和按字节流控 | slow-parser fixtures |
| C. Checkpoint | Snapshot barrier、cut seq、fidelity 与 overflow replay fallback | concurrent capture + TUI |
| D. Transport parity | P2P/Relay 统一 Agent 序列恢复和控制权限 | forced relay / route swap E2E |
| E. Optional retention | 若产品需要长期历史，再扩展 durable Journal 和历史只读回放；#1094 是需求归属 | retention / replay acceptance |

**特别注意**：磁盘日志不是第一阶段前置条件；有限内存和 tmux history 无法承诺永久历史全量无损。原始 PTY 输入可能包含密码，默认不纳入 durable replay。

## 9. Non-goals / protection against scope creep

- No general AHP server, agent runtime, channels for sessions/chats, plugin system, or cross-domain reducers.
- No changes to the UI Capsule, provider AI conversations, Git, Files or general network routing architecture.
- No replacement of Nession Protocol Kernel or existing independently versioned contracts.
- No claim that transport ACK is the same as applied/parsed output.
- No claim of exactly-once PTY input across Agent crashes.
- No assumption that a tmux plain capture is a full-fidelity VT checkpoint.

This RFC is intentionally scoped to the original Terminal buffer/recovery problem.
