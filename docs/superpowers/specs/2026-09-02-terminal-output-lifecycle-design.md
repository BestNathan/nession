# Terminal Output Lifecycle Reliability Design

**Date:** 2026-09-02

## Goal

保证 session-first terminal 在 React 18 StrictMode、viewport 重挂载和 P2P/relay attach 状态变化下，持续拥有可用的 xterm 实例和 `terminal.output` 消费者；修复“WebSocket 已收到 terminal.output，但 xterm 无内容”的问题。

## Scope

- 修复 `useTerminal` 对 `TerminalController` / xterm 的生命周期管理。
- 修复 session-first attach hook 的类型契约，使 attach timeout 的状态 updater 合法且可编译。
- 增加 StrictMode 生命周期和输出转发回归测试。
- 保持现有 P2P/relay 协议格式、WebSocket 编解码逻辑和 capsule UI 行为不变。

## Root Cause

`main.tsx` 使用 React.StrictMode。当前 `useTerminal` 的空依赖 effect cleanup 在 StrictMode 的开发期模拟卸载中调用 `controller.dispose()`。`dispose()` 会永久销毁 `TerminalInstance` 内部的 xterm；随后 StrictMode 第二次运行挂载 effect 时，`TerminalInstance.attach()` 和 `TerminalController.attach()` 都拒绝已销毁实例。因此旧 transport 的订阅被清除，新的 xterm/transport output handler 无法建立，而底层 WebSocket 仍可继续收到 `terminal.output`。

当前 worktree 还存在一个独立的 TypeScript 错误：attach timeout 使用函数 updater 更新 `terminalSessionStateAtom`，但传入 `P2pAttachCtx` 的 setter 类型只接受 `TerminalStatus` 值。

## Design

### 1. Controller lifetime

`TerminalController` 继续作为当前 session 的稳定对象，viewport 的 `detach()` 只移除 xterm DOM 和 transport 绑定，不销毁 xterm 实例。`useTerminal` 通过一个 controller ref 管理对象身份：

- effect setup 将当前 controller 标记为 active；
- effect cleanup 不立即 dispose，而是排入 microtask；
- 如果 StrictMode 随即重新 setup，microtask 发现同一个 controller 仍 active，则取消 dispose；
- 如果是真实卸载，或 controller 已被新 session 替换，则旧 controller 才会 dispose；
- session/controller 替换时，旧实例只 dispose 一次。

这样既保留 StrictMode 下的开发体验，也不把真实卸载造成的资源泄漏留给调用方。

### 2. Transport and attach boundary

保留现有 transport-first 顺序：

```text
TerminalViewport attach
  -> TerminalController creates xterm + ConnectionManager
  -> output handler is wired
  -> terminalTransportReadyAtom = true
  -> session-first attach sends client.attach / beginRelay
  -> terminal.output -> ConnectionManager -> terminal.write
```

不改变 `terminal.output` 的 payload 或 base64 语义。`ConnectionManager` 继续负责 P2P 输出解码和 relay 输出订阅；生命周期测试只验证 output handler 在 StrictMode 重挂载后仍存在。

### 3. Type contract

将 session-first attach context 的 `setTerminalState` 类型改为支持 React/Jotai 的 `SetStateAction<TerminalStatus>`，使 timeout 的 `prev => ...` updater 与实际 setter 一致，不改变状态机转移规则。

## Error handling

- 已销毁的 xterm 不允许重新 attach；生命周期逻辑必须确保正常流程不会到达该状态。
- 旧 controller 替换时清理 transport、ResizeObserver、输入处理器和 xterm。
- 不新增协议重试或吞错逻辑；attach/reconnect 现有行为保持不变。

## Testing

- 新增 `useTerminal` 的 StrictMode 回归测试：模拟 effect replay 后 controller 不被 dispose，且仍可 attach。
- 保留并运行现有 TerminalController output forwarding 测试。
- 运行 session-first attach 测试，覆盖 attach timeout updater 和 transport-ready 顺序。
- 验证 `npx tsc --noEmit`、相关 Vitest 测试、完整 web 测试、`npm run build` 和 `git diff --check`。

## Non-goals

- 不修改 Rust agent/server 协议。
- 不重写 WebSocketService 或 EventPlugin。
- 不关闭 React.StrictMode。
- 不重构 capsule occlusion 的滚动算法。
