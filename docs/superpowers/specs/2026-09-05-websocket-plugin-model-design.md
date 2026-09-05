# WebSocket Plugin Model — Design Spec

> Requirement: [#631](https://github.com/BestNathan/nession/issues/631) (Approved, 2026-09-05).
> Base: `origin/staging` (PR #630 terminal-websocket-unification merged; branch `feat/websocket-plugin-model`).
> 本文档为设计拍板层; 逐步实施见 `docs/superpowers/plans/2026-09-05-websocket-plugin-model.md`。

## 1. 目标回顾(摘自 #631)

把 `web/src` 的 WebSocket 层收敛为**唯一纯连接类** `new WebSocketService(url, plugins, options?)` + **能力插件挂载模型** `features/<name>/`,无 legacy、无兼容层、一次性全量迁移。public `connected` = handshake 完成(logical ready);插件挂载在 logical service 上,物理 reconnect 不重装。

## 2. 现状基线(staging,实测)

### 2.1 两层并存

```text
旧 facade 树(待删)                          socket 层(合入目标)
services/websocket/WebSocketService.ts      services/socket/SocketCore.ts   (403 行, 唯一 lifecycle)
  └─ WebSocketServiceCoreImpl (core.ts)        └─ MessageRouterImpl           (correlation/subscribe)
       └─ SocketCore ──────┴─────── SocketCore
  plugins/ EventPlugin|RequestPlugin|         AgentSocketClient (121)  ── SocketCore + URL token
           TerminalPlugin|ClaudeCodePlugin    ServerSocketClient (137) ── SocketCore 的薄适配(server auth 在 core.ts)
services/websocket.ts (38, singleton shim)    P2PConnectionAdapter (43, legacy shape 适配)
```

- server 与 agent 的真实差异:**server = socket open 后 `client.auth` handshake**(`core.ts:authenticateWith`,client_id 存 localStorage);**agent = URL query token**,无 handshake。
- 两者都用 `SocketCore`,说明"差异 = 构造选项"已经成立;**双壳 + facade + 4 个 message-shape plugin 是纯壳/纯历史**。
- `SocketCore.onopen` **先 `setState('connected')` 再跑 handshake** — public ready 领先于 auth;server 业务靠 `RequestPlugin.requireAuth()` 拦。→ 迁移后 handshake 成功才 `connected`,`requireAuth` 消失。

### 2.2 消费方全景

- **server 连接(app 级,唯一)**:`useAppConnection`(单例 owner)+ `useWebSocket` context;hooks(`useAgentData/useSessionData/useRealtimeUpdates/useQuickCommands/useSessionPreview/useTerminalSessions/useAgentRename/useDashboard/useProbePolling/useDeepLinkRestore`);组件(`Dashboard/AgentCard/CreateSessionDialog/KillConfirmDialog/QuickCommandsPanel/ServerInfoMenu/env/*/TerminalWorkspace 的 relay 腿`);`extensions/claude-code/services/claudeCodeService.ts`。
- **agent 连接(session 级,每 session 一个)**:`SessionRuntime` 构造/重建 `AgentSocketClient`,`p2pAdapter = client 本身`(P2PConnection legacy shape);`FileCapability`、`SessionAttachController`(client.attach)、`ConnectionManager`(P2P I/O 腿,`sendMessage/onMessage` legacy)消费同一对象。
- **relay 腿**:`ConnectionManager.serverConnection = WebSocketService facade`(`sendRelayInput/sendRelayResize/onTerminalOutput/onTerminalResize/onConnectionChange/isConnected`);`SessionRuntime` 经窄接口 `RelayServerConnection`(`onConnectionChange/beginRelay/isAuthenticated/getConnectionStatus`)驱动 relay begin/reattach。
- **wire string 分布**:见 #631 Scope 9 与实现计划 Task 1 的 wire→file 表。要点:`client.agents.list.response` 与 `agents.changed` 都触发 agents 变更回调;`terminal.output/resize` 在 server 是 base64、在 P2P 由 ConnectionManager 解码;keepalive 在 ConnectionManager。

### 2.3 重复定义点

- `runtime/FileCapability.ts`(83)与 `services/fileOps.ts createFileOpsFromRouter`(151)是同一 wire(`file.list/read/write/delete/create_dir/rename/cwd`)的两份实现 → 合入 `features/files`,只留一份 typed API,`FileOps` UI 形态保留为薄的 adapter(或直接迁移 UI 到 typed API)。
- `terminal.output` 解码逻辑散落:`websocket/plugins/EventPlugin.ts decodeTerminalData`、`ConnectionManager decodeB64` → 收进 `features/terminal`。
- base64 helper:`services/fileOps.ts`、`TerminalPlugin`、`ConnectionManager`、`EventPlugin` 各自实现 → 统一放 `features/<name>` 内,公共纯函数可进 `lib/encoding`(已有 `decodeBase64Utf8`)。

## 3. 设计拍板(open questions 决议)

| # | 问题 | 决议 | 理由 |
|---|------|------|------|
| Q1 | `serverInfo` 归 `features/sessions` 还是独立 | **独立 `features/server`**(单方法 `serverInfo()` + 测试) | wire family `client.server.info` 不是 session 操作;session feature 保持内聚;未来 server 级协议有家。开销:1 plugin + index + 少量测试。 |
| Q2 | typed subscription 是否共享 helper | **各 feature 自行实现**(每个 ~5 行内联),不建共享订阅层 | 共享 helper 有重新长出统一业务 facade 的引力;每个 feature 订阅类型 1~3 个,重复可接受。 |
| Q3 | `PluginSurface.send()` 形态 | **transport-owned `send(type, payload)`**:id/timestamp/msg_type 信封由 transport 生成,feature 只传 wire type + payload;保留 `subscribe` handler 的 `(payload, raw)` | feature 不再持有信封构造/`generateMessageId`,机制留在 transport;wire type/payload 仍由 feature 持有。`request()` 本就 transport-owned,语义一致。 |

补充拍板(实现计划层可再细化,但默认如下):

| # | 决策 | 说明 |
|---|------|------|
| D4 | `ConnectionState` 语义收紧 | 现有 4 值不变(`connecting/connected/reconnecting/disconnected`);`connecting` 内部含 socket-open→handshake 完成之间的窗口(**内部阶段**,不新增公开值)。reconnect 每次物理 socket open 后重跑 handshake,成功才 `connected`。 |
| D5 | 认证语义 | server 的 `client.auth` 进 `WebSocketServiceOptions.handshake`(经 `HandshakeSurface.request`);`authenticated` 不再作为公开状态值;`ConnectionStatus('authenticated')` 迁移映射:业务就绪判断全用 `connectionState === 'connected'`。旧 `ConnectionStatus` 类型在 consumer 迁移完成后删除。 |
| D6 | 文件归属 | `services/socket/` 收口为: `WebSocketService.ts`(lifecycle+plugins)、`MessageRouter.ts`(internal)、`types.ts`(plugin surface 契约)。`SocketCore.ts`/`AgentSocketClient`/`ServerSocketClient`/`P2PConnectionAdapter`/`agentSocketUtils`(URL/backoff 常量并入 options helpers)删除或内化。 |
| D7 | capability 实例 | server 应用级能力(`agents/sessions/server/env/commands/claude-code/terminal-server`)= **模块单例 feature**(`export const agentsApi = new AgentsPlugin()`),随 `new WebSocketService` 安装;文件与 agent-terminal 能力 = **factory-per-connection**,由 `SessionRuntime` 创建实例并随 session 连接安装。单例重挂用 #631 Scope 6 的 generation 模式防 stale teardown。 |
| D8 | 连接拥有 | `useAppConnection` 唯一持有 server `WebSocketService`(dispose 必须 identity-safe:`dispose 前确认仍是当前实例`);`SessionRuntime` 持有 agent `WebSocketService`;`WebSocketContext` 保留但**只传 transport + relay 句柄**,不承担业务 facade。 |
| D9 | `use(plugin)`/`unregister(name)` 保留 | 构造期 plugins 数组 = 常规;`use` 允许同实例替换(先 teardown 旧),供热替换/测试;`getCapability` 删除。 |
| D10 | `RelayServerConnection`/legacy server shape 收口 | relay 腿消费的新句柄 = `terminal-server` feature 的 typed api(`beginRelay/endRelay/sendInput/sendResize/onOutput/onResize` + 连接就绪回调),由 app connection owner 以依赖注入传给 runtime/ConnectionManager;SessionRuntime 不再见 wire。legacy `ConnectionStatus` 订阅由 `connectionState` 就绪回调替代(runtime 的 `status==='authenticated'` 判断改为 `'connected'`)。 |
| D11 | attach 时序不变 | `AttachStateMachine/SessionAttachController/AddressAttachPolicy` 职责不动(#631 Non-Goal);只有底层依赖从 `P2PConnection`(legacy)换成 agent WebSocketService 的 PluginSurface + `features/terminal` typed attach API。 |
| D12 | `__binary__` 帧标记 | P2P inbound 二进制经 `onBinary`(transport)分发;ConnectionManager 不再经 `onMessage('__binary__')`。 |

## 4. 目标架构

```text
React (Dashboard / session-first)
  │  import 单例 feature API                    │  useSessionRuntime → SessionRuntime
  ▼                                             ▼
agentsApi sessionsApi serverApi envApi          SessionRuntime (每 session)
commandsApi claudeCodeApi terminalServerApi         ├─ WebSocketService(agent url+token,
  │        (app 级单例, 全部 install 到唯一 server        │   plugins: [filesApi#n, terminalAgentApi#n])
  │         WebSocketService)                         │      ├─ MessageRouter(logical)
  ▼                                             │      ├─ files feature (factory)
new WebSocketService(serverUrl, [单例…],         │      └─ terminal-agent feature (factory)
  { handshake: client.auth })                    │          → typed attach/send/sendResize/…
  ├─ MessageRouter (logical, 订阅跨 reconnect)   │      └─ AttachStateMachine / SessionAttachController
  └─ plugins[].install(surface) → teardown       │          (WHEN;wire 走 terminal feature)
                                                 └─ ConnectionManager(WHEN;wire 走 feature)
```

- 传输层只有 `services/socket/WebSocketService.ts`(唯一,含 handshake-readiness + plugin registry);server/agent 差异 = url + options.handshake + plugins 数组。
- feature 目录:`features/<name>/{<Name>Plugin.ts, index.ts, types.ts, __tests__/}`(单方法 feature 可瘦身)。
- 每个 feature 自持 wire strings / encode-decode / typed subscribe/request/send;**feature 外代码不再出现 wire message strings**。

## 5. 契约(最终 TS 形态,实现计划以此为真)

```ts
// services/socket/types.ts (收口后)
export interface SocketMessage { msg_type: string; id: string; timestamp: number; payload: unknown; }

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface RequestOptions { timeoutMs?: number; }

/** handshake 专用:物理 socket OPEN、logical ready 尚未成立时可发请求。 */
export interface HandshakeSurface {
  send(type: string, payload: Record<string, unknown>): void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

/** install() 收到的连接面:纯消息面 + logical 状态。feature 不知道挂在 server 还是 agent。 */
export interface PluginSurface {
  readonly connectionState: ConnectionState;
  send(type: string, payload: Record<string, unknown>): void;
  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void;
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
  reconnectBaseDelay?: number;   // default 1s, exp backoff, cap 30s
  onError?: (error: Error) => void;
}

// 公开类(即唯一 transport)
export class WebSocketService implements PluginSurface {
  constructor(url: string, plugins: CapabilityPlugin[] = [], options?: WebSocketServiceOptions);
  connect(): Promise<void>;       // handshake 成功才 resolve
  disconnect(): void;
  dispose(): void;                // 幂等;plugin teardown 一次
  readonly connectionState: ConnectionState;
  send(type, payload): void; subscribe(...): () => void;
  request<T>(...): Promise<T>; onBinary(...): () => void;
  waitForConnection(...): Promise<void>; onConnectionStateChange(...): () => void;
  use(plugin: CapabilityPlugin): void;        // 同名先 teardown 再 install
  unregister(name: string): boolean;
}
```

**readiness 状态机**(公开值):

```text
disconnected
  →(connect)→ connecting ──socket OPEN──► [内部 handshaking] ─handshake 成功──► connected
        │  handshake 失败 / socket 丢失              │                            │
        └──────────► reconnecting ──► connecting     └── (每次物理 socket 重建都重跑 handshake)
max attempts 耗尽 ──► disconnected
```

- `connect()` 在 handshake 成功前不 resolve;`waitForConnection()` 同;普通 `request()` 在 not-ready 时 wait(deadline 内)而非放行;`send()` 在 socket 未 OPEN 时 throw(与今日一致)。
- handshake 经 `HandshakeSurface`(不受 ready gate 约束,直接走 router + ws-send);handshake 失败 = 本次连接失败 → 统一 reconnect/disconnected,waiters/pending 全部 reject。
- plugin 生命周期:构造时 install 一次(logical);reconnect 不重装、订阅经 MessageRouter 自动续活;dispose/`unregister`/同名 `use` 时 teardown。teardown 必须 deterministic+idempotent(幂等多次调用无副作用)。

## 6. Feature 目录与 wire 归属

```text
web/src/features/
├── agents/      agentsApi (单例): client.agents.list / client.agent.rename / client.agent.delete
│                subscriptions: agents.changed + client.agents.list.response → onAgentsChanged
├── sessions/    sessionsApi (单例): client.sessions.list(force/stale) / client.session.create / kill /
│                attach(requestAttach) / capture_preview(base64→ansi, 用 lib/encoding) 
│                subscriptions: sessions.changed + client.sessions.list.response → onSessionsChanged
├── server/      serverApi (单例): client.server.info → serverInfo()
├── env/         envApi (单例): client.env.list/get/write/delete + client.session.env.apply/unset/active/query
├── commands/    commandsApi (单例): client.commands.list/add/remove/update
│                subscriptions: server.commands.changed → onCommandsChanged
├── claude-code/ claudeCodeApi (单例): extension.claude_code.list / .read (+feature 内 types)
├── files/       createFilesApi(): file.list/read/write/delete/create_dir/rename/cwd + base64 helpers;
│                FileOps UI 形态 adapter 可在此提供(至 UI 迁移完成)
└── terminal/    server.ts → terminalServerApi (单例, app server 连接):
│                    client.session.relay.begin/end; terminal.input/resize(relay, session_name+base64);
│                    terminal.output/resize subscriptions(server 广播, session_name 路由, base64→Uint8Array)
│                agent.ts  → createTerminalAgentApi(surface?) / factory, 挂在 agent 连接:
│                    client.attach(request, typed ack); terminal.input/resize(session_name+base64);
│                    terminal.output(resize) subscriptions; keepalive.ping (30s)
└── index.ts(可选 re-export)
```

- 重挂语义(与 #631 Scope 6 的 6 步测试一致):install(B) 允许发生在 teardown(A) 之前(B = 新 connection/generation;StrictMode 迟到 teardown 是常态);generation 计数是防 stale cleanup 的机制,install **不做**跨 surface throw。同 service 同名 `use()` 替换 = 先 unregister(teardown)再 install。真正的"不并发双挂"由创建方纪律保证(owner dispose 旧连接后才建新连接)+ 6 步测试证明最终 detached;测试覆盖。
- 单例 stale-teardown 模式(#631 Scope 6)逐字落实 + 5 步测试(install A→install B→teardown A→B 仍活→teardown B→detached)。

## 7. Connection ownership 与迁移后形态

```ts
// hooks/useAppConnection.ts(重写)
const service = new WebSocketService(serverUrl, [agentsApi, sessionsApi, serverApi, envApi,
  commandsApi, claudeCodeApi, terminalServerApi], {
  handshake: (surface) => surface.request('client.auth', { auth_token: token, client_id: cid }),
  maxReconnectAttempts: 5,
});
// 单例 feature 重挂:每次 new WebSocketService 重新 install → 各自 generation++(stale-safe)
// dispose: 仅当 service 仍是当前实例时 dispose;StrictMode/re-login identity-safe
```

- `useWebSocket()` context 继续提供 `WebSocketService | null`(transport 身份 + relay 句柄来源),**不再有业务方法**;需要业务 API 的代码 import 单例 feature。
- `sessionRuntime` 获得 server relay 依赖的方式:context 提供 `{ service, relay }`,其中 `relay` 由 owner 用 `terminalServerApi` 包成窄句柄(D10),传入 `useSessionRuntime` → `SessionRuntimeConfig.serverConnection`。
- agent 连接构造(在 `SessionRuntime.syncAgentClient` 内):

```ts
const files = createFilesApi();      // factory, 每连接新实例
const term = createTerminalAgentApi(); // factory
const ws = new WebSocketService(url, [files, term], { maxReconnectAttempts });
```

- 状态机/controller/ConnectionManager 的依赖从 legacy 形态换成:**typed feature api**(wire)+ **PluginSurface 就绪**(`connectionState`);`RuntimeMirrorSnapshot.p2pConnection` 与 `getP2PConnection()` 的 legacy 形态下线后,snapshot 暴露 `connectionState` + typed 句柄。useSessionRuntime/atoms 同步改名(atom `p2pConnectionAtom` 承载内容改为 agent connection 标识 + state,细节见实现计划 Task 6)。

## 8. 删除清单(合入时全删,无 @deprecated)

`services/websocket/**`(facade/core/types/4 plugins/其单测)、`services/websocket.ts`、`services/socket/SocketCore.ts`、`AgentSocketClient.ts`、`ServerSocketClient.ts`、`P2PConnectionAdapter.ts`、`services/socket/p2pTypes.ts`、legacy `P2PConnection` 相关 shape、`runtime/FileCapability.ts`、`services/fileOps.ts`(若 UI 已迁 typed API;FileOps/FileEntry/FileData 类型与 readFileChunked 迁至 feature 或保留纯 UI 类型)、`useTerminalStateMachine`(仅 barrel re-export,已无活动消费)、旧 `ConnectionStatus`(待 consumer 迁完)、`websocket/` 引用的一切 re-export 与单例 helper(`create/get/destroyWebSocketService`)、`useWebSocket` 的 facade 型消费。

## 9. 验证矩阵

| 层 | 验证 |
|----|------|
| transport 单测 | readiness(handshake 前 request 不放行/connect 不 resolve)、handshake surface 无死锁、失败→reconnect、reconnect 重跑 handshake 不重装 plugin、订阅跨 generation 续活、use/unregister/dispose、双挂禁止、stale teardown |
| feature 单测 | mock PluginSurface(不发真实 WebSocket);wire payload/encode-decode/订阅路由/typed API |
| runtime/terminal | 既有 AttachStateMachine/AddressAttachPolicy/registry/ConnectionManager/SessionRuntime 测试改依赖后全绿 |
| hooks/组件 | 既有 integration 套件(useAppConnection/useDashboard/env/claude-code/session-first…)迁后全绿 |
| 门禁 | `npm run lint`(0)、`tsc --noEmit`(0)、`npm test`(全绿)、`npm run coverage`(lines≥78/func≥72/branches≥65/stmts≥76)、`npm run build` |
| e2e(CI-only) | #631 criterion 16:terminal-io 至少 P2P 或 Relay 一条真链路不再 `test.skip`(改为 CI 门控);session-lifecycle 评估是否一并恢复 |
| 功能回归(本地 full stack + Playwright) | 登录/auth、agents/sessions 列表与变更推送、create/kill、relay attach + echo、P2P attach + echo、env CRUD/apply、quick commands、claude-code、re-login、StrictMode 双挂 |

## 10. 分期(单分支可编译推进;合入即全量切换)

1. transport 收口(WebSocketService + readiness + plugin registry + 测试)
2. `features/*` 建全(含 wire 归属与单测)
3. server connection owner + UI server 消费迁移(singleton feature 挂载;useAppConnection/useWebSocket/Dashboard hooks/组件/env/commands/claude-code)
4. agent/session 连接迁移(SessionRuntime/FileCapability/attach controller/ConnectionManager/useSessionRuntime/session-first)
5. relay 腿迁移(TerminalWorkspace/useRelayServerLifecycle/relay 句柄)
6. 删除 legacy 树 + 类型收口
7. e2e terminal-io 恢复(CI 门控)+ 全量门禁 + Playwright 功能验证
