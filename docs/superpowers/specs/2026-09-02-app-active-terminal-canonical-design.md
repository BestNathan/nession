# App Active Terminal — Canonical Screen(App 空间体验,390 × 844)

**Date:** 2026-09-02
**Status:** Approved (brainstorming)
**Umbrella:** [#561](https://github.com/BestNathan/nession/issues/561) Phase 2C
**Upstream:** [visual-language.md](../../design/visual-language.md) · [composition.md](../../design/composition.md) · [workspace.md](../../design/workspace.md) · [interaction/app.md](../../design/interaction/app.md) · [terminal-surface.md](../../design/design-system/patterns/terminal-surface.md)(root WIP,2C 落地其核心特性)
**Pattern specs:** [terminal-capsule.md](../../design/design-system/patterns/terminal-capsule.md)
**Branch:** `feat/app-active-terminal-canonical` (base: `origin/staging` — includes merged 2A + 2B + app-spatial + capsule rearchitecture)

---

## Goal

Produce the **App Active Terminal canonical screen** at `390 × 844` and polish the full App spatial experience (Terminal / Workspace / Sessions 三页) on top of the already-merged `AppSpatialShell` + capsule rearchitecture.

Primary design question (from #561):

> Does the mobile composition feel intentionally designed for App rather than a compressed Web layout?

Approved answer: **App is a spatial model, not a responsive shrink.** The 3-page pager (`Sessions ← Terminal → Workspace`) stays; the Terminal page gets a **single-row App header** that replaces the duplicated floating controls; Workspace keeps the **bottom floating pill tool bar** (same capsule family as Web) with real `layout.app` layouts for all three tools; Sessions is a full-width list page. A new `/fixture/app` canonical route renders the whole experience deterministically at 390 × 844.

## App 组合(chrome 去重)

- `AppSpatialShell` 3 页横向 pager + 24px 边缘手势 + 80px commit 保持不动(已批准、已合并)。
- **移除终端页的 44px 浮动按钮**(`showHeaderActions` 不再启用)— 导航由单行头部承担。当前双入口(浮动按钮 × 头部按钮)是压缩 Web 的痕迹,2C 收敛为单一可见导航。
- 会话选择 → `useAppSpatialIndex` 落位 Terminal 页(index 1)语义不变。
- App 所有页面保持 `[data-experience="app"]` 语义类;不使用 `max-lg:` 第二套尺寸 scale 伪装 App。

## Terminal 页

```text
390 × 844 — Terminal 页
┌────────────────────────┐
│ ≡  nession-dev  ·  ☰  │ ← 单行头部(高 48 + 顶部 safe-area)
├────────────────────────┤
│   $ cargo build         │
│   Compiling nession     │  ← 终端 = 唯一亮面,全屏占位
│   Finished 3.2s         │
│   $                     │
│           ▲ ▼ ◼        │  ← TerminalScrollOverlay(App-only,点按)
│  ┌──────────────────┐  │
│  │ ▸ 输入指令…   ⏎  │  │  ← 胶囊:全宽圆角,safe-area 停靠(已有)
│  └──────────────────┘  │
└────────────────────────┘
      ▂▂▂▂▂▂ (Home 条)
```

### 单行头部(AppHeader)

- 一行结构:`[≡]` 会话列表 · **mono 会话名** · 右侧 `[☰]` 工作区。
- `[≡]` 跳 Sessions 页(pager index 0);`[☰]` 跳 Workspace 页(index 2)。tap 目标是 ≥44px 触控目标(token `experience.app.touchTarget.min` 语义)。
- 状态不折叠(`interaction/app.md` must-not 列表):`agent · session` 以 muted 微光片段并入会话名行(与 Web 的 session line 同语言,压缩为单行)。
- 顶部 `env(safe-area-inset-top)` padding;行高走 token,不写死 px。
- Web 的 SurfaceSwitcher 在 App 不渲染(2B 已 gate,保持)。

### 终端主体

- 头部以下、胶囊以上全屏;胶囊停靠时 `--terminal-capsule-clearance` 契约已由 `useCapsuleDockClearance` 发布(已有,保持)。
- **tap-to-focus**(terminal-surface.md 核心特性):点终端任意处 → 聚焦隐藏 IME textarea → 唤起软键盘。这是 App 终端与 Web 终端的体验分界。
- **TerminalScrollOverlay**(App-only):终端内浮动的点按控件 — 页顶 / 页底 / 跳底。Web 滚轮场景不渲染。参考 legacy `MobileTerminalLayout` 的既有实现,不复制双套逻辑。
- 字体/scrollback 用现有 `DeviceProfile.mobile`(10px / 10k scrollback)。

### 胶囊

- 复用 capsule rearchitecture 的 app config:全宽贴边圆角、safe-area 停靠、粘贴/复制/模式切换控件(已有,2C 不重建)。

## Workspace 页

```text
390 × 844 — Workspace 页(files 工具)
┌────────────────────────┐
│ ←  docs/design        │  ← 单行头部:← 返回终端 | 当前工具名
├────────────────────────┤
│  ▸ visual-language.md  │
│  ▸ composition.md      │
│  ▸ workspace.md        │  ← 工具内容(layout.app)
│                        │
│  ┌──────────────────┐  │
│  │  ☰  ▸  ⌘  ≡      │  │  ← 底部浮动 pill 工具条(与 web 同家族)
│  └──────────────────┘  │
└────────────────────────┘
```

- **单行头部变体**:`[←]` 返回终端(顶层导航,回 pager index 1)+ 当前工具名。工具内部 push(如文件编辑器)时,`[←]` 变「返回上一级」— 内部 push/pop 不与顶层手势打架(`interaction/app.md` 要求)。
- **底部浮动 pill 工具条**:与 Web 同一个胶囊家族(2B 定下的视觉语言),App 不换 docked tab bar。
- **三工具补齐 `layout.app`**:
  - `files` — 已有 `filesApp`(tree 全屏 → push 编辑器),2C refine:push 时头部 ← 语义、safe-area、密度。
  - `session` / `agent` — 目前 fallback 到 web 布局,2C 补 app 布局(master/detail 同 files 模式:列表全屏 → push 详情)。
- 工具内容遵循 plugin 契约:`WorkspaceContext.experience` 由真实值驱动(见技术节)。

## Sessions 页(pager index 0)

- 全宽列表:行密度沿用 2A SessionItem(mono 名 + muted 片段 + accent-bar 选中),390px 下不做第二套行式。
- 顶部、底部 safe-area;选择会话 → 回 Terminal 页(现有语义)。
- 列表头部(search/filter/sort)在 App 收敛为**单行**;头部实现走现有 `SessionHeader`/`SessionListHeader` 的 experience 分支,**不新建平行组件树**。

## Fixture — `/fixture/app`

- 新确定性路由,viewport 390 × 844 下渲染完整 App 体验:AppSpatialShell(3 页)+ 单行头部 + filesApp + 静态 xterm(`FixtureTerminal` 复用)+ `fixtureData`/`fixtureFileOps` 复用。
- `FixtureApp.tsx`(新)+ 路由注册;与 2A `/fixture`、2B `/fixture/workspace` 平行。
- e2e spec `fixture-app.spec.ts`:**CI-only**(`test.skip(!process.env.CI)`),断言 renderer-agnostic 选择器 + `testInfo.attach` 截图;本地只用 vite dev 验证。

## 技术落地

- **experience 穿透**:`SessionFirstMain` 目前硬编码 `experience: 'web'` 进 `WorkspaceShell` ctx(line ~146)且不传给终端 — 2C 把 prop 一路穿透到 workspace ctx 与终端相关槽位。
- **无固定 px**:所有尺寸走 token/比例;safe-area 用 `env()`;布局用 grid/flex 比例(如 `grid-cols-[minmax(0,1fr)]` 全宽)。
- **测试目录约束**:Vitest 只认 `__tests__/unit/`(node)与 `__tests__/integration/`(jsdom);jsdom 无视口概念,布局断言走类名/结构,视觉断言走 CI e2e 截图。
- 需要时少量按需 token(`experience.app.*` 语义),不批量为 canonical 造 token(phase 8 的活)。

## 非目标

- 不做 visualViewport 软键盘重排(terminal-surface 的 follow-up;2C 只做 tap-to-focus 入口)。
- 不改 legacy `MobileTerminalLayout` / `SwipeableViewport` / `useSwipeGesture`。
- 不做 `[data-experience=app]` codegen remap(token 阶段再动)。
- 不重设计 pager/边缘手势/胶囊行为 — 全部已批准合并。

## 成功标准

1. 390 × 844 下 Terminal 页:单行头部 + 全屏终端 + 胶囊,safe-area 正确,导航单一可见入口(无重复按钮)。
2. Workspace 页:底部浮动 pill + 三工具均有 `layout.app`;files push 语义正确。
3. Sessions 页:全宽列表,选择回终端。
4. `/fixture/app` 确定性渲染;e2e CI 通过。
5. `experience` prop 全链路生效(workspace ctx 与终端不再硬编码 `'web'`)。
6. 本地 vite dev 截图人工核对(不跑本地 e2e)。
