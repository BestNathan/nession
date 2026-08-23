# Design Spec: Terminal Session State Machine

## Overview

Replace `ConnectionManager`'s private flags (`p2pAttachSent`, `relayInitiallyAttached`, `reconnectAttempt`) and the scattered React effect logic with a single Jotai atom state machine. `ConnectionManager` becomes a pure transport layer — it sends/receives messages and manages socket lifecycle, but does not make protocol decisions.

**Requirements:** none (engineering refactor)

## Architecture

```
┌─ atoms/terminal.ts ────────────────────────────────────────┐
│ terminalSessionStateAtom: 'idle' | 'connecting' | 'connected'│
│                           | 'attached' | 'reconnecting' | 'failed' │
│ lastResizeAtom: {cols, rows} | null                         │
└────────────────────────────────────────────────────────────┘
         │ 写入（状态机 effect）     │ 读取（组件订阅）
         ▼                           ▼
┌─ Terminal.tsx ────────────┐  ┌─ TerminalView.tsx ──────────┐
│ effect: 状态机核心逻辑      │  │ 读取 state + lastResize       │
│ 订阅 p2pState + atom      │  │ 传给 Terminal                │
│ 驱动状态转换               │  │                              │
│ create/destroy CM          │  └─────────────────────────────┘
└───────────────────────────┘
         │ 创建 / 销毁
         ▼
┌─ ConnectionManager ─────────────────────────────────────────┐
│ 【纯传输】                                                    │
│ send(data) → terminal.input                                 │
│ sendResize(cols,rows) → terminal.resize                     │
│ onMessage(handler) ← terminal.output / error / ...          │
│ connect() / close()                                         │
│ 不再有: p2pAttachSent, relayInitiallyAttached, reattach()   │
└─────────────────────────────────────────────────────────────┘
```

## State Machine

```
                    ┌──────────┐
        disconnect  │          │  select session
      ┌────────────►│   idle   │◄──────────────┐
      │             │          │               │
      │             └────┬─────┘               │
      │                  │ socket created       │
      │                  ▼                      │
      │             ┌──────────┐               │
      │             │connecting│               │
      │             │          │               │
      │             └────┬─────┘               │
      │                  │ ws.onopen            │
      │                  │ / relay.auth         │
      │                  ▼                      │
      │             ┌──────────┐               │
      │   timeout   │connected │               │
      │   (10s)     │          │               │
      │             └────┬─────┘               │
      │                  │ client.attach ok     │
      │                  │ / beginRelay sent    │
      │                  ▼                      │
      │             ┌──────────┐               │
      │             │ attached │               │
      │             │          │               │
      │             └────┬─────┘               │
      │                  │ socket drop          │
      │                  ▼                      │
      │             ┌──────────────┐           │
      │             │ reconnecting │           │
      │             │              │───────────┘
      │             └──────┬───────┘  retry
      │                    │ max retries
      │                    ▼
      │             ┌──────────┐
      └─────────────│  failed  │──► idle (manual)
                    └──────────┘
```

### State Transition Table

| 当前状态 | 事件 | 新状态 | 动作 |
|---------|------|--------|------|
| idle | socket created (attachToSession) | connecting | subscribe onMessage, start keepalive |
| connecting | ws.onopen / relay.authenticated | connected | — |
| connected | client.attach sent + ok received | attached | flush buffered input queue |
| connected | attach timeout (10s, no ok) | reconnecting | close socket, start retry timer |
| connected | agent error (session not found) | failed | close socket, show error |
| connecting | timeout (15s, no onopen) | reconnecting | close socket, start retry timer |
| attached | ws.onclose / relay disconnect | reconnecting | show banner, start retry timer |
| reconnecting | retry timer fires | connecting | create new socket |
| reconnecting | max retries exceeded | failed | close socket |
| failed | user manually retries | connecting | create new socket |
| any | disconnectAtom / attachToSessionAtom | idle | close socket, stop keepalive, reset all |
| any (relay) | relay status 'authenticated' | connected | — |

## Edge Cases

### 1. Input buffering (connected → attached)
User keystrokes in `connected` state are queued. On transition to `attached`, the queue is flushed. This eliminates the `not_attached` race entirely — no user input reaches the agent before `client.attach` is acknowledged.

### 2. Resize buffering (connected → attached)
`terminal.resize` is gated on `terminalSessionStateAtom === 'attached'`, matching input. While the transport is up but client.attach has not yet been acknowledged (`connected`, `reconnecting`), resize events are **coalesced** — only the latest `{cols, rows}` survives, stored in `ConnectionManager.pendingResize`. The single coalesced value is flushed as one `terminal.resize` by `flushAllOutbound` once the agent acks attach. This prevents the `not_attached` error the agent would otherwise return for a resize that arrives before its per-connection session map has an entry — a race easily triggered on mobile by viewport churn during attach/reconnect (virtual keyboard, input panel, rotation). Initial PTY size still rides on `client.attach` `width`/`height` from `lastResizeAtom`; the post-attach flush only covers viewport changes during the `connected` window.

### 3. Attach error (agent-side)
If `client.attach` receives `{ msg_type: "error" }` instead of `ok`, the session doesn't exist on the agent. This is unrecoverable by retry — transition directly to `failed`.

### 4. Relay mode
`onConnectionChange('authenticated')` → `connected`. `beginRelay()` is fire-and-forget — transition to `attached` immediately after sending (no ok needed).

### 5. StrictMode double-mount
The state machine atom is global (not per-component React state). Mount→unmount→mount under StrictMode does not reset state.

### 6. P2P address switch
`attached → idle → connecting(new) → ...`. Full disconnect then reconnect on new address. State machine transitions naturally.

### 7. Session switch (terminal-internal)
`attached → idle → [AttachDialog confirm] → connecting(new session)`. Idle state cleans up old socket, keepalive, and subscription.

### 8. File operations gate
`file.list` is sent by `createFileOps` when `p2pConnection` object exists. File operations now gate on `attached` state — no file I/O before the terminal channel is bound.

### 9. lastResize persistence
`lastResize` (PTY dimensions) must survive `ConnectionManager` rebuilds (idle → connecting creates a new CM instance). Stored in `lastResizeAtom`, passed to CM constructor.

### 10. Keepalive lifecycle
Started in `connecting`, stopped in `idle`/`failed`. Same lifecycle as the socket.

## Protocol Interaction (unchanged)

All protocol messages and their formats remain identical. Only the timing of sends changes:

| Message | Sent when | Previous behavior |
|---------|-----------|-------------------|
| `client.attach` | connected → (wait for ok) → attached | sent from 50ms timer or React effect (race) |
| `terminal.input` | attached (buffered if connected) | sent immediately (not_attached race) |
| `terminal.resize` | any non-idle state | sent immediately |
| `client.session.relay.begin` | connected → attached (fire-and-forget) | sent from 50ms timer |

## Deleted from ConnectionManager

| Item | Reason |
|------|--------|
| `p2pAttachSent` flag | Replaced by state machine (`attached` = sent + acked) |
| `relayInitiallyAttached` flag | Replaced by state machine |
| `reconnectAttempt` counter | Moved to Terminal.tsx effect |
| `relayLost` flag | Replaced by `failed` state |
| `attach()` method | State machine effect calls send directly |
| `attachP2P()` method | State machine effect calls send directly |
| `reattach()` method | Replaced by `attached → reconnecting → connecting → connected → attached` cycle |
| `isP2P` getter | TMView 50ms timer no longer needs to branch |

## New Atom

```ts
// atoms/terminal.ts
export const terminalSessionStateAtom = atom<
  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
>('idle');

export const lastResizeAtom = atom<{ cols: number; rows: number } | null>(null);
```

## Component Changes

### Terminal.tsx — state machine effect (replaces p2pState observer)

One effect that reads `terminalSessionStateAtom`, `p2pStateAtom`, and `p2pMessageAtom` (to watch for `ok`/`error` responses), and drives all state transitions.

### TerminalView.ts (class) — remove timer, remove attach call

The 50ms `setTimeout` that called `this.connection.attach()` is deleted. `ResizeObserver` already sends `terminal.resize` directly. The class only handles DOM + xterm.js initialization.

### ConnectionManager — remove state flags and protocol methods

Only retains:
- `send(data)` / `sendResize(cols, rows)`
- `onMessage(handler)` callback registration
- `close()` socket teardown
- Keepalive ping timer
- `onStateChange` / `onOutput` / `onError` / `onDisconnect` / `onResize` callbacks

## Testing

- State machine transitions: unit test the effect logic with mocked p2pConnection
- Input buffering: verify queued input is flushed on `attached`
- Attach timeout: verify `connected → reconnecting` after 10s without ok
- Attach error: verify `connected → failed` on agent error
- Reconnect: verify `attached → reconnecting → connecting → connected → attached` cycle

## Rollback Safety

Atom values are session-scoped (cleared on disconnect). `ConnectionManager` interface changes are backward-compatible at the protocol level — no server/agent changes needed.
