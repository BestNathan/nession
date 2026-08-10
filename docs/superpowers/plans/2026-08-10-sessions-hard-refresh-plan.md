# Sessions 硬刷新 + sessions.changed 推送

## 问题

Agent 离线再上线后,Web UI 的会话列表是空的,但 agent 卡片显示 online 且 session_count 正常。

**根因(两条独立的断裂):**

1. **`sessions.changed` 是死订阅** — 前端 `EventPlugin.ts:75` 订阅了它,`useRealtimeUpdates.ts:23` 接到 `setSessions`,但服务端 `web_client_registry.rs` 从未实现这条广播(`grep -rn "sessions.changed" crates/` 为空)。前端只在首次挂载拉一次 sessions,之后没有任何事件让它重拉。

2. **重注册清空 + 5s 空窗** — `handler.rs:265` 在 agent 重注册时 `remove_by_agent` 清空该 agent 全部 session,要等 agent 下一次 SessionWatcher poll(默认 5s)才全量重报。这期间 `client.sessions.list` 返回空。

## 方案

新增 server→agent 的 `server.sessions.list` 协议,让前端刷新时触发 server 向所有在线 agent 实时拉取 tmux 真实状态并重建 registry(强一致);同时补上 `sessions.changed` 广播的发送端(最终一致)。两者互补:硬刷新解决「我要最新数据」,推送解决「别人改了我自动更新」。

**已确认的设计决策:**
- 失败语义:agent 超时 → **保留** registry 中该 agent 的现有 session,响应带 `stale_agents: [...]`,前端标记「可能过期」。不能因网络抖动误删活着的 session。
- 刷新入口:刷新按钮 = 硬刷新。首次挂载 / 创建后 / 杀会话后仍走普通 list(读内存,~ms)。
- 范围:硬刷新 + `sessions.changed` 推送一起做。

**复用的现有基础设施(全部已就位):**

| 能力 | 现有实现 |
|---|---|
| server→agent 请求/响应(request_id + oneshot) | `CommandBroker::send_command` / `resolve_command` (`command_broker.rs:81`) |
| 超时封装 | `ConnectionHandler::agent_command` (`handler.rs:1809`) |
| 多 agent fan-out 范本 | `handle_client_env_list` (`handler.rs:1832`) |
| agent 侧 command 分发 | `match msg.msg_type` → `agent.session.command.response` (`server_client.rs:577`) |
| tmux 数据源 | `SessionManager::list_sessions()`,`ServerClient` 已持有 `self.tmux` |
| 并发原语 | `futures-util` 已是 workspace 依赖 |

---

## 实现步骤

### 1. Agent 侧:响应 `server.sessions.list`

**`crates/nession-agent/src/connection/server_client.rs`**

- `msg_types` (第 53 行) 加常量 `SERVER_SESSIONS_LIST = "server.sessions.list"`。
- `handle_server_message` 的 match (第 577 行) 加分支,照 `server.env.list`(第 635 行)的形状写:
  - 读 `request_id`(用现有 `str_field` helper)
  - `self.tmux.list_sessions().await.unwrap_or_default()`
  - 回 `agent.session.command.response`,`command: "sessions.list"`,`success: true`,
    `sessions: [{ name, window_count, attached_clients, created_at }]`
  - tmux 不可用时返回空数组 + `success: true`(「这个 agent 上没有 session」是合法状态,不是错误);只有序列化等真实故障才 `success: false`

status 由 server 侧从 `attached_clients` 推导(与 `session_watcher.rs:181` 的规则一致:`>0` → active,否则 detached),agent 不重复这个逻辑。

### 2. Registry:原子替换

**`crates/nession-server/src/registry/session.rs`**

新增 `replace_agent_sessions(&self, agent_id: &str, sessions: Vec<SessionInfo>)`:

- 在**同一个写锁**内完成 `retain(|_, s| s.agent_id != agent_id)` + 逐条 `insert`。这消掉一整类竞态:否则「先 remove_by_agent 再逐条 update_session」的中间态会让并发的 `list()` 看到空列表。
- DB 写穿在锁外做(`delete_sessions_by_agent` + 逐条 `insert_session`),失败仅记日志 —— 与 `update_session` (第 104 行) 现有语义一致:内存是服务路径,DB 只是重启恢复缓存。
- 返回被移除的 session_id 列表,供调用方清理 env usage 锁(参照 `websocket.rs:138` 的用法)。

顺手修 `remove_by_agent` (第 145 行) 的冗余写法:`keys().filter()` 里套 `sessions.get()` 是多余的,直接在 `iter()` 上过滤。

### 3. Server 侧:fan-out 重建

**`crates/nession-server/src/server/handler.rs`**

`handle_client_sessions_list` (第 750 行) 读 `payload.force`:

- `force != true` → 保持现有行为不变(读内存)
- `force == true`:
  1. `agent_registry.list()` 过滤 `AgentStatus::Online`(offline agent 没有活的 control 连接,`send_command` 会立刻 drop tx,白等)
  2. **并发** fan-out:`futures_util::future::join_all`,每个 agent 一个 `agent_command(agent_id, "server.sessions.list", json!({}))`。**不要**照抄 `handle_client_env_list` 的串行 `for` 循环 —— 那里 10 个 agent 最坏 100s,而 sessions 刷新是用户点按钮同步等待的
  3. 单 agent 超时:新增短超时常量(3s),不复用 `agent_command` 的 10s
  4. 成功的 agent → 转成 `SessionInfo`(`session_id = "{agent_id}:{session_name}"`,status 从 attached_clients 推导)→ `replace_agent_sessions`;被移除的 session 调 `env_service.usage.clear_session`
  5. 失败的 agent → 不动其数据,收进 `stale_agents`
  6. 重建完再 `list()` / `list_by_agent()` 取结果,响应加 `stale_agents` 字段
  7. 结束后 `broadcast_sessions_changed`(其他浏览器也同步)

`agent_id` 过滤参数与 `force` 正交:带 `agent_id` 时只 fan-out 那一个 agent。

### 4. Server 侧:补上 `sessions.changed` 发送端

**`crates/nession-server/src/server/web_client_registry.rs`**

新增 `broadcast_sessions_changed(&self, session_registry: Arc<SessionRegistry>)`,照 `broadcast_agents_changed` (第 78 行) 的形状。payload 里 session 的 JSON 字段必须与 `handle_client_sessions_list` (第 781 行) 完全一致 —— 前端 `setSessions` 直接吃这个结构,字段不一致会静默出现 undefined。

调用点:
- `handle_agent_session_update` (第 372 行) — 增/改/删(含 `status == "gone"` 的早返回分支)
- `handle_client_session_create` 成功后 (第 1378 行 `update_session` 之后)
- `handle_client_sessions_list` 的 force 分支重建完
- `websocket.rs:137` 的 sweeper 清空后
- `handle_agent_register` (第 265 行) 的清空后

sweeper 那处在后台 task 里,需要把 `web_client_registry` 的 Arc clone 进 spawn(现在只 clone 了 session/agent registry + env_service)。

### 5. 前端接线

**`web/src/types.ts`** — `SessionsListResponse` (第 103 行) 加 `stale_agents?: string[]`。

**`RequestPlugin.ts`** — `listSessions(agentId?: string)` (第 87 行) 改签名为 `listSessions(opts?: { agentId?: string; force?: boolean })`,`force` 为真时 payload 带 `force: true`。返回值需要带上 `stale_agents`,所以返回类型从 `Session[]` 改成完整 response(或额外返回 stale 列表)。

**注意 CLAUDE.md 的事件处理器规则**:`RefreshButton` 内部已经是 `onClick={() => onClick()}`,但 `useSessionData.fetchSessions` 若改成接 options 对象,`SessionsSection.tsx:36` 传的 `fetchSessions` 必须确保不会把 React 事件对象当参数传进去 —— 用 `() => fetchSessions({ force: true })` 显式包裹。

**`useSessionData.ts`** — `fetchSessions` 接 `{ agentId?, force? }`,新增 `staleAgents` state。

**`SessionsSection.tsx`** — 刷新按钮传 `() => fetchSessions({ force: true })`。

**`SessionList.tsx`** — `stale_agents` 里的 agent,其会话行加灰色「可能过期」角标(用现有 Badge + Tooltip 说明「该 agent 未响应,数据可能过期」)。

**`useDashboard.ts` / `Dashboard.tsx`** — 透传 `staleAgents`。

`useTerminalSessions.ts` 的 `refetch` 也可以走 force(终端页切换会话时拿最新列表),但不是必需 —— 保持现状也行,先不动以缩小改动面。

### 6. 测试

**Rust:**
- `session.rs`:`replace_agent_sessions` 替换掉旧的、保留其他 agent 的、返回值正确、空列表清空
- `handler.rs`:force 分支在无 online agent 时不炸;单 agent 超时 → 该 agent 数据保留 + 出现在 `stale_agents`(用现有 `test_handler` + `proto_msg` + `parse_reply` helper,参照第 3383 行 `sessions_list_with_filter`);非 force 行为不变(回归)
- `server_client.rs`:`server.sessions.list` 分支返回正确 msg_type + command 字段(参照第 1403 行的既有断言风格)

**Web:**
- `useSessionData`:force 参数正确透传;`staleAgents` 正确落进 state
- `SessionList`:stale agent 的行渲染角标
- `EventPlugin`:`sessions.changed` → `notifySessionsChange`(补上这条本来就该有的测试)

覆盖率门槛:Rust 80%,web 80%(pre-commit 会跑)。

### 7. 验证

- `cargo fmt --all -- --check && cargo clippy -- -D warnings && cargo test`
  (注意:`#[allow(clippy::*)]` 禁用;`too-many-lines-threshold = 150`,`handle_client_sessions_list` 加 force 分支后可能超,需要抽 helper 函数)
- `cd web && npm run lint && npx tsc --noEmit && npm test`
- 本地起 demo 栈(`HOME=/tmp/nession-demo`),Playwright 走一遍关键场景:
  1. 建几个 session → 列表正常
  2. `pkill nession-agent` → 等 offline + 30s 宽限清空 → 列表空
  3. 重启 agent → **不手动刷新**,验证 `sessions.changed` 自动恢复列表(这是修复 #1 的证据)
  4. 点刷新按钮 → 验证走 force 路径
  5. agent 进程挂起(`kill -STOP`)制造超时 → 刷新 → 验证旧数据保留 + stale 角标(这是修复失败语义的证据)
- 截图存 `.playwright-mcp/screenshots/`(gitignored),PR body 引用

## 风险

- **`too-many-lines` clippy 门槛** — `handle_client_sessions_list` 加 force 分支后大概率超 150 行,必须抽 helper(如 `refresh_sessions_from_agents`)。这是硬门槛,不能 `#[allow]`。
- **广播 payload 字段漂移** — `broadcast_sessions_changed` 与 `handle_client_sessions_list` 两处手写 session JSON,容易不一致。抽一个 `session_to_json(&SessionInfo) -> Value` 共用。
- **fan-out 放大** — 每次点刷新给所有在线 agent 发一条命令。agent 数量大时是 N 倍放大。当前规模无所谓,但值得在响应里记 `refreshed_agents` 数量便于观察。
- **`futures-util` 已在 server 的 Cargo.toml (第 26 行)**,无需加依赖。

## 提交

分支已在 worktree(`fix/agent-reonline-sessions-analysis`)。按 CLAUDE.md 约定分几个 commit:

1. `feat: add server.sessions.list protocol for agent session queries`(agent 侧)
2. `feat: atomic replace_agent_sessions in session registry`(registry)
3. `feat: force-refresh sessions by querying all online agents`(server fan-out)
4. `fix: broadcast sessions.changed to web clients`(补死订阅的发送端)
5. `feat: wire force refresh and stale badges in web UI`(前端)

全部 `Co-Authored-By: Claude <noreply@anthropic.com>`。PR body 带截图 + `Closes #<ISSUE>`(如果有对应 issue)。
