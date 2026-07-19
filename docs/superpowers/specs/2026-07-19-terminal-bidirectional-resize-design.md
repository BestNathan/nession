# Design: Terminal Bidirectional Resize — tmux as Source of Truth

**Date:** 2026-07-19
**Status:** Draft
**Supersedes:** `2026-07-18-terminal-architecture-restructure-design.md` (over-engineered — ScalingManager, CSS transform, device detection, zoom toolbar removed)

---

## 1. Overview

**Core change:** The client drives tmux window size on attach and on browser resize. tmux confirms via `%window-resize` events, which broadcast to all attached clients. xterm.js is a pure renderer — it never calculates terminal dimensions from viewport size.

**Key principles:**

1. **Bidirectional** — client → tmux on attach/resize, tmux → all clients on confirm
2. **xterm.js is a renderer only** — no FitAddon, no viewport-fit calculation
3. **Last-write-wins** for multi-client — no arbitration, no minimum/maximum logic
4. **FontSizeManager stays** — font-based zoom is a user preference, not a layout concern

**Explicitly out of scope:**
- CSS transform scaling / device auto-detection / ScalingManager
- Zoom toolbar buttons (+/-/reset)
- Multi-client sizing arbitration
- Cross-device adaptation strategies

## 2. Data Flow

### 2.1 Client → tmux (new)

```
Browser window resize
  ↓ ResizeObserver fires (container pixel dimensions)
Calculate cols = floor(containerWidth / cellWidth)
Calculate rows = floor(containerHeight / cellHeight)
  ↓ Optimistic: term.resize(cols, rows)  ← no flicker
  ↓ WebSocket: terminal.resize {cols, rows}
Agent receives message
  ↓ tmux resize-window -x {cols} -y {rows}
  ↓ tmux confirms: %window-resize @window cols rows
Agent broadcasts to all clients (P2P + relay)
```

### 2.2 tmux → Client (existing, relay gap to fix)

```
tmux emits %window-resize @window cols rows
  ↓ Agent parses event → resize channel → WebSocket broadcast
P2P clients: terminal.resize message  ← already works
Relay clients: Server broker forwards  ← NOT YET IMPLEMENTED
  ↓ Client receives: ConnectionManager.onResize(cols, rows)
TerminalSizeManager.handleResize(cols, rows)
  ↓ term.resize(cols, rows) + mountElement CSS update
```

### 2.3 Attach flow (updated)

```
Client.attach
  ↓ 1. ResizeObserver measures container → cols, rows
  ↓ 2. Send terminal.resize {cols, rows} to agent
  ↓ 3. Agent: tmux resize-window -x {cols} -y {rows}
  ↓ 4. Agent: tmux attach-session (returns initial %output)
  ↓ 5. Agent broadcasts terminal.resize to all clients
Terminal receives initial ANSI output at correct size
```

## 3. Changes

### 3.1 Agent: `ControlModeSession::resize()` — from no-op to real resize

**File:** `crates/nession-agent/src/tmux/control.rs`

Current code is a no-op:
```rust
pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
    self.viewport = (width, height);
    Ok(())
}
```

Change to execute actual tmux resize:
```rust
pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
    self.viewport = (width, height);
    let cmd = format!("resize-window -t {} -x {} -y {}\n", self.session_name, width, height);
    self.stdin.write_all(cmd.as_bytes()).await?;
    self.stdin.flush().await?;
    Ok(())
}
```

### 3.2 Agent: Remove pane size lock

**File:** `crates/nession-agent/src/tmux/manager.rs`

Remove or disable the `window-size manual` lock so tmux accepts our resize-window commands.

### 3.3 Agent: Attach-time resize

**File:** `crates/nession-agent/src/server/websocket.rs`

In the client.attach handler, after querying the initial window size but before the first output flush, send the client's reported cols/rows as a `resize-window` command. The existing initial-resize logic (lines 961-977) already queries tmux size — we extend it to push the client's size to tmux first.

### 3.4 Server: Relay-mode resize broadcast

**File:** `crates/nession-server/src/broker.rs`

Add handling for `agent.terminal.resize`:
```
agent.terminal.resize payload → broadcast terminal.resize to all relay clients attached to that session
```

This is the only missing piece for relay mode to work end-to-end.

### 3.5 Web: ResizeObserver → send resize to agent

**File:** `web/src/components/Terminal.tsx`

Add a ResizeObserver on the terminal container:

```typescript
// In Terminal.tsx useEffect, after TerminalView is created:
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    // Calculate cols/rows from pixel dimensions
    const cellWidth = /* from xterm internals or FontSizeManager */;
    const cellHeight = /* from xterm internals or FontSizeManager */;
    const cols = Math.floor(width / cellWidth);
    const rows = Math.floor(height / cellHeight);
    // Send to agent via ConnectionManager
    viewRef.current?.sendResize(cols, rows);
  }
});
resizeObserver.observe(containerRef.current);
```

### 3.6 Web: `ConnectionManager.sendResize()`

**File:** `web/src/terminal/ConnectionManager.ts`

Add method to send resize to agent (both P2P and relay):

```typescript
sendResize(cols: number, rows: number): void {
  if (this.disposed) return;
  if (this.mode === 'p2p' && this.p2pConnection) {
    this.p2pConnection.sendMessage({
      msg_type: 'terminal.resize',
      id: generateId(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: { cols, rows },
    });
  } else if (this.mode === 'relay' && this.serverConnection) {
    this.serverConnection.sendTerminalResize(this.sessionId, cols, rows);
  }
}
```

### 3.7 Web: `TerminalView.sendResize()`

**File:** `web/src/terminal/TerminalView.ts`

Expose `sendResize` method that delegates to ConnectionManager. Include a getter for cell dimensions so ResizeObserver can calculate cols/rows.

## 4. What Stays

| Component | Fate |
|-----------|------|
| TerminalSizeManager | Keep — handles `handleResize(cols, rows)` from tmux events |
| FontSizeManager | Keep — font-based zoom, user preference |
| ConnectionManager | Extend — add `sendResize()` |
| InputManager, Renderer, ThemeManager | Unchanged |
| Catppuccin Mocha theme | Unchanged |
| P2P resize broadcast | Already works |
| Agent control mode parsing | Already works |

## 5. What Goes

| Component | Fate |
|-----------|------|
| ScalingManager | Never built — out of scope |
| CSS transform wrapper | Never built — out of scope |
| Zoom toolbar buttons | Never built — out of scope |
| Device detection profiles | Never built — out of scope |
| `window-size manual` tmux lock | Remove — blocks client-driven resize |

## 6. Multi-Client Behavior

Scenario: Client A (desktop, 200×60) and Client B (phone, 80×24) attached to same session.

1. Client B resizes browser → sends `terminal.resize {cols:100, rows:30}`
2. Agent: `tmux resize-window -x 100 -y 30`
3. tmux confirms `%window-resize @1 100 30`
4. Agent broadcasts to all clients
5. Client A: `term.resize(100, 30)` — desktop terminal shrinks
6. Client B: `term.resize(100, 30)` — matches

Last writer wins. No minimum, no maximum, no negotiation.

## 7. Testing Strategy

### Unit tests
- `ControlModeSession::resize()` sends correct `resize-window` command
- `ConnectionManager.sendResize()` sends correct message in both modes
- ResizeObserver callback calculates cols/rows correctly

### Integration tests
- Full flow: ResizeObserver → sendResize → agent resize-window → %window-resize → broadcast → term.resize
- Attach flow: client reports size → tmux resized before attach

### Manual verification
- Desktop browser: resize window → tmux pane follows
- Two browser windows: resize one → other follows
- Mobile Safari: rotation → tmux resizes

## 8. Migration

**Single phase** — all changes are small and self-contained:

1. Agent `resize()` from no-op to real (1 file, ~5 lines changed)
2. Remove `window-size manual` lock (1 file, ~3 lines removed)
3. Server broker relay broadcast (1 file, ~20 lines added)
4. Web ResizeObserver + sendResize (3 files, ~40 lines added)
5. Attach-time resize (1 file, ~10 lines added)

**Estimated:** 1-2 days

---

**Document Status:** Draft — awaiting user review
