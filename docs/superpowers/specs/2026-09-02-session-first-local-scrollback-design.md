# Session-first 本地终端历史滚动设计

## 状态

已获用户确认，待实现。

## 背景

session-first 的 terminal.output 已经持续写入 xterm.js。xterm 实例配置了浏览器端 scrollback，因此历史内容可以直接保存在浏览器的 xterm buffer 中，不需要再次从 tmux 获取，也不需要通过 tmux copy mode 浏览历史。

当前胶囊避让逻辑把底部 inset 永久应用到 TerminalViewport。这能让实时底部内容停在胶囊上方，但历史滚动时终端仍然被永久缩短，无法自然滑到胶囊下面。同时，终端如果启用了鼠标报告，wheel 事件可能被编码后发送到 tmux，导致滚动进入 tmux copy mode。

## 目标

- session-first 使用 xterm browser buffer 承载和浏览历史输出。
- session-first 的垂直 wheel/touch 历史滚动不发送 tmux 鼠标控制序列。
- 实时跟随底部时，最新内容和输入提示显示在胶囊上方。
- 浏览历史时，terminal 使用完整高度，内容可以进入胶囊下方；胶囊保持浮层覆盖关系。
- 新输出到达历史模式时不打断用户当前浏览位置。
- 回到底部或点击“最新输出”后，恢复胶囊避让并重新跟随最新输出。
- legacy 继续使用现有滚动和 tmux copy mode 行为，不受本改造影响。

## 非目标

- 不修改 WebSocket 的 terminal.output 协议和传输时序。
- 不修改 tmux 的 scrollback 或 copy mode 实现。
- 不改变 legacy 终端的鼠标、选择、滚动行为。
- 不在浏览器和 tmux 之间同步两套历史视图。

## 方案选择

### 方案 A：按终端模式启用本地 buffer 滚动（推荐）

为 TerminalController 增加显式的终端行为配置，例如 `scrollbackMode: 'local-buffer' | 'legacy'`。session-first 传入 `local-buffer`，legacy 传入 `legacy`。

local-buffer 模式由一个本地滚动控制器同时负责两件事：

1. 拦截 session-first 终端区域的垂直 wheel/touch 滚动，阻止 xterm 将事件转发到 PTY/tmux，并直接调用 xterm 的 `scrollLines` 或 `scrollPages`。
2. 管理胶囊避让状态，在 `following` 和 `history` 之间切换底部 inset。

优点是行为边界明确、browser buffer 是唯一历史来源、不会改变 legacy；缺点是需要处理触摸手势、程序化滚动和 resize 的时序。

### 方案 B：session-first 全局关闭 tmux 鼠标模式

通过终端控制序列或 tmux 配置关闭 mouse reporting，再完全依赖 xterm 本地滚动。

该方案会破坏 vim、htop 等程序的鼠标交互，并且会改变远端 session 的状态，不采用。

### 方案 C：历史模式重新从 tmux capture 输出

滚动历史时从服务端请求 tmux capture-pane，再写入独立的历史终端或临时视图。

该方案需要维护第二套输出、ANSI 状态和滚动位置，容易产生刷新跳动，也违背“内容原生保存在浏览器 buffer”的目标，不采用。

## 交互设计

### 状态

| 状态 | 底部 inset | terminal.output | 用户滚动 |
| --- | --- | --- | --- |
| `following` | 胶囊实际遮挡高度 | 输出后继续跟随底部 | 向上滚动进入 `history` |
| `history` | `0px` | 继续写入 buffer，但不改变 viewport | 向下到真实底部后进入 `following` |

状态由本地滚动控制器持有，不放到服务器或 tmux。状态切换需要区分用户滚动和控制器自身的 `scrollToBottom`，避免程序化滚动被误判为历史浏览。

### 胶囊浮层

胶囊保持绝对定位和高于 terminal 的 z-index。

- `following`：TerminalViewport 使用 `--terminal-capsule-occlusion` 作为 `--terminal-content-bottom-inset`，底部内容停在胶囊上方；底部背景带只负责填充视觉间隙。
- `history`：`--terminal-content-bottom-inset` 为 `0px`，底部背景带隐藏或高度为零，xterm 内容可进入胶囊覆盖区域。

不使用 `scrollLines(-margin)` 模拟避让，因为它只改变 buffer viewport，不能表达“浮层覆盖 terminal”的布局状态。

### 输入和滚动事件

- session-first 的垂直 wheel 事件在 xterm 事件处理前被捕获，转换成 xterm 本地滚动，并阻止继续传播到 PTY。
- touch 滑动采用同一套本地滚动策略；无法计算有效位移时不发送伪造输入。
- 移动端已有的 page-up、page-down、latest-output 控件直接调用本地 xterm 滚动 API。
- 文本选择是独立策略：session-first 默认保留浏览器/xterm 本地选择；legacy 保留当前 tmux-native selection/copy mode 行为。

### 输出和重连

- `following` 状态下，terminal.output 写入完成后重新确认 xterm 位于真实底部。
- `history` 状态下，terminal.output 只增加 xterm buffer，不调用自动滚底。
- detach/reattach 保留同一个 TerminalInstance 和 buffer；重新绑定控制器时从 xterm 的真实 viewport 位置恢复 `following/history`，不依赖旧 DOM 状态。
- capsule 尺寸变化时只更新当前几何量；`following` 立即重新对齐，`history` 不强制移动用户位置。

## 架构边界

- `TerminalInstance`：继续拥有 xterm 和 browser buffer，不负责判断 session-first/legacy。
- `TerminalController`：根据显式模式选择本地滚动控制器或 legacy 路径，并把 output、resize、scroll-to-bottom 接到控制器。
- `CapsuleOcclusionScroll` 或其重构后的本地滚动控制器：负责 following/history 状态、胶囊 inset、用户滚动检测和事件生命周期。
- `TerminalViewport`：只消费动态的 content bottom inset，不知道 tmux 细节。
- session-first terminal surface：声明或传递 local-buffer 模式。
- legacy terminal surface：不启用新的本地滚动和动态胶囊避让行为。

## 边界条件和错误处理

- xterm 尚未完成 layout 时，滚动操作使用 xterm API 的安全 no-op 路径，不发送 PTY 输入。
- scrollback 不足以滚动时，wheel 事件不产生 viewport 位移；不进入 copy mode。
- 计算胶囊高度失败时使用 `0px`，并保持 terminal 可用。
- 控制器 dispose 时移除所有 capture listener、ResizeObserver、xterm listener 和待执行的 animation frame。
- 动态 inset 切换期间使用一次布局同步和一次 frame 级重新对齐，避免出现永久黑屏、跳回底部或内容被错误锁死。

## 测试计划

### 单元测试

- `following/history` 状态转换和真实底部判定。
- history 模式收到 output 后 viewport 不变。
- following 模式收到 output 后回到真实底部。
- capsule 几何变化只在 following 模式触发对齐。
- wheel 事件在 local-buffer 模式调用 xterm scroll API，并阻止传播。
- legacy 模式不安装本地 wheel 拦截器。

### 集成测试

- session-first host 在两种状态下切换 content bottom inset。
- session-first 回到底部后内容位于胶囊上方。
- session-first 上滚后内容可以位于胶囊下方。
- detach/reattach 后 browser buffer 和滚动状态不丢失。
- legacy TerminalLayout 的现有滚动和 copy mode 相关行为保持不变。

### 验证

- 运行相关 Vitest 集成测试。
- 运行完整测试集、TypeScript/build 和 `git diff --check`。
- 手工验证：实时输出、鼠标 wheel、触摸滑动、移动端按钮、刷新、reattach、session 切换，以及 legacy 对照路径。
