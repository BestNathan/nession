# WebUI Terminal 组件与布局健壮性优化 — 设计文档

**Issue:** [#51](https://github.com/BestNathan/nession/issues/51)
**日期:** 2026-07-14
**作者:** Nathan
**状态:** Approved

---

## 1. 背景

WebUI 终端栈由 React 外壳(`Terminal.tsx`)、布局宿主(`TerminalView.tsx`、`FileTabs.tsx`、`SidePanel.tsx`、`BottomBar`)、工具栏(`TerminalToolbar.tsx`)以及 `web/src/terminal/` 引擎模块(`TerminalView`、`ViewportManager`、`ConnectionManager`、`InputManager`、`Renderer`、`ThemeManager`、`DeviceProfile`)组成。一次完整代码审查发现 9 项问题,涵盖连接健壮性、渲染器/主题接线缺失、探测时机、输入打磨等层级。

本设计将这些整理为三条工作线加搭车修复,并纳入两项关联改进:渲染器能力探测/选择/持久化,以及地址探测时机前移。

### 探索阶段的两处现状修正(相对 Issue 初稿)

1. **P2P 瞬断不会重建终端 / 不丢滚动历史。** `useP2PConnection` 已有完整重连(指数退避、上限 10、暴露 `connectionState`),且连接对象是 identity-stable(`useMemo` + getter)。`Terminal.tsx` 依赖数组在瞬断时不变,**不重建**。真正的 P2P 缺口是:(a) 重连时无横幅;(b) 重连成功后不重新 attach → tmux 不重绘,停滞至用户按键。树重建仅发生在 relay fallback(`mode` 变化)时。

2. **地址探测可彻底脱离 session/attach。** `measureLatency` 已是裸 WebSocket 握手计时(不发数据、不需 session/token)。唯一卡点是候选地址清单来源——当前仅 `requestAttach` 响应携带。解决办法:让 `client.agents.list` 顺带返回 `addresses`(server 已有 `agent.addresses`),浏览器即可脱离 attach 直接测速。

---

## 2. 目标

1. 修复所有已识别连接层缺陷,使 P2P 与 relay 的断线/重连行为正确且对用户可见。
2. 补全渲染器接线:自动探测 WebGL 能力,attach 环节开放渲染器选择,记住上次选择,不可用时自动回退 Canvas。
3. 将地址延迟探测从"attach 对话框现场测速"改为"登录后 per-agent 主动轮询缓存",attach 永远读缓存、不阻塞。
4. 消除首帧与 resize 的视觉瑕疵(字号闪烁、拖拽抖动)。
5. 统一工具栏在两种布局分支下的禁用状态。

## 3. 非目标

- 不改终端视觉主题(Catppuccin Mocha 不变)。
- 不重写 P2P/relay 传输协议本身。
- 不引入新终端功能(分屏、多会话标签等)。
- 不做运行时渲染器切换(切换 = 返回 dashboard 重新 attach)。
- 不根治子行余量(sub-row remainder),保持现有背景色掩盖,记为已知取舍。

---

## 4. 架构总览

三条工作线 + 搭车修复:

| 工作线 | 覆盖问题 | 影响面 |
|--------|----------|--------|
| A 连接健壮性 | 1, 2 | `ConnectionManager`、`Terminal.tsx`、`TerminalView` |
| B 地址探测前移 | 新增改进 | server `agents.list`、新 hook `useAddressProbeCache`、`AttachDialog`、`useAddressPlan` |
| C 渲染器 + 接线修复 | 3, 5 | `Renderer`、`Terminal.tsx`、`AttachDialog`、`attachPrefs`、`TerminalView.tsx`、类型 |
| 搭车修复 | 4, 6, 7, 8 | `TerminalView.tsx`、`ViewportManager`、`InputManager` |
| 记录不做 | 9 | spec only |

---

## 5. 工作线 A — 连接健壮性

### 5.1 Relay 重连上限 + lost 生效(问题 1)

`ConnectionManager.setupRelay` 当前无限 `setState('reconnecting', attempt+1)`,`'lost'` 是死代码。改为:

- 新增常量 `RELAY_MAX_ATTEMPTS = 10`。
- `onConnectionChange` 收到 `disconnected`/`connecting`:`attempt+1`;若超过 `RELAY_MAX_ATTEMPTS` → `setState('lost', attempt)`(触发 failed 横幅 + 现有 3s 后 `onDisconnect`),不再自增。
- 收到 `authenticated`:`setState('connected', 0)` 并重新 attach(现有逻辑)。
- 横幅计数封顶 `attempt/10`,不再出现 `11/10`。

### 5.2 P2P 重连横幅 + 恢复后重新 attach(问题 2)

采用 **React 层驱动(A2)**:`p2pConnection.connectionState` 是 getter(不触发重渲染),而 `useP2PWithFallback` 已将其读入 effect 依赖,React 层本就在观察它。

- `Terminal.tsx` 新增 effect 观察 `p2pConnection?.connectionState`(仅 P2P 模式):
  - `reconnecting` → 命令 view 显示 reconnecting 横幅(带 `reconnectAttempt`)。
  - `connected`(且此前为 reconnecting)→ 命令 view 清横幅**并重新 attach**(发 `client.attach`,不注入 `\r`,沿用现有约定)。
  - `disconnected` → 交由 `useP2PWithFallback` 现有逻辑(轮换地址 / fallback relay)。
- `TerminalView` 暴露命令式方法:`setExternalBanner(state, attempt)`、`reattach()`。`ConnectionManager` 增加 public `reattach()`(复用现有 `attach()`)。
- **不改依赖数组** → 瞬断不重建 → 滚动历史保留(必达标准)。

### 5.3 banner 状态合流

横幅两来源:`ConnectionManager.onStateChange`(relay)与新 P2P 外部观察。`Terminal.tsx` 的 `banner` state 仍是唯一渲染源;P2P 外部 banner 与 relay banner 写入同一 state,按最近更新覆盖。两种模式互斥(同一时刻只有一种连接活跃),不会并发打架。

### 5.4 边界

- P2P 重连中用户 Back/Ctrl+D → effect cleanup + `view.dispose()` 幂等清理。
- P2P 掉线与换地址(mode/连接对象变化致重建)同时发生 → 重建路径优先,外部 banner effect 在新实例重新建立。

---

## 6. 工作线 B — 地址探测前移与缓存

### 6.1 Server 改动:`agents.list` 返回 addresses

`handle_client_agents_list`(`crates/nession-server/src/server/handler.rs`)每个 agent 的 JSON 增加 `addresses` 字段,复用 attach 路径已有的 `build_probed_addresses` / registry `agent.addresses`。web 端 `Agent` 类型增加 `addresses?: ProbedAddress[]`。

### 6.2 新增 `useAddressProbeCache` hook

应用级单例(App/Dashboard 层持有,登录后启动):

- **数据结构:** `Map<agent_id, { latencies: AddressLatency[]; orderedUrls: string[]; probedAt: number }>`。
- **测速:** 直接对 agent 的 `addresses` 调 `testAddresses`(裸握手 ping),**不需 session、不调 `requestAttach`**。
- **主动轮询:** 登录后首轮对所有 `status==='online'` 且有 P2P 地址的 agent 并发探测;此后每 **5 分钟**重测更新缓存。仅覆盖当前在线 agent。
- **失败不缓存:** 探测失败的 agent 不写缓存,下轮重试。
- **暴露 API:** `getProbe(agentId)`(读缓存,可能 undefined)、`refreshAgent(agentId)`(手动强刷)。
- **陈旧策略:** `probedAt` 超过 5 分钟视为陈旧,`getProbe` 不返回陈旧值(避免误导);离线 agent 缓存自然陈旧。

### 6.3 AttachDialog 退化为"缓存展示器 + 选择器"

- **移除** dialog 内 `testAddresses` 现场探测(现 `useEffect` 里的阻塞测速)。
- dialog 仍调 `requestAttach(session_id,'p2p')` 拿 `attachInfo`(需要 `connection_token`),但**不再现场测速**。
- 延迟信息从 `getProbe(agentId)` 读:命中 → 显示各路径延迟 + 推荐最快;未命中 → 不显示延迟、不 loading,路径列表照常,用户仍可选 Auto/手选。
- **"重新测试"入口:** 保留按钮,调 `refreshAgent(agentId)`,测完刷新显示。这是 dialog 内唯一触发探测的动作。
- 确认时 `orderedUrls`/`latencies` 优先取缓存;无缓存则传空(连接层按默认顺序连,P2P 失败 fallback)。

### 6.4 Auto 无测速信息时行为

`useAddressPlan` 已支持 `orderedUrls` 为空的兜底(走 `agent_address` 或候选原序)。无缓存 → 传空 → 按 server 优先级/`agent_address` 连,P2P 失败 fallback relay。延迟仅作信息/推荐,绝不阻塞。

### 6.5 边界

- 刚登录首轮未测完就 attach → 无缓存,按 6.3/6.4 不阻塞路径。
- 同一 agent 多 session → 共享一份缓存(地址是 agent 级)。
- session 列表/agent 集合变化 → 缓存按 `agent_id` 天然复用,新 agent 下轮纳入。

---

## 7. 工作线 C — 渲染器 + 接线修复

### 7.1 WebGL 能力探测(问题 3 前置)

新增 `detectWebGLSupport()`(提取 `Renderer.supportsWebGL` 逻辑为独立导出函数)。登录后探测一次存应用级状态(能力不随会话变,无需轮询)。

### 7.2 AttachDialog 加 "Renderer" 行(选 A)

- Dialog 内新增一行,与 Mode/Path 并列:WebGL 可用时显示 `WebGL / Canvas`,默认沿用 localStorage 上次选择;不可用时只显示 `Canvas`(置灰 + "WebGL not supported" 说明)。
- 选择写入 localStorage(扩展 `attachPrefs`,新增 `renderer` 字段)。
- `AttachChoice` 增加 `renderer: 'webgl' | 'canvas'`,经 `useAttachFlow`→`AttachedSession`→`TerminalView.tsx` 传到 `Terminal`。

### 7.3 接线修复(问题 3 核心)

`Terminal.tsx` 当前仅传 `{ rendererType:'canvas', connection }`。改为完整传入:

- `rendererType`: 来自用户选择;WebGL 不可用时强制 `canvas`(自动回退)。
- `deviceProfile`: `Terminal.tsx` 挂载后按 `containerRef.clientWidth` 求 `detectProfile` 再传入,**避免 ViewportManager 在 `clientWidth=0` 时误判 phone**(消除首帧字号闪烁,必达标准)。
- `theme`: 保持 Catppuccin(ThemeManager 默认已是,可不显式传)。
- `targetColumns`: 传默认 80,接上 `ViewportManager.setTargetColumns`(消除死选项)。

### 7.4 WebGL context-loss 回退 Canvas(问题 5)

`Renderer.onContextLoss` 当前只 `dispose()`。改为:dispose WebGL 后**显式 `loadAddon(new CanvasAddon())`** 并更新 `this.type`,终端继续可用,不依赖隐式 DOM 回退。

### 7.5 运行时不支持切换渲染器

按选 A,渲染器 attach 时定好;运行时切换(需重建 xterm)不在本轮。切换 = 返回 dashboard 重新 attach。

---

## 8. 搭车修复

- **问题 4 toolbar 禁用一致:** `TerminalView.tsx` 无 fileOps 分支补 `disabled={toolbarDisabled}`(必达标准)。
- **问题 6 scaleFont 可恢复:** `ViewportManager.scaleFont` 增加"容器变宽时向上恢复字号"分支(当前只减不增),上限回 profile 原始字号。
- **问题 7 ResizeObserver 防抖:** observer 回调用 rAF 合并(或 ~100ms debounce),消除拖拽抖动(必达标准)。
- **问题 8 鼠标节流:** `InputManager` 只对 move 类事件节流,按下/释放立即透传(低风险)。
- **问题 9 子行余量:** 本轮不做,保持背景色掩盖,记为已知取舍。

---

## 9. 数据流

```
登录 (authenticated)
  ├─ detectWebGLSupport() ──────────────► 应用级 webglSupported 状态
  └─ useAddressProbeCache 启动
       ├─ listAgents() → 每个在线 agent 的 addresses
       ├─ testAddresses(裸握手 ping) → Map<agent_id, probe>
       └─ 每 5min 重测

Attach 点击
  └─ AttachDialog
       ├─ requestAttach(p2p) → attachInfo (token + addresses)
       ├─ getProbe(agentId) → 显示延迟(命中)/ 不显示(未命中)
       ├─ Renderer 行 → 用户选 webgl/canvas (默认读 attachPrefs)
       └─ 确认 → AttachChoice { mode, attachInfo, orderedUrls, latencies, selectedUrl, renderer }
             └─ AttachedSession → TerminalView.tsx
                  └─ Terminal.tsx
                       ├─ deviceProfile = detectProfile(clientWidth)
                       ├─ rendererType = webglSupported ? renderer : 'canvas'
                       └─ TerminalView(engine)
                            ├─ ConnectionManager (relay: max10→lost / p2p)
                            └─ ViewportManager (targetCols=80, 防抖, 字号可恢复)

P2P connectionState 变化 (Terminal.tsx effect 观察)
  ├─ reconnecting → view.setExternalBanner('reconnecting', n)
  ├─ connected(曾 reconnecting) → view.setExternalBanner('none') + view.reattach()
  └─ disconnected → useP2PWithFallback 轮换/fallback
```

---

## 10. 测试策略

- **单元(Vitest):**
  - `useAddressProbeCache`:首轮探测、5min 轮询(fake timers)、失败不缓存、陈旧过期、`refreshAgent`。
  - `ConnectionManager`:relay 达上限转 `lost` + 触发 `onDisconnect`;计数封顶。
  - `Renderer`:context-loss 后加载 Canvas addon、`type` 更新。
  - `ViewportManager`:字号变宽恢复、resize 防抖合并。
  - `detectWebGLSupport`、`attachPrefs` renderer 字段读写。
- **组件:**
  - `AttachDialog`:命中显延迟、未命中不阻塞、Renderer 行(可用/不可用)、重新测试。
  - `Terminal`:P2P reconnecting→connected 横幅 + reattach 命令(mock view)。
  - `TerminalView.tsx`:两分支 toolbar 均禁用。
- **Rust:** server `agents.list` 响应含 `addresses` 字段的断言(`crates/nession-server/tests`)。
- **Playwright MCP 截图(必做):** 登录后延迟填充、AttachDialog 延迟 + Renderer 行、P2P 重连横幅、relay lost 横幅、resize 无抖动。
- **门槛:** `cargo test`、`cargo clippy -D warnings`、`cargo fmt --check`;`npm run build`、`npm run lint`(--max-warnings 0)、`npx tsc --noEmit`、`npm test`、coverage ≥ 80%。

---

## 11. 成功标准

**必达(用户确认):**
1. 重连不丢滚动历史(P2P/relay 瞬断不重建 `TerminalView`)。
2. relay 重连达上限显示 "Connection lost" 并触发 `onDisconnect`;无 `attempt N/10`(N>10)。
3. 有/无 fileOps 两分支下重连时 toolbar 均正确禁用。
4. 首帧无字号闪烁、窗口拖拽不抖动。

**其余:**
5. WebGL 能力登录时探测;AttachDialog 按可用性开放渲染器选择;选择持久化并在不可用时自动回退 Canvas。
6. 地址延迟由 per-agent 5min 主动轮询缓存提供,attach 读缓存不现场探测;无缓存不阻塞。
7. WebGL context-loss 后显式回退 Canvas,终端继续可用。
8. 同一 profile 内容器变宽后字号可恢复。

---

## 12. 已知取舍 / 未来可选

- **子行余量(问题 9):** 保持背景色掩盖。根治(整数行高/letterSpacing)有额外验证成本与渲染器初始化竞态风险,当前深色主题下视觉已无缝,收益低,本轮不做。
- **运行时渲染器切换:** 需重建 xterm 实例,本轮通过"重新 attach"绕过。
