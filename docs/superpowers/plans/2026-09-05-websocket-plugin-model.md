# WebSocket Plugin Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web/src` 的 WebSocket 层收敛为唯一纯连接类 `new WebSocketService(url, plugins, options?)` + 能力插件挂载模型 `features/<name>/`;public `connected` = handshake 完成;合入即全量切换,无 legacy/无兼容层/无 `@deprecated`。

**Architecture:** `SocketCore`(lifecycle)+ `MessageRouter`(correlation)演进为 `services/socket/WebSocketService.ts`(readiness gate: handshake 成功才 `connected`;plugin registry: 构造期 install 一次,reconnect 不重装)。server/agent 差异全部表达为 url + `options.handshake` + plugins 数组。业务 wire protocol 全量迁入 `web/src/features/<name>/`,feature 实例即 typed API(server 应用级 = 模块单例,文件/agent-terminal = factory-per-connection);`useAppConnection` 唯一持有 server 连接,`SessionRuntime` 持有 agent 连接。状态机/时序职责(`AttachStateMachine`/`SessionAttachController`/`ConnectionManager`)不动,只换底层依赖。

**Requirement:** [#631](https://github.com/BestNathan/nession/issues/631)(Approved)。Design 拍板见 `docs/superpowers/specs/2026-09-05-websocket-plugin-model-design.md`(Q1–Q3、D4–D12)。**本计划是 D 决议的实现,冲突时以本计划为准并回写 spec。**

**Base branch:** `origin/staging`(worktree `feat/websocket-plugin-model`,branch `feat/websocket-plugin-model` — 已创建,PR 目标 `staging`)。

**Tech Stack:** TypeScript 5.3 + React 18 + Vite/Vitest(jsdom),结构沿用现有 `services/socket` 惯例;xterm/UI 行为不变;Rust 侧零改动。

---

## 0. 执行纪律(每个 Task 都必须遵守)

1. **只在本 worktree 工作**:`/Users/admin/workspace/learn/nession/.claude/worktrees/feat-websocket-plugin-model`,分支 `feat/websocket-plugin-model`。先 `git branch --show-current` 确认不是 main。
2. **每次提交都走 hooks**(禁止 `--no-verify`)。web 改动会自动触发 pre-commit(`just web-lint` = eslint + tsc)与 pre-push(web-test + web-coverage)。
3. **每个 Task 结束的验收命令**(在 worktree 的 `web/` 下):
   ```bash
   npm run lint && npx tsc --noEmit && npm test && npm run coverage
   ```
   最后跑 `npm run build`。提交前先跑一遍;失败必须修代码,禁止改 lint 规则/vite 阈值/加 `eslint-disable`/`@ts-ignore`。
4. **TDD**:先写/改测试(红)→ 实现 → 全绿 → 提交。提交信息按仓库惯例(`feat(web): …`/`refactor(web): …`),Co-Authored-By Claude。
5. **行为回归零容忍**:每个 Task 改完必须跑相关既有套件(见各 Task「验证」),尤其 attach/env/commands/claude-code/files/reconnect/re-login。
6. **feature 新代码必须自带测试**,否则覆盖率阈值(web: lines≥78 / funcs≥72 / branches≥65 / stmts≥76)会红。改完后跑 `npm run coverage` 自查(除 Task 8 的纯删除可能提升外,任何 Task 不得让覆盖率低于基线)。
7. 中途允许新旧并存(**为了单分支可编译**),但:不允许写 `@deprecated`;不允许新增 shim 给最终要删的东西续命;Task 8 全部清掉。**合入(merge)时旧树必须不存在**。
8. 每个 Task 开始前 `git fetch origin && git merge --ff-only origin/staging`(在 worktree 内拉 staging 的推进,仍保持 fast-forward;若 staging 有进展)。结束后 commit。

---

## 1. 现状速览(必读,已在 spec §2 详述)

- **两层传输并存**:
  - `services/socket/SocketCore.ts`(403 行)—— 唯一 lifecycle(连接/重连/backoff/generation guard/parse/binary/request 超时),构造时可选 `handshake`(但**先 `setState('connected')` 再跑 handshake** → 需改成 handshake 成功才 connected)。
  - `services/socket/MessageRouter.ts`(`MessageRouterImpl`,124 行)—— type-keyed subscribe + request correlation + binary,逻辑层、跨物理 socket 存活。
  - `AgentSocketClient`(121,url token 版壳)+ `ServerSocketClient`(137,`WebSocketServiceCoreImpl` 的 SocketClient 适配)+ `P2PConnectionAdapter`(43,legacy `P2PConnection` shape)+ `agentSocketUtils`(URL/backoff 常量)+ `p2pTypes`(21)+ `types.ts`(38:SocketMessage/ConnectionState/MessageRouter/SocketClient/AgentConnection)。
  - 旧 facade 树 `services/websocket/`:`WebSocketService.ts`(395,use/unregister/getCapability + ~30 个业务代理方法)、`core.ts`(`WebSocketServiceCoreImpl`,175,server auth = `client.auth` handshake、client_id 存 localStorage)、`types.ts`(WebSocketPlugin/WebSocketServiceCore)、`plugins/{EventPlugin(201), RequestPlugin(326), TerminalPlugin(87), ClaudeCodePlugin(68)}` + `__tests__`;顶层 shim `services/websocket.ts`(38,`create/get/destroyWebSocketService` 单例)。
- **消费方**(全部名单见 spec §2.2/§2.3):`useAppConnection`(唯一单例 owner)、`useWebSocket` context、`runtime/SessionRuntime`(600,持有 AgentSocketClient + FileCapability + attach/relay 时序)、`terminal/ConnectionManager`(277,P2P 腿走 legacy `sendMessage/onMessage`,relay 腿走 facade `sendRelayInput/sendRelayResize/onTerminalOutput/onTerminalResize/onConnectionChange`)、`hooks/useSessionRuntime.ts`(409,把 runtime mirror 到 Jotai;`serverConnection` = facade 窄句柄)、Dashboard/env/commands/claude-code 组件群。
- **wire string 权威分布**:server 侧 `client.auth`/`client.agents.list(.response)`/`client.agent.rename|delete`/`client.server.info`/`client.sessions.list(.response)`/`client.session.attach|create|kill|capture_preview|env.apply|env.unset|env.active|env.query`/`client.env.list|get|write|delete`/`client.commands.list|add|remove|update`/`extension.claude_code.list|read`/`client.session.relay.begin|end`/`terminal.input|resize|output`/`agents.changed`/`sessions.changed`/`server.commands.changed` 全部在 `services/websocket/{core.ts, plugins/*.ts}`;agent/P2P 侧 `client.attach` 在 `runtime/SessionAttachController.ts`(legacy twin 在 `terminal/hooks/useTerminalStateMachine.ts`)、`terminal.input|resize` + `keepalive.ping|pong` + `ok|error` 在 `terminal/ConnectionManager.ts`、`__binary__` 由 `SocketCore` 转 `onBinary`、`file.*` 在 `runtime/FileCapability.ts` 与 `services/fileOps.ts`(两份重复)。
- **可复用 helper**:`lib/encoding.ts`(已有 `decodeBase64Utf8`);base64↔Uint8Array / encode 的散装实现要收口到 feature。

---

## 2. 目标文件结构

### Create(本分支新增)

| 文件 | 职责 |
|---|---|
| `web/src/services/socket/WebSocketService.ts` | **唯一 transport**:SocketCore 生命周期演进 + readiness gate(handshake 成功才 `connected`)+ plugin registry(`install` 一次 / `use` / `unregister` / `dispose`) |
| `web/src/services/socket/types.ts`(改造) | + `HandshakeSurface` / `PluginSurface` / `CapabilityPlugin` / `WebSocketServiceOptions`;`SocketMessage`/`ConnectionState`/`RequestOptions` 保留;`SocketClient`/`AgentConnection`/`MessageRouter` 终态删除(中途仍在用则暂留) |
| `web/src/services/socket/handshake.ts`(可选) | server auth handshake helper(`client.auth`,client_id localStorage)——若 Task 5 需要独立小函数 |
| `web/src/features/agents/{AgentsPlugin.ts, index.ts, types.ts, __tests__/unit/AgentsPlugin.test.ts}` | `client.agents.list` / `client.agent.rename` / `client.agent.delete`;订阅 `agents.changed` + `client.agents.list.response` → `onAgentsChanged`;模块单例 `agentsApi` |
| `web/src/features/sessions/{SessionsPlugin.ts, index.ts, types.ts, __tests__/unit/SessionsPlugin.test.ts}` | `client.sessions.list`(force/stale)/`client.session.create|kill|attach|capture_preview`;订阅 `sessions.changed` + `client.sessions.list.response` → `onSessionsChanged`;单例 `sessionsApi` |
| `web/src/features/server/{ServerPlugin.ts, index.ts, __tests__/unit/ServerPlugin.test.ts}` | `client.server.info` → `serverInfo()`;单例 `serverApi`(Q1 决议:独立 feature) |
| `web/src/features/env/{EnvPlugin.ts, index.ts, types.ts, __tests__/unit/EnvPlugin.test.ts}` | `client.env.list|get|write|delete` + `client.session.env.apply|unset|active|query`;单例 `envApi` |
| `web/src/features/commands/{CommandsPlugin.ts, index.ts, types.ts, __tests__/unit/CommandsPlugin.test.ts}` | `client.commands.list|add|remove|update`;订阅 `server.commands.changed`;单例 `commandsApi` |
| `web/src/features/claude-code/{ClaudeCodePlugin.ts, index.ts, types.ts, __tests__/unit/ClaudeCodePlugin.test.ts}` | `extension.claude_code.list|read`;单例 `claudeCodeApi`;wire types 从 `services/websocket/plugins/ClaudeCodePlugin.ts` 迁入并重新导出以兼容 `extensions/claude-code/types.ts` |
| `web/src/features/files/{FilesPlugin.ts, index.ts, types.ts, __tests__/unit/FilesPlugin.test.ts}` | `file.list|read|write|delete|create_dir|rename|cwd`;`createFilesApi(): FilesPlugin` factory;FileOps 形态 adapter 保留至 UI 迁移完成 |
| `web/src/features/terminal/{server.ts, agent.ts, index.ts, types.ts, __tests__/unit/…}` | server relay wire(`client.session.relay.begin|end` + relay `terminal.input|resize` + `terminal.output|resize` 订阅,base64↔Uint8Array)+ agent wire(`client.attach` typed request + `terminal.input|resize` + output 订阅 + `keepalive.ping`);server 侧单例 `terminalServerApi`,agent 侧 `createTerminalAgentApi()` factory |
| `web/src/features/index.ts` | 汇总 re-export(可选,供老路径短迁移) |
| 测试套件(每 feature 自带) | mock `PluginSurface`,见 Task 2 模板 |

### Modify(本分支改动)

| 文件 | 变化 |
|---|---|
| `web/src/services/socket/index.ts` | 导出新 WebSocketService + 新类型;终态去掉 SocketCore/双壳/legacy 类型 |
| `web/src/hooks/useAppConnection.ts` | owner 改为构造 `new WebSocketService(serverUrl, [agentsApi, sessionsApi, serverApi, envApi, commandsApi, claudeCodeApi, terminalServerApi], { handshake })`;identity-safe dispose;返回新 service |
| `web/src/hooks/useWebSocket.ts` | context 值类型 = `WebSocketService \| null`(只作 transport/relay 句柄来源) |
| `web/src/hooks/useVisibilityReconnect.ts` | `isConnected`/`connect` 换新 API 形态 |
| `web/src/hooks/useSessionRuntime.ts` | `serverConnection` 句柄构造方式换(新 service + terminal feature),mirror 字段换 |
| `web/src/runtime/SessionRuntime.ts` | `AgentSocketClient` → `WebSocketService`(per-candidate 重建);FileCapability → files feature;attach/ConnectionManager 依赖换 typed API;relay 句柄窄化 |
| `web/src/runtime/SessionAttachController.ts` | wire 交给 terminal-agent feature,自身保留时序/attempt 记账/超时映射 |
| `web/src/runtime/relayServerConnection.ts` | `RelayServerConnection` → `RelayServerHandle`(ConnectionState 语义)或按 Task 6 决议 |
| `web/src/terminal/ConnectionManager.ts` | P2P 腿/relay 腿都改为消费 typed feature API;不再出现 wire string / id 生成 / base64 |
| `web/src/types.ts` | 终态删除 `ConnectionStatus`/`WebSocketMessage` 与旧 re-export(UI 类型如 Agent/Session/AttachInfo/Env/Commands 保留;若 `ConnectionStatus` 仍被 UI 状态机使用,先迁到 `ConnectionState` 或 UI-local 类型) |
| Dashboard/env/commands/claude-code/session-first 消费方 | facade 方法 → 单例 feature typed API(见 Task 5 映射表) |

### Delete(合并前必须全删)

`services/websocket/`(整目录含测试)、`services/websocket.ts`、`services/socket/SocketCore.ts`、`services/socket/AgentSocketClient.ts`、`services/socket/ServerSocketClient.ts`、`services/socket/P2PConnectionAdapter.ts`、`services/socket/p2pTypes.ts`、`services/socket/agentSocketUtils.ts`(常量并入 WebSocketService)、`runtime/FileCapability.ts`、`services/fileOps.ts`(类型与 helper 已迁 features/files 则删,`FileEntry/FileData` 等 UI 类型迁到 feature types 并 re-export)、`terminal/hooks/useTerminalStateMachine.ts`(仅 barrel re-export,无活动消费)、`extensions/claude-code/services/claudeCodeService.ts`(直接 import `claudeCodeApi`)、`terminal/adapters/TransportAttachGate.ts`(若只服务 legacy attach 路径,Task 6 确认)、legacy 单例 helper 与一切旧 re-export。

---

## 3. Wire → Feature 归属表(实施真源)

| Wire string | Feature | 公开 API | 备注 |
|---|---|---|---|
| `client.auth` | (transport `options.handshake`) | — | HandshakeSurface.request;client_id 逻辑随 useAppConnection/owner |
| `client.agents.list` | agents | `listAgents(): Promise<Agent[]>` | 响应剥 `{agents}` |
| `client.agent.rename` / `client.agent.delete` | agents | `renameAgent(agentId, displayName\|null)` / `deleteAgent(agentId)` | success/error 检查保持 |
| `agents.changed` / `client.agents.list.response` | agents | `onAgentsChanged(cb: (agents: Agent[]) => void)` | 两者都触发(现状一致) |
| `client.sessions.list` | sessions | `fetchSessions({agentId?, force?}) → SessionsListResponse`;`listSessions(agentId?)` | stale_agents 保留 |
| `client.session.create` / `kill` | sessions | `createSession(agentId, name, envFiles?)` / `killSession(sessionId)` | |
| `client.session.attach` | sessions | `requestAttach(sessionId, mode?, relayUrl?) → AttachInfo` | 返回 attach info(与 runtime 的 P2P `client.attach` 不同) |
| `client.session.capture_preview` | sessions | `capturePreview(sessionId, lines)` | ansi_b64 → `lib/encoding.decodeBase64Utf8` |
| `sessions.changed` / `client.sessions.list.response` | sessions | `onSessionsChanged` | |
| `client.server.info` | server | `serverInfo(): Promise<ServerInfo>` | |
| `client.env.list/get/write/delete` | env | `listEnvFiles/getEnvFile(ref)/writeEnvFile(ref, content, overwrite, force?)/deleteEnvFile(ref)` | |
| `client.session.env.apply/unset/active/query` | env | `applySessionEnv/unsetSessionEnv/getSessionEnvActive/queryAgentEnvState` | |
| `client.commands.list/add/remove/update` | commands | `listCommands/addCommand(label, cmd, raw?)/removeCommand(id)/updateCommand(id, fields)` | |
| `server.commands.changed` | commands | `onCommandsChanged` | |
| `extension.claude_code.list/read` | claude-code | `list(req)/read(req)` | types re-export 给 extensions |
| `file.list/read/write/delete/create_dir/rename/cwd` | files | typed `FileApi`(方法名同 FileOps 减去 base64 杂项) | `uploadFile`/`readFileChunked`/base64 helpers 随迁 |
| `client.session.relay.begin/end` | terminal/server | `beginRelay(sessionId, relayUrl?, cols?, rows?)` / `endRelay(sessionId)` | |
| `terminal.input` / `terminal.resize`(relay, `session_name`+base64) | terminal/server | `sendRelayInput(sessionName, data)` / `sendRelayResize(sessionName, cols, rows)` | |
| `terminal.output` / `terminal.resize`(server 广播,base64) | terminal/server | `onOutput(sessionName, cb: (data: Uint8Array) => void)` / `onResize(sessionName, cb)` | 内部 decode |
| `client.attach` | terminal/agent | `attach(sessionName, {cols, rows}, opts?) → Promise<…>` | typed ack;错误转 reject(MessageRouter 已按 `error` reject) |
| `terminal.input` / `terminal.resize`(agent, `session_name`+base64) | terminal/agent | `sendInput(sessionName, data)` / `sendResize(sessionName, cols, rows)` | |
| `terminal.output` / `terminal.resize`(agent → client) | terminal/agent | `onOutput(cb)` / `onResize(cb)` | decode 同 server 侧 |
| `keepalive.ping` | terminal/agent | `ping(): void` | 30s 间隔仍归 ConnectionManager |
| `__binary__` 帧 | transport `onBinary` | — | ConnectionManager 改走 `onBinary` |

> 迁移纪律:Task 8 用 `grep -rnE "'(client|terminal|agents|sessions|server|extension|file|keepalive)\\." web/src --include='*.ts' --include='*.tsx'`(排除 `features/**` 与 `services/socket/WebSocketService.ts` 与 `__tests__`)确认无残留 wire string。

---

## Task 1: 唯一传输类 `services/socket/WebSocketService.ts` + readiness + plugin registry

**Files:**
- Create: `web/src/services/socket/WebSocketService.ts`
- Modify: `web/src/services/socket/types.ts`、`web/src/services/socket/index.ts`
- Test: `web/src/services/socket/__tests__/unit/WebSocketService.test.ts`(新建,port 自 SocketCore 测试 + 新增)

**范围说明:** 本 Task 只新增类与类型,**不迁移任何消费者**。`SocketCore`/双壳继续供旧代码使用到 Task 6/8。WebSocketService 是 SocketCore 的演进副本:同一 lifecycle 逻辑 + 三处差异:(a) readiness gate;(b) plugin registry;(c) `send(type, payload)` 信封化。MessageRouterImpl 直接复用现有 `MessageRouter.ts`(internal,不公开 re-export)。

- [ ] **Step 1: 在 `services/socket/types.ts` 追加契约类型(替换阅读用,逐字)**

```ts
export interface HandshakeSurface {
  send(type: string, payload: Record<string, unknown>): void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

export interface PluginSurface {
  readonly connectionState: ConnectionState;
  send(type: string, payload: Record<string, unknown>): void;
  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
  waitForConnection(timeoutMs?: number): Promise<void>;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
}

export interface CapabilityPlugin {
  readonly name: string;
  install(connection: PluginSurface): () => void;
}

export interface WebSocketServiceOptions {
  handshake?: (surface: HandshakeSurface) => Promise<void>;
  maxReconnectAttempts?: number; // default 10
  reconnectBaseDelay?: number;   // default 1_000, exp backoff, cap 30_000
  onError?: (error: Error) => void;
}
```

保留 `SocketMessage`/`ConnectionState`/`RequestOptions`;`SocketClient`/`AgentConnection`/`MessageRouter` 先不动(旧代码还在用),Task 8 删除。

- [ ] **Step 2: 写失败测试(先 port SocketCore 既有测试语义,再补新语义)**

读 `services/socket/__tests__/unit/SocketCore.test.ts` 的 mock WebSocket 基建(`src/test/` 或该文件内 helper——**沿用同一套**,必要时抽到 `src/test/mockWebSocket.ts` 复用)。新文件 `WebSocketService.test.ts` 必须覆盖(#631 Success 2/3/9/10/11 + Edge Cases):

1. 无 handshake:onopen → `connecting`→`connected`;`connect()` resolve;waitForConnection resolve。
2. 有 handshake(用可控 promise):onopen 后仍 `connecting`;`connect()` 不 resolve;`waitForConnection()` 不 resolve;`request()` 不提前放行(断言在 handshake resolve 前无 wire 发出,resolve 后发出);`send()` 此刻应允许?——**否**:`send` 在 socket OPEN 时物理可发,但业务 gate 由各 feature 的 waitForConnection 处理;transport 层 `send()` 保持「socket 未 OPEN 才 throw」。断言之。
3. handshake 失败 → connect() reject;状态回 `reconnecting`(预算内)/`disconnected`(耗尽);waiters reject;pending requests reject;下一次重连重新执行 handshake(计数断言)。
4. handshake 内部用 `HandshakeSurface.request()` 能完成关联请求(响应带同一 id → surface.request resolve);与 public readiness 无死锁(handshake 期间 socket 收到 server 推消息也能被订阅者收到——订阅在 open 前就绪)。
5. reconnect 不重装 plugin:install 计数 = 1;物理 socket 换 2 次后订阅仍工作且不重复收到(handler 计数一次/消息)。
6. plugin registry:构造 plugins 数组安装;`use()` 同名替换 → 旧 teardown 先跑、新 install 跑;`unregister(name)` → teardown、返回 true/false;`dispose()` → 全部 teardown 且幂等(二次 dispose 无副作用);dispose 后 request/send 抛「disposed」。
7. 双挂守卫(recommended transport-level 无状态检查不可行 → 本测试放 feature 层,Task 2);此处测 registry 语义即可。
8. `send(type, payload)` 信封:id 唯一、timestamp 存在、msg_type 正确;`request()` 复用同信封逻辑。
9. waitForConnection timeout;disconnected 时 waitForConnection/request 立即 reject。
10. `onBinary` 注册/去注册、binary 帧分发(用 mock ws 发 ArrayBuffer)。

（测试先行:至少 1/2/3/5/6/8 写完红 → 再实现。)

- [ ] **Step 3: 实现 `WebSocketService.ts`**

```ts
// 骨架(逻辑细节从 SocketCore 演进;完整实现以 SocketCore.ts 为底稿)
interface RegisteredPlugin { plugin: CapabilityPlugin; teardown: () => void; }

export class WebSocketService implements PluginSurface {
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private userClosed = false;
  private disposed = false;
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly waiters = new Set<ConnectionWaiter>();
  private idCounter = 0;
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly router: MessageRouterImpl;

  constructor(
    private readonly url: string,
    plugins: CapabilityPlugin[] = [],
    private readonly options: WebSocketServiceOptions = {},
  ) {
    this.router = new MessageRouterImpl({
      send: (msg) => this.sendRaw(msg),
      generateId: () => this.generateMessageId(),
    });
    for (const plugin of plugins) { this.use(plugin); }
  }

  get connectionState(): ConnectionState { return this.state; }
  get reconnectAttempts(): number { return this.reconnectAttempt; }
  getUrl(): string { return this.url; }

  connect(): Promise<void> { /* SocketCore.connect 语义 */ }
  disconnect(): void { /* + plugins 保留(逻辑层) */ }
  dispose(): void { /* teardown plugins(每个只跑一次) + router.dispose + waiters */ }

  use(plugin: CapabilityPlugin): void {
    this.unregister(plugin.name);               // 同名 replace:旧 teardown 先跑
    const teardown = plugin.install(this);      // this 即 PluginSurface
    this.plugins.set(plugin.name, { plugin, teardown });
  }
  unregister(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    this.plugins.delete(name);
    entry.teardown();
    return true;
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.disposed) throw new Error('WebSocketService disposed');
    this.sendRaw({ msg_type: type, id: this.generateMessageId(), timestamp: Date.now(), payload });
  }
  private sendRaw(message: SocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  request<T>(type, payload, options?): Promise<T> { /* = SocketCore.request(等 connected gate) */ }
  subscribe(...): () => void { return this.router.subscribe(...); }
  onBinary(...): () => void { return this.router.onBinary(...); }
  waitForConnection(...): Promise<void> { /* = SocketCore,connected 才 resolve */ }
  onConnectionStateChange(...): () => void { /* = SocketCore */ }

  private openSocket(resolve, reject): void {
    // 与 SocketCore 的差异(核心):
    // 1) onopen 后:若 options.handshake 存在 → 不 setState('connected'),
    //    停留在 'connecting',构造 handshakeSurface(this) 执行 handshake;
    //    成功后 setState('connected') + resolve connectPromise;
    //    失败 → reject + teardownSocket + handleSocketLoss(统一 reconnect)。
    // 2) 无 handshake → onopen 即 setState('connected') + resolve(现状)。
    // 3) 每次物理 socket(重连)都重新执行 handshake。
  }
  // handshakeSurface: { send: (t,p) => 走 router.send(信封化), request: (t,p,o) =>
  //   直接 router.request(不受 state gate 约束;socket 已 OPEN) }
  // reconnect/handleSocketLoss/generation guard/setState/rejectWaiters/clearTimer/teardownSocket
  // = SocketCore 原样迁移;maxReconnectAttempts/reconnectBaseDelay 取 options ?? 默认。
}
```

注意:
- `connect()` 若已有 connectPromise 则复用;handshake 期间 socket close/error 按 SocketCore 的 connectPromise 分支处理(此时 connectPromise 仍挂着 → reject)。
- reconnect 循环:`handleSocketLoss` 失败分支中 reconnectAttempt ≥ max 时 `disconnected` + rejectWaiters;否则 `reconnecting` → timer → `connect()`(与现状一致)。
- `MessageRouterImpl` 构造 deps.send → `this.sendRaw`(SocketMessage),**不经**公开 `send()` 的信封化(避免二次 id)。公开 `send(type,payload)`/`request()` 各自生成 id 后走 router 或直发。实现时把 `SocketCore` 的 `request()` 门控逻辑搬过来:state==='connected' 直接 router.request;'disconnected'/'disposed' 立即 reject;connecting/reconnecting 先 waitForConnection 再按剩余时间发。
- 不要把 `configure`/`reconnectNow`/`onMessage`/`sendMessage` 等 legacy 成员搬进来(终态不要;旧壳迁移期间由旧类提供)。Task 4 若发现 SessionRuntime 需要「候选地址轮换」而旧 configure 语义消失,按 D-spec §7「per-candidate 重建」处理,不给新类加 configure。

- [ ] **Step 4: 跑测试直到绿;`npm run lint && npx tsc --noEmit`**
- [ ] **Step 5: `index.ts` 导出 `WebSocketService` + 新类型(SocketCore 导出保留到 Task 8)**
- [ ] **Step 6: commit**

```bash
git add web/src/services/socket/
git commit -m "feat(web): add WebSocketService transport with readiness gate and plugin registry (#631)"
```

## Task 2: features 框架 + 应用级单例 feature(agents / sessions / server)

**Files:**
- Create: `web/src/features/agents/{AgentsPlugin.ts, index.ts, types.ts}` + `web/src/features/agents/__tests__/unit/AgentsPlugin.test.ts`
- Create: `web/src/features/sessions/{SessionsPlugin.ts, index.ts, types.ts}` + `web/src/features/sessions/__tests__/unit/SessionsPlugin.test.ts`
- Create: `web/src/features/server/{ServerPlugin.ts, index.ts}` + `web/src/features/server/__tests__/unit/ServerPlugin.test.ts`
- 测试基建(可复用): `web/src/test/mockPluginSurface.ts` — mock `PluginSurface`,记录 send/subscribe/request 调用,可手动推入消息、resolve/reject request(若 Task 1 已抽 mock ws,此文件独立,不依赖 ws)。

**契约(所有 feature 通用模板):**

```ts
// features/agents/AgentsPlugin.ts
import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type { Agent } from '@/types';

interface AgentsListResponse { agents: Agent[] }

export class AgentsPlugin implements CapabilityPlugin {
  readonly name = 'agents';
  private connection: PluginSurface | null = null;
  private generation = 0;
  private teardown: (() => void) | null = null;

  /** 单例重挂守卫:stale teardown 不得破坏新 binding(#631 Scope 6 模板)。 */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsubs = [
      connection.subscribe('agents.changed', (payload) => {
        const agents = (payload as { agents?: Agent[] })?.agents;
        if (agents) this.notify(agents);
      }),
      connection.subscribe('client.agents.list.response', (payload) => {
        const agents = (payload as { agents?: Agent[] })?.agents;
        if (agents) this.notify(agents);
      }),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
      if (this.generation === generation) this.teardown = null;
    };
  }

  // typed API 直接由 UI import;wire string 只在本文件
  async listAgents(): Promise<Agent[]> {
    const response = await this.requireConnection().request<AgentsListResponse>('client.agents.list', {});
    return response.agents;
  }
  async renameAgent(agentId: string, displayName: string | null): Promise<Agent> {
    const response = await this.requireConnection().request<{ success: boolean; error?: string; agent?: Agent }>(
      'client.agent.rename', { agent_id: agentId, display_name: displayName });
    if (!response.success || !response.agent) throw new Error(response.error || 'Rename failed');
    return response.agent;
  }
  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.requireConnection().request<{ success: boolean; error?: string }>(
      'client.agent.delete', { agent_id: agentId });
    if (!response.success) throw new Error(response.error || 'Delete failed');
  }

  onAgentsChanged(cb: (agents: Agent[]) => void): () => void {
    this.agentsCallbacks.add(cb);
    return () => { this.agentsCallbacks.delete(cb); };
  }
  private agentsCallbacks = new Set<(agents: Agent[]) => void>();
  private notify(agents: Agent[]): void {
    for (const cb of this.agentsCallbacks) cb(agents);
  }
  private requireConnection(): PluginSurface {
    if (!this.connection) throw new Error('agents feature is not connected');
    return this.connection;
  }
}

// features/agents/index.ts
export { AgentsPlugin } from './AgentsPlugin';
export const agentsApi = new AgentsPlugin();
```

要点:
1. **无 `requireAuth`**:public `connected` 已保证 auth handshake 完成;`request()` 在未 ready 时由 transport 等/拒。
2. **typed API 方法名与旧 facade 同名**(listAgents/renameAgent/deleteAgent/onAgentsChanged …),consumer 迁移是 import 换源,调用点基本不动。
3. **订阅回调集**:teardown 中同时清空本地 callback 集合(已释放的 plugin 不得再通知 stale consumer——EventPlugin 现状如此)。
4. **响应类型**沿用 `web/src/types.ts`(Agent/Session/Env*/Commands*/ServerInfo…)或 `features/<name>/types.ts` 自持并 re-export;不要在 feature 里复制 UI 域类型。
5. `sessions` 的 `capturePreview` 用 `lib/encoding.decodeBase64Utf8`;`fetchSessions` 保留 `stale_agents` 与 `force` 语义。
6. `server` 只有 `serverInfo()`。
7. 测试用 mock `PluginSurface`(#631 Constraint 5):逐方法断言发出的 `(type, payload)` 与响应剥壳、订阅类型与回调触发、teardown 后无通知、**6 步 stale-teardown 用例**(install(A) → install(B) → teardown(A) → B 仍为 active binding → teardown(B) → capability detached;#631 Scope 6 原文)、未连接时方法抛「not connected」。
   **双挂语义(重要,照 #631 原文执行,勿自作主张加 throw)**:Scope 6 的 6 步测试要求 install(B) 在 teardown(A) 之前合法(B = 新连接/新 generation,StrictMode 下旧 teardown 迟到是常态)——generation 计数就是防 stale cleanup 的机制,**install 不做跨 surface throw**。「同一实例不并发双挂」的守卫含义 = 重挂走 replace 语义(旧 binding 被新 binding 取代;若旧 service 还活着,其订阅随旧 service dispose/teardown 释放)+ 6 步测试证明最终 detached;不做安装期抛错。服务端 `use()` 同名替换先 unregister(teardown)再 install,同样不抛。

- [ ] **Step 1:** 建 `mockPluginSurface.ts`(含 `pushMessage(type, payload, raw?)`、`resolveNext(type, payload)`、`connectionState` 可控、记录 `sent: {type, payload}[]` 与 `requests: {type, payload}[]`)
- [ ] **Step 2:** 三个 feature 的失败测试(红)
- [ ] **Step 3:** 实现三个 feature(模板逐字;wire 见 §3 表)
- [ ] **Step 4:** 测试全绿 + `npm run lint && npx tsc --noEmit` + `npm run coverage`(新增行必须覆盖)
- [ ] **Step 5:** commit `feat(web): add agents/sessions/server capability features (#631)`

---

## Task 3: feature 补全(env / commands / claude-code)

**Files:**
- Create: `web/src/features/env/{EnvPlugin.ts, index.ts, types.ts}` + `__tests__/unit/EnvPlugin.test.ts`
- Create: `web/src/features/commands/{CommandsPlugin.ts, index.ts, types.ts}` + `__tests__/unit/CommandsPlugin.test.ts`
- Create: `web/src/features/claude-code/{ClaudeCodePlugin.ts, index.ts, types.ts}` + `__tests__/unit/ClaudeCodePlugin.test.ts`

与 Task 2 同一模板/纪律。额外注意:
- `claude-code` 的 request/response types 从 `services/websocket/plugins/ClaudeCodePlugin.ts` **原样迁入** `features/claude-code/types.ts` 并 re-export(供 `extensions/claude-code/types.ts` 兼容到 Task 5)。
- wire 见 §3 表;方法签名与旧 facade/plugin 同名同参。
- 测试覆盖每个方法 + changed 订阅(commands)+ stale teardown。
- 验证:全绿 + lint/tsc/coverage;commit `feat(web): add env/commands/claude-code capability features (#631)`

> **并行提示**:Task 2/3/4 目录互不重叠(`features/agents|sessions|server` vs `features/env|commands|claude-code` vs `features/files|terminal`),可三个 subagent 并行(各自独立 commit);但都依赖 Task 1 的 types 契约已合入本分支。

---

## Task 4: files + terminal feature(会话级 / 多连接能力)

**Files:**
- Create: `web/src/features/files/{FilesPlugin.ts, index.ts, types.ts}` + `__tests__/unit/FilesPlugin.test.ts`
- Create: `web/src/features/terminal/{agent.ts, server.ts, index.ts, types.ts}` + `__tests__/unit/{terminalAgent.test.ts, terminalServer.test.ts}`

**4a. files(factory-per-connection):**

```ts
// features/files/FilesPlugin.ts — 会话级能力:每连接新建实例,禁止单例复用
export interface FileApi {
  listDir(path: string): Promise<{ entries: FileEntry[] }>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData>;
  writeFile(path: string, contentB64: string): Promise<{ path: string; written: number }>;
  deleteFile(path: string, recursive?: boolean): Promise<{ path: string; success: boolean }>;
  createDir(path: string): Promise<{ path: string; success: boolean }>;
  renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }>;
  getCwd(sessionId: string): Promise<{ path: string }>;
}

export class FilesPlugin implements CapabilityPlugin {
  readonly name = 'files';
  // install/teardown 同模板;wire: file.list/read/write/delete/create_dir/rename/cwd(§3 表)
  // 便捷方法:uploadFile(path, file)(FileReader→base64→writeFile)、readFileChunked(fileApi, path, onProgress)
  // 兼容 adapter:toFileOps(): FileOps —— 直到 session-first 工具全部迁 typed API(Task 6 决定是否保留)
}
export function createFilesApi(): FilesPlugin { return new FilesPlugin(); }
```

- `FileEntry`/`FileData`/`FileOps`/`ChunkedReadResult`/`DEFAULT_CHUNK_SIZE`/`base64Encode`/`base64Decode`/`readFileChunked` 从 `services/fileOps.ts` 迁入(feature 自持);**该文件在 Task 6/8 删除,期间旧 import 改指 feature**。
- 语义保持:`writeFile` 收 base64(旧 `createFileOpsFromRouter.writeFile(path, content 明文)` 内部 encode —— 新 typed API 收 base64,`toFileOps()` 适配器负责旧明文→encode,保证既有 UI 调用不变)。
- 测试:mock surface 全方法 + chunked 逻辑(可抽出纯函数测)。

**4b. terminal(factory: agent 侧 / 单例: server 侧):**

```ts
// features/terminal/types.ts — 两模式共用
export interface TerminalSize { cols: number; rows: number }
export type AttachResult =
  | { ok: true }
  | { ok: false; error: string };

// features/terminal/agent.ts — factory-per-connection
export interface TerminalAgentApi {
  /** client.attach 的 typed 封装;wire 的 ok/error 关联在此收敛。 */
  attach(sessionName: string, size: TerminalSize, opts?: { timeoutMs?: number; manualRoute?: boolean }): Promise<AttachResult>;
  sendInput(sessionName: string, data: string): void;   // 内部 base64(agent 协议现状)
  sendResize(sessionName: string, cols: number, rows: number): void;
  onOutput(cb: (data: Uint8Array) => void): () => void;      // 订阅 terminal.output,内部 decode base64
  onResize(cb: (cols: number, rows: number) => void): () => void;
  ping(): void;                                             // keepalive.ping
}
export function createTerminalAgentApi(surface: PluginSurface): TerminalAgentApi;
```

```ts
// features/terminal/server.ts — 应用级单例(唯一 server 连接;relay 走 server)
export interface TerminalServerApi {
  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void;
  endRelay(sessionId: string): void;
  sendRelayInput(sessionName: string, data: string): void;  // base64
  sendRelayResize(sessionName: string, cols: number, rows: number): void;
  onRelayOutput(sessionName: string, cb: (data: Uint8Array) => void): () => void; // 订阅 terminal.output(resize),按 session_name 路由
  onRelayResize(sessionName: string, cb: (cols: number, rows: number) => void): () => void;
}
export class TerminalServerPlugin implements CapabilityPlugin { readonly name = 'terminal-server'; … }
export const terminalServerApi = new TerminalServerPlugin();
```

- agent 侧 API 需要把 wire 挂在**具体连接**上 → factory 收 `surface`(由 SessionRuntime 在 install 后取得,或由 plugin 持有——二选一,Task 6 定;推荐:`createTerminalAgentApi(surface)` 由 runtime 在 install 完成、拿到 surface 后创建,不依赖 install 时序)。
- `attach()` 语义:agent 回 `ok`/`error`(同 id);MessageRouter 已把 `error` 变 reject —— 本方法把 reject 映射为 `{ ok:false, error }`,超时(默认 10s,可传)映射为 `{ ok:false, error:'timeout' }` 或 reject?——**统一 `{ ok:false, error }` 不 reject**,让 SessionAttachController 的 attempt 记账保持简单(Task 6 再核对现有测试语义)。
- `__binary__` 与 output:ConnectionManager 迁移(Task 6)改走 transport `onBinary` + 本 API 的 `onOutput`;feature 内部两路都汇到 `onOutput`?——**否**:agent 现实是 base64 `terminal.output`,`__binary__` 是历史路径;迁移后 ConnectionManager 只订阅 `onOutput`,binary 帧忽略(与现状「relay 用 base64、P2P 按 TextEncoder」对齐 —— 在 Task 6 以现有 ConnectionManager 测试为准做等价迁移,不要凭猜)。
- 测试:wire 字面量、payload(base64 正确性)、订阅路由(server 按 session_name 分流、agent 单流)、attach ok/error/timeout 映射。

- [ ] Step 1–4 同前(TDD);验证全绿 + lint/tsc/coverage;commit `feat(web): add files/terminal capability features (#631)`

---

## Task 5: server 连接 owner + server 消费方全量迁移(useAppConnection / useWebSocket / Dashboard 群)

> 目标:server 侧不再有旧 facade 的**调用方**;`WebSocketServiceCoreImpl`/旧 facade/plugins 只还剩 relay 路径与 runtime glue 引用(Task 6/8 收)。
> **本 Task 是最大的机械迁移;用 `npx tsc --noEmit` 当扫描器**:改完 context 类型后,编译器逐文件列出所有旧调用,按 §3 表与下方映射逐个清。

**Files:**
- Modify: `web/src/hooks/useAppConnection.ts`、`web/src/hooks/useWebSocket.ts`、`web/src/hooks/useVisibilityReconnect.ts`
- Modify(Dashboard/env/commands/claude-code 群): `hooks/useAgentData.ts`、`useSessionData.ts`、`useRealtimeUpdates.ts`、`useQuickCommands.ts`、`useSessionPreview.ts`、`useTerminalSessions.ts`、`useAgentRename.ts`、`useDashboard.ts`、`useProbePolling.ts`、`useDeepLinkRestore.ts`、`useSessionFirstShellState.ts`;`components/Dashboard.tsx`(仅当直接调 facade)、`components/AgentCard.tsx`(rename)、`components/CreateSessionDialog.tsx`、`components/KillConfirmDialog.tsx`、`components/QuickCommandsPanel.tsx`、`ServerInfoMenu`(位置随组件树)、`components/env/*`(useEnvManager/useEnvEditor/EnvPanel/EnvEditorDialog/EnvUploadDialog…)、`extensions/claude-code/services/claudeCodeService.ts`(**删除**,UI 直接 import `claudeCodeApi`)
- Test: 对应 `hooks/__tests__/integration/*` 与 `components/__tests__/integration/*` 同步改;`services/__tests__/integration/websocket.test.ts`(facade + singleton 测试)→ 改写为新 WebSocketService + feature 单例的集成语义

**Step 1 — owner 重写(`useAppConnection.ts`):**

```ts
// 替换 createWebSocketService/getWebSocketService/destroyWebSocketService 用法
const service = new WebSocketService(
  serverUrl,
  [agentsApi, sessionsApi, serverApi, envApi, commandsApi, claudeCodeApi, terminalServerApi],
  {
    handshake: (surface) =>
      surface.request<AuthResponse>('client.auth', {
        auth_token: authToken,
        client_id: getOrCreateClientId(),   // 逻辑自 services/websocket/core.ts 迁入
      }).then((res) => {
        if (res.status !== 'success') throw new Error(res.message || 'Authentication failed');
      }),
    maxReconnectAttempts: 5,
  },
);
```

- `connectionStatus` state:改用 `ConnectionState`;`isAuthenticated = service.connectionState === 'connected' && service !== null`;`onConnectionChange` 订阅 → 现在 `service.onConnectionStateChange`(`connected` = 旧 `authenticated`;`connecting` 覆盖 socket 未开 + handshake 中;`reconnecting` 语义同旧)。
- `handleDisconnect`/cleanup:**identity-safe**——`if (serviceRef.current === service) service.dispose()`,再置 null(StrictMode/双 token 变更安全)。单例 feature 不 dispose:下次 `new WebSocketService` 重新 install(generation 机制保证 stale-safe)。client_id 的 `localStorage('nessioclientid')` 读取逻辑迁到 `services/socket/clientId.ts`(小函数,带测试)。
- `useVisibilityReconnect`:换 `service.connectionState`/`service.connect()`。
- 返回值:原字段名尽量保留(consumers 少动),但类型换成新 service。

**Step 2 — context 换型 + tsc 驱动迁移:**

- `useWebSocket`/`WebSocketContext` 值类型 = `WebSocketService | null`。
- 每个编译错误文件按下表改(方法签名同名,基本是 import 换源):

| 消费点(旧) | 改为 |
|---|---|
| `ws.listAgents()` | `agentsApi.listAgents()` |
| `ws.onAgentsChanged(cb)` | `agentsApi.onAgentsChanged(cb)` |
| `ws.fetchSessions(opts)` / `ws.listSessions(id?)` | `sessionsApi.fetchSessions(opts)` / `.listSessions(id?)` |
| `ws.onSessionsChanged(cb)` | `sessionsApi.onSessionsChanged(cb)` |
| `ws.createSession(...)` / `killSession(...)` | `sessionsApi.*` |
| `ws.requestAttach(...)` | `sessionsApi.requestAttach(...)`(server 侧 attach info;P2P `client.attach` 不动——Task 6) |
| `ws.capturePreview(...)` | `sessionsApi.capturePreview(...)` |
| `ws.serverInfo()` | `serverApi.serverInfo()` |
| `ws.listEnvFiles/getEnvFile/writeEnvFile/deleteEnvFile/applySessionEnv/unsetSessionEnv/getSessionEnvActive` | `envApi.*` |
| `ws.listCommands/addCommand/removeCommand/updateCommand/onCommandsChanged` | `commandsApi.*` |
| `ws.claudeCodeList/claudeCodeRead` | `claudeCodeApi.list/read`(claudeCodeService.ts 删除,扩展组件直连) |
| `ws.getConnectionStatus()/isAuthenticated()/onConnectionChange()` | `service.connectionState` / `service.onConnectionStateChange()`(`authenticated`→`connected`,`isConnected()||isAuthenticated()`→`state==='connected'`) |
| `ws.connect()/disconnect()` | `service.connect()/disconnect()` |
| `ws.getP2PConnectionInfo(attachInfo)` | 由 attachInfo 直接构造(Task 6 用),此处先 inline |
| relay 路径 facade 消费(`onTerminalOutput/onTerminalResize/sendRelayInput/sendRelayResize/beginRelay/endRelay`) | **留到 Task 6/7**(relay 腿统一迁 terminal feature);本 Task 若编译需要,允许在 relay glue 处保留 facade 引用并注释 TODO(Task 6) |

- **纪律**:单个 commit 内,凡 context 类型变了导致的红,必须同 commit 清完(tsc 0 error)。建议分批:owner+context(1 commit)→ Dashboard 数据 hooks → 组件群(env/commands/claude-code/dialogs)→ 测试套件更新。每个 commit 后 `npm run lint && npx tsc --noEmit && npm test`。
- 相关测试更新要点:`hooks/__tests__/integration/useAppConnection.test.ts`(mock 新 service/feature 安装与 handshake 语义)、`useDashboard`/`useSessionData`/`useQuickCommands`/env/commands/claude-code 组件套件(把 mock 的 facade 换成 feature 单例 + 注入 fake surface,或直接 mock feature 模块)。
- **不要**让测试依赖真实 WebSocket(Constraint 5);feature 层已用 mock surface 测过,组件层 mock feature 模块即可。

- [ ] 各步跑通后 commit(可多个):`refactor(web): migrate server consumers to capability features (#631)`

## Task 6: agent/session 连接迁移(SessionRuntime / FileCapability / attach / ConnectionManager / useSessionRuntime)

> 目标:session 侧不再依赖 `AgentSocketClient`/`P2PConnection` legacy shape/`FileCapability`/裸 wire。`SessionRuntime` 持有自己的 agent `WebSocketService`(factory-per-connection 语义:候选地址/强制 relay 变化 = **重建 service**,旧 service dispose → 新 service + 新 factory 实例)。

**Files:**
- Modify: `web/src/runtime/SessionRuntime.ts`、`web/src/runtime/SessionAttachController.ts`、`web/src/runtime/relayServerConnection.ts`、`web/src/terminal/ConnectionManager.ts`、`web/src/hooks/useSessionRuntime.ts`、`web/src/runtime/FileCapability.ts`(**删**,被 features/files 取代)
- Modify(消费 runtime 的 session-first/terminal 文件):`session-first/terminal/useTerminalOrchestration.ts`、`session-first/useSessionFirstShellState.ts`、`terminal/adapters/TerminalRuntimeAdapter.ts`(如引用旧型)、`atoms/connection.ts`、`atoms/session.ts`(如存 `p2pConnection`/`fileOps`)
- Test: `runtime/__tests__/unit/*`、`terminal/__tests__/*`(ConnectionManager)、`hooks/__tests__/integration/useSessionRuntime.test.tsx`、`useP2PAttachTransport.test.tsx`、session-first 套件

**Step 1 — `SessionRuntime` 内部连接对象换型:**

```ts
// 现在                                              // 之后
agentClient: AgentSocketClient | null                agentWs: WebSocketService | null
p2pAdapter: P2PConnection | null                     (删;surface = agentWs 自身)
fileCapability: FileCapability | null                filesApi: FilesPlugin | null  (createFilesApi() 实例)
                                                     terminalApi: TerminalAgentApi | null (createTerminalAgentApi(agentWs) —— Task 4 定的形态)
```

- `syncAgentClient(opts?)` → `syncAgentConnection(opts?)`:
  - url/token/forcedRelay 判定不变;但**每次候选变化(URL 不同)或 forceRelay 切换都重建**:
    ```ts
    const ws = new WebSocketService(url, [], { maxReconnectAttempts });  // plugins 为空:files/terminal 由 runtime 显式 create 后 use()
    ws.use(filesApi); ws.use(termApiPlugin); // 或构造时传入 —— 由实现选;关键:同实例不双挂
    ```
    若保持「构造传入」更简单:factory 创建两个 plugin 实例后 `new WebSocketService(url, [filesPlugin, termPlugin], …)`。runtime 保存 `filesPlugin`/`termPlugin` 的 typed 引用。
  - 旧 `client.configure(...)`/`forceReconnect()` 语义由「URL 变 → dispose 旧 + new」替代;**行为差异点**:configure 只换物理 socket(订阅跨候选保留),重建会丢订阅 → 但 feature 的 typed 订阅方是 runtime/UI 自己重建的;地址轮换时 runtime 里所有订阅(connection state、output)都重新挂在新 service 上,与现状「syncAgentClient 只在 isNewClient 时 wire 一次」不同 —— **必须保持**:状态机/UI 侧订阅的生命周期挂在 runtime 上而非物理对象,重建后重挂。Task 6 的验收测试要覆盖 `updateContext` 改 URL(route change)后 attach 能照常完成(现有 `SessionRuntime.test.ts` 有 candidate 轮换用例 → 以它们为行为 oraculum,红了就对照语义修,不许为绿而绿)。
- `getMirrorSnapshot()`:`p2pConnection: this.p2pAdapter` → `connectionState: this.agentWs?.connectionState ?? 'disconnected'`(`p2pConnection` 字段删;镜像消费方同步,见 Step 4)。
- `getP2PConnection()`(legacy,供 ConnectionManager)→ `getAgentSurface(): PluginSurface | null`(供 ConnectionManager/attach 用)。
- `getFileCapability()` → `getFilesApi()`;`registerSessionCapability('files', …)` 若只剩 files 可以直接用字段,capability map 机制保留给未来(不动,除非死代码)。
- dispose:agentWs?.dispose();filesApi/terminalApi 随 service dispose 释放(plugin teardown 由 service 跑)。

**Step 2 — `SessionAttachController` 换依赖:**

- `startP2PAttach({ sessionName, p2pConnection, manualRoute, lastResize, transportGeneration })` 的 `p2pConnection` 换成 `terminalApi: TerminalAgentApi`(surface 由 runtime 传入或 controller 持有引用)。
- 发送逻辑:`this.terminalApi.attach(sessionName, { cols, rows }, { timeoutMs: ATTACH_TIMEOUT_MS })`;await 结果:
  - `{ ok: true }` → dispatch `{ type: 'ATTACH_OK' }`
  - `{ ok: false, error }` → 超时(timeout 标记)dispatch `ATTACH_TIMEOUT { attempt }`,否则 `ATTACH_ERROR { manualRoute }`(与现有 outcome 语义一致;对照 `runtime/__tests__/unit/SessionAttachController.test.ts` 逐例搬)
- `cancelActiveAttach()`:取消 await 中的 attach(内部 AbortController 或忽略迟到结果 + generation 标记,不许把迟到 ok 变成误 ATTACH_OK —— 用与 transportGeneration 相同的 attempt/epoch 判断)。
- controller 内不再出现 `client.attach`/`ok`/`error` 字面量与 id 生成。

**Step 3 — `ConnectionManager` 换依赖:**

- `ConnectionOptions.p2pConnection: P2PConnection` → `agentApi: TerminalAgentApi`(+ 需要的 surface 就绪回调);`serverConnection: WebSocketService(旧 facade)` → `relayApi: TerminalServerApi`(relay 腿,Task 7 同步做,或本 Task 一并完成——**建议一并**:ConnectionManager 两腿都迁完,旧 facade 就没有传输消费方了)。
- P2P 腿:`setupP2P` 里 `sendMessage({msg_type:'terminal.input',…})` → `agentApi.sendInput(sessionName, data)`;`sendResizeRaw` → `agentApi.sendResize(...)`;keepalive interval 保留在 CM,回调 `agentApi.ping()`;入站 `onMessage` switch → `agentApi.onOutput(cb)` + `agentApi.onResize(cb)` + transport `onBinary` 若仍需(见 Task 4 注:以现有 ConnectionManager 测试为 oracle 等价迁移;`error`/`ok`/`not_attached` 处理语义保留——若 feature 的 `attach` 已把 error 收敛,CM 里残留的 error 分支只处理 attach 之外的错误,按现有测试搬)。`onStateChange` 驱动改为 `agentWs.onConnectionStateChange`(runtime 已镜像;CM 的 `isAttached()` 注入不变)。
- relay 腿:`sendRelayInput/Resize` → `relayApi.sendRelayInput/Resize`;订阅 → `relayApi.onRelayOutput(name, cb)/onRelayResize(name, cb)`;`onConnectionChange`(旧 'authenticated'/'disconnected')→ relayApi 提供的就绪订阅或 surface `connectionState`('connected'/'disconnected' 映射)。
- CM 测试(`terminal/__tests__/unit/ConnectionManager.test.ts`)逐例改 mock(fake agentApi/relayApi),行为断言不变。

**Step 4 — useSessionRuntime + atoms:**

- `serverConnection` 句柄构造:来自 app 层(useWebSocket context 的 service + `terminalServerApi`);映射表:
  - `conn.onConnectionChange(status)`:`service.onConnectionStateChange(state)`;`status==='authenticated'` → `state==='connected'`(runtime 内 `wireRelayServerHandler` 判断同步改)
  - `conn.isAuthenticated()` → `state==='connected'`;`getConnectionStatus()` → `connectionState`
  - `conn.beginRelay(sessionId, relayUrl, cols, rows)` → `terminalServerApi.beginRelay(...)`(wire 在 feature;runtime 只持句柄)
- `relayServerConnection.ts`:`RelayServerConnection` 类型改为(或新增)`RelayServerHandle`(成员如上),`SessionRuntimeConfig.serverConnection` 换新类型。
- `RuntimeMirrorSnapshot`/Jotai:`p2pConnectionAtom` 存的值从 legacy P2PConnection → 新形态(surface/connectionState + transportKey 已够);`fileOps` 暴露改为 `filesApi.toFileOps()`(adapter 保留)或直连 typed(推荐:atoms 存 typed FileApi,UI 组件内小改 —— 由实现按改动面选,但 `services/fileOps.ts` 的删除必须发生在 UI 无直接依赖后,最迟 Task 8)。
- session-first file tools(`session-first/workspace/tools/files*`、patterns FileWorkspace)与 fixture:换 typed FileApi / 保留 fixture 的 `FileOps` 接口实现不受影响(fixture 不依赖连接)。

**Step 5 — 删 `runtime/FileCapability.ts`**(Task 4 的 FilesPlugin 已接管);跑全量 runtime/terminal/session-first 套件。

- [ ] 分步 commit:`refactor(web): migrate session runtime to WebSocketService + features (#631)`

---

## Task 7: relay 路径与 legacy 终端壳收口(TerminalWorkspace / useRelayServerLifecycle / 残留 facade 引用)

**Files:**
- Modify: `terminal/components/TerminalWorkspace.tsx`、`terminal/hooks/useRelayServerLifecycle.ts`、`session-first/terminal/useTerminalOrchestration.ts`(若 Step 6 未全清)、`hooks/useWebSocket.ts` 相关残余
- 目标:全仓库(除将删文件)不再 import `services/websocket/**` 或 `services/websocket.ts`;relay 全走 `terminalServerApi`。

**做法:**
1. `grep -rn "services/websocket" web/src --include='*.ts' --include='*.tsx' | grep -v __tests__` 列出残余,逐个按 Task 5 映射表处理(relay 相关 → terminalServerApi/feature)。
2. `useRelayServerLifecycle`:`onConnectionChange`(旧 ConnectionStatus)换 service.connectionState('connected');`beginRelay` 若它还持有 → terminalServerApi。
3. `TerminalWorkspace` 的 `ConnectionOptions.serverConnection`(旧 facade 型)→ relayApi 型(与 Task 6 Step 3 同步)。
4. `terminal/index.ts` barrel 去掉 `useTerminalStateMachine` 导出;该文件本体删(确认无引用:先 grep)。
5. legacy 单例 helper(`createWebSocketService` 等)已无调用 → 可提前删(连同 `services/websocket.ts`)。
6. 测试:`useRelayServerLifecycle.test.ts`、`TerminalWorkspace` 相关 integration、`useTerminalStateMachine.test.ts`(若本体删除则删测试)同步。

- [ ] commit:`refactor(web): migrate relay path to terminal-server feature (#631)`

---

## Task 8: 删除 legacy 树 + 类型收口(合入前最后一刀)

**Files(Delete,连同各自 `__tests__`):**
- `web/src/services/websocket/`(整目录)、`web/src/services/websocket.ts`
- `web/src/services/socket/SocketCore.ts`、`AgentSocketClient.ts`、`ServerSocketClient.ts`、`P2PConnectionAdapter.ts`、`p2pTypes.ts`、`agentSocketUtils.ts`
- `web/src/runtime/FileCapability.ts`(若 Task 6 未删)、`web/src/services/fileOps.ts`(类型/helper 已在 features/files 则删;`FileEntry/FileData` 从 `features/files/types.ts` re-export 给仍 import 它的 UI)
- `web/src/terminal/hooks/useTerminalStateMachine.ts`、`extensions/claude-code/services/claudeCodeService.ts`、`terminal/adapters/TransportAttachGate.ts`(确认无引用)
- `web/src/services/socket/types.ts` 内 `SocketClient`/`AgentConnection`/`MessageRouter`(公开接口)——若仍有引用先改
- `web/src/types.ts`:`ConnectionStatus`/`WebSocketMessage` 与旧 re-export(改完后 grep `WebSocketMessage|ConnectionStatus` 确认 0;UI 若仍要状态联合类型,就地定义 UI-local,不许反向依赖旧语义)

**收口动作:**
1. 先删再 `npx tsc --noEmit` —— 编译器列全部残留引用,逐个按映射表清;循环到 0。
2. `grep -rnE "'(client|terminal|agents|sessions|server|extension|file|keepalive)\\." web/src --include='*.ts' --include='*.tsx'`(排除 `features/**`、`services/socket/WebSocketService.ts`、`**/__tests__/**`)→ 必须 0 命中(除 transport 内 `client.auth` 允许出现在 owner 或 clientId 模块 —— 若 handshake 的 wire 也进 `features/auth` 更干净,可选:auth 归 `features/server`?—— 决议:auth handshake 属于连接机制,`client.auth` 允许出现在 `useAppConnection` 的 handshake option 或 `services/socket/clientId.ts` 旁的小模块;§3 表已注明)。
3. 全量门禁:`npm run lint && npx tsc --noEmit && npm test && npm run coverage && npm run build` 全绿;覆盖率不得低于基线。
4. 对照 #631 Success Criteria 1–15 逐条自查(§10 附清单)。
5. `git status` 确认无遗留;commit:`refactor(web): delete legacy websocket facade and client shells (#631)`

---

## Task 9: e2e terminal I/O 恢复(CI 门控)+ 功能验证 + PR

> 约束:本地禁跑 e2e(仓库 Iron Law);`e2e.yml` 在 PR→staging 与 push→staging 都会跑。恢复的 spec 必须 `test.skip(!process.env.CI, …)` 门控。

**9a. terminal-io.spec.ts 恢复:**
- 把两个 `test.skip('…')` 改成 `test.skip(!process.env.CI, 'local only — runs in CI workflow only')`(与 fixture spec 同款);先把 P2P 与 relay 都放开,若 CI 仍红再逐个收敛(优先保住 relay 一条)。
- 历史失败原因(注释:CI 下 tmux session 初始化 "terminal does not support clear")已过时线索:**agent 侧已强制 `TERM=xterm-256color`(manager.rs:246)**;若 CI 仍现该错,检查 `e2e/playwright.config.ts` 的 webServer env 是否缺 TERM、agent fixture config 的 tmux 设置、或 tmux 版本;按「改 e2e 配置/env → push → 看 PR 的 e2e job」迭代(每次 push 都触发,收敛再继续)。不许靠「测试跳过」掩盖。
- `e2e/specs/session-lifecycle.spec.ts` 顺手评估:同款 CI 门控恢复;若涉及 UI 选择器与 session-first 冲突,允许保留 skip 但注明 issue 跟踪(不在本 requirement 强制范围)。
- 9a 的验收:**PR 上 e2e job 绿**(terminal-io 至少 1 条真跑)。

**9b. 本地 full-stack 功能验证(Playwright MCP,非 e2e 框架):**
按 nession-development 技能清单启动 server+agent+web(`HOME=/tmp/nession-demo`),浏览器逐项验证并截图(存 `.playwright-mcp/screenshots/`):
- 登录/自动登录(token)、断开→重连 banner、re-login(登出再登录,验证单例 feature 重挂无 stale)
- agents/sessions 列表 + 变更推送(创建会话后列表即时刷新)
- create/kill session 对话框流;env 面板 CRUD/apply;quick commands;claude-code 面板(如环境可用)
- relay attach + echo(`echo nession-relay-ok`)、P2P attach + echo、终端 resize/输入
- console 无 error/warning;截图关键状态(登录态、Dashboard、terminal 输出、claude-code 面板)

**9c. PR 与部署(staging):**

```bash
# 最终门禁(在 worktree web/ 与根目录按顺序)
npm run lint && npx tsc --noEmit && npm test && npm run coverage && npm run build

git push -u origin feat/websocket-plugin-model
gh pr create --base staging --title "feat(web): WebSocket pure connection + capability plugin model (#631)" \
  --body "## 变更内容\n- …(按实际 commit 归纳)\n\n## 测试报告\n- npm test: …;npm run coverage: …;lint/tsc/build: OK\n- e2e(CI): terminal-io relay/P2P 真跑\n- Playwright 功能验证截图见评论"
gh pr comment <PR> --body "## 截图\n![…](.playwright-mcp/screenshots/…)"

# 等 quality/web-check 绿 + e2e job 绿
gh pr merge <PR> --auto --merge
./scripts/deploy-watch.sh staging        # 等 staging.yml 镜像构建 + gitops deploy commit + ArgoCD sync
# 合并后释放认领
gh issue edit 631 --remove-label in-progress
```

**PR body 不放 `Closes #631`**(它只在 release PR 生效,release PR 由发布流程负责加)。

---

## §10. #631 Success Criteria 自查清单(合并前逐条打勾)

- [ ] 1. `services/socket/WebSocketService.ts` 为唯一 WebSocket transport(全仓无其他 new WebSocket)
- [ ] 2. public `connected` = handshake-complete;测试证明 auth 期间普通 request 不放行
- [ ] 3. handshake 经 HandshakeSurface 无死锁(测试)
- [ ] 4. `AgentSocketClient`/`ServerSocketClient`/`WebSocketServiceCoreImpl`/旧 typed facade/`services/websocket.ts` 全删
- [ ] 5. `services/websocket/` 目录不存在
- [ ] 6. `features/*` 承载全部业务 wire(agent/server terminal wire 在内;grep 门禁 0 命中)
- [ ] 7. `RequestPlugin`/`EventPlugin`/`TerminalPlugin`/`getCapability` 不存在
- [ ] 8. claude-code 单例、files factory 落地
- [ ] 9. reconnect 不 reinstall capability,订阅/request 在新 socket 继续(测试)
- [ ] 10. 单例重挂 stale teardown 安全(5 步测试)
- [ ] 11. 同一 plugin instance 不并发装多连接(测试守卫)
- [ ] 12. SessionAttachController/ConnectionManager 等无 terminal wire strings(TS 层 grep 0)
- [ ] 13. 新增协议 = 新 feature + plugins 数组;transport 零改动(grep 佐证)
- [ ] 14. `requireAuth` 文本 0 命中
- [ ] 15. `npm run lint && tsc --noEmit && npm test && npm run coverage && npm run build` 全绿
- [ ] 16. e2e terminal-io 至少 P2P 或 relay 一条非 skip 真跑(CI 绿)

## §11. 风险与对策

| 风险 | 对策 |
|---|---|
| SessionRuntime 候选轮换从 configure→重建改变时序 | 以现有 SessionRuntime/useSessionRuntime/registry 测试为行为 oracle;语义差异(订阅重挂、generation)在 Task 6 内一次性对齐,不拖到后续 |
| `ok`/`error`/`not_attached` 入站语义分散(controller/CM/feature) | Task 4/6 以 ConnectionManager + SessionAttachController 现有测试为 oracle 收敛;行为不变优先于代码优雅 |
| UI 组件对 facade 的隐式依赖没被 tsc 抓到(mock 测试里) | Task 5/8 后 grep facade 路径 + grep wire strings 双门禁;组件测试 mock 层同步换 |
| e2e CI 迭代成本 | 先放开 relay 一条;每 push 自动跑 e2e;若 tmux 环境问题与 agent 无关则修 config/env |
| 覆盖率回落 | 每个 feature 自带完整 mock-surface 测试;Task 8 删除旧树只增不减;全量 coverage 在 Task 5/6/8 各跑一次 |


