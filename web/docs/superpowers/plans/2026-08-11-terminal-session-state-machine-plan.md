# Terminal Session State Machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ConnectionManager's private flags and the scattered React effect with a single Jotai atom state machine. ConnectionManager becomes pure transport.

**Architecture:** A `terminalSessionStateAtom` (6 states: idle → connecting → connected → attached → reconnecting → failed) drives all protocol decisions. Terminal.tsx runs the state machine in a single effect. ConnectionManager is stripped of `p2pAttachSent`, `relayInitiallyAttached`, `attach()`, `attachP2P()`, `reattach()`, and `isP2P`.

**Tech Stack:** Jotai 2.x, React 18, TypeScript 5.x, xterm.js, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `web/src/atoms/terminal.ts` | modify | add `terminalSessionStateAtom`, `lastResizeAtom` |
| `web/src/components/Terminal.tsx` | modify | state machine effect replaces p2pState observer |
| `web/src/terminal/ConnectionManager.ts` | modify | strip state flags + protocol methods → pure transport |
| `web/src/terminal/TerminalView.ts` | modify | remove 50ms timer attach logic |
| `web/src/terminal/types.ts` | modify | remove unused fields from interface if any |

---

### Task 1: Add state machine atoms to atoms/terminal.ts

**Files:**
- Modify: `web/src/atoms/terminal.ts`

- [ ] **Step 1: Add the two new atoms**

Add after existing base atoms:

```typescript
// ── Terminal session state machine ─────────────────────────────

/**
 * Drives all protocol decisions for a terminal session.
 *
 *   idle → connecting    socket created (attachToSessionAtom)
 *   connecting → connected   ws.onopen / relay authenticated
 *   connected → attached     client.attach ok received / relay beginRelay sent
 *   connected → reconnecting attach timeout (10s) / error
 *   connected → failed    agent error (session not found)
 *   attached → reconnecting   socket drop
 *   reconnecting → connecting retry timer fires
 *   reconnecting → failed max retries exceeded
 *   failed → connecting    user manually retries
 *   any → idle         disconnect / session switch
 */
export const terminalSessionStateAtom = atom<
  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
>('idle');

/** Keeps PTY size across ConnectionManager rebuilds. */
export const lastResizeAtom = atom<{ cols: number; rows: number } | null>(null);
```

- [ ] **Step 2: Verify atom tests still pass**

```bash
cd web && npx vitest run src/atoms/__tests__/terminal.test.ts
```
Expected: all pass

- [ ] **Step 2b: Update disconnectAtom and attachToSessionAtom to reset state machine**

In `disconnectAtom`, add `set(terminalSessionStateAtom, 'idle')` to reset the state machine on disconnect.

In `attachToSessionAtom`, add `set(terminalSessionStateAtom, 'connecting')` — the state machine starts when the session is selected.

- [ ] **Step 3: Commit**

```bash
git add web/src/atoms/terminal.ts
git commit -m "feat: add terminalSessionStateAtom + lastResizeAtom

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Strip ConnectionManager to pure transport

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts`

- [ ] **Step 1: Remove state flags**

Delete these private fields:
- `p2pAttachSent`
- `relayInitiallyAttached`
- `reconnectAttempt` (the counter)
- `relayLost`

- [ ] **Step 2: Remove protocol methods**

Delete these methods:
- `attach()` (line 153-182)
- `attachP2P()` (line 123-151)
- `reattach()` (line 185-188)
- `isP2P` getter (line 38)
- `setState()` (line 301-308) — inline `onStateChange` calls directly

- [ ] **Step 3: Remove relay reconnect logic from setupRelay**

The `onConnectionChange` handler currently has reconnect and attach logic. Remove:

```typescript
// REMOVE from setupRelay():
// - relayInitiallyAttached reset
// - reconnectAttempt counter
// - relayLost flag
// - this.setState() calls
// - this.attach() call on 'authenticated'

// KEEP:
// - onTerminalOutput / onTerminalResize subscriptions
// - onConnectionChange for notifying React layer
```

Replace with:

```typescript
this.relayUnsubState = svc.onConnectionChange((status) => {
  if (this.disposed) { return; }
  if (status === 'authenticated') {
    this.onStateChange?.('connected', 0);
  } else if (status === 'disconnected') {
    this.onStateChange?.('lost', 0);
  }
});
```

- [ ] **Step 4: Make send/data-sending unconditional**

Currently `send()` checks `connectionState === 'connected'`. This guard moves to the React layer (state machine only sends in `attached`). But for backward compat, keep the guard — just simplify:

```typescript
send(data: string): void {
  if (this.disposed) { return; }
  if (this.mode === 'p2p' && this.p2pConnection) {
    this.p2pConnection.sendMessage({
      msg_type: 'terminal.input',
      id: generateId(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: { session_name: this.sessionName, data: encodeB64(data) },
    });
  } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
    this.serverConnection.sendRelayInput(this.sessionName, data);
  }
}
```

(Remove the `connectionState === 'connected'` check — the React layer gates sending.)

- [ ] **Step 5: Keep transport-only setupP2P**

`setupP2P()` keeps:
- `conn.onMessage()` subscription (terminal.output, terminal.resize, ok, error, keepalive.pong)
- Keepalive ping timer

Remove: the comment about "Attach is driven by the React layer" (no longer relevant since there's no attach at all here).

- [ ] **Step 6: Add public methods for socket lifecycle**

Add `connect()` for clarity (currently done in constructor, but make it explicit):

```typescript
/** Called by the React state machine to reconnect. Creates a fresh socket. */
connect(connection: ConnectionOptions['p2pConnection']): void {
  this.p2pConnection = connection;
  this.setupP2P();
}
```

Actually, the constructor already handles this. No new method needed — the React layer destroys and recreates ConnectionManager for each connection.

- [ ] **Step 7: Verify tests**

```bash
cd web && npx vitest run src/terminal/__tests__/ConnectionManager.attach.test.ts src/terminal/__tests__/ConnectionManager.test.ts
```
Expected: attach tests will fail (attach method removed). Update them to test new transport-only behavior.

- [ ] **Step 8: Run lint + tsc**

```bash
cd web && npx eslint src/terminal/ConnectionManager.ts --max-warnings 0 && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts web/src/terminal/__tests__/
git commit -m "refactor: strip ConnectionManager to pure transport

Remove p2pAttachSent, relayInitiallyAttached, attach(), attachP2P(),
reattach(), isP2P. ConnectionManager no longer makes protocol
decisions — the state machine (Task 4) drives client.attach timing.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Remove 50ms timer from TerminalView.ts

**Files:**
- Modify: `web/src/terminal/TerminalView.ts`

- [ ] **Step 1: Delete the attach timer**

Remove lines 216-225:

```typescript
// REMOVE:
// this.attachTimer = setTimeout(() => { ... }, 50);
```

Also remove the `attachTimer` field declaration (line 52).

Also update `dispose()` to not reference `attachTimer`:

```typescript
dispose(): void {
  this.isDisposed = true;
  // REMOVE: if (this.attachTimer) { clearTimeout(this.attachTimer); ... }
  this.mobileInput?.dispose();
  this.mouseIntent.dispose();
  this.input.dispose();
  this.size.dispose();
  this.connection.dispose();
  this.terminal.dispose();
}
```

- [ ] **Step 2: Update dispose()**

Remove the `attachTimer` cleanup lines from `dispose()`.

- [ ] **Step 3: Verify**

```bash
cd web && npx tsc --noEmit && npx eslint src/terminal/TerminalView.ts --max-warnings 0
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web/src/terminal/TerminalView.ts
git commit -m "refactor: remove 50ms attach timer from TerminalView

ResizeObserver already sends terminal.resize directly.
State machine (Task 4) drives client.attach timing.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Implement state machine effect in Terminal.tsx

**Files:**
- Modify: `web/src/components/Terminal.tsx`

**This is the core task.** The current `p2pState` observer effect (lines 82-112) is replaced with a state machine effect that drives all transitions.

- [ ] **Step 1: Read current Terminal.tsx to understand existing code**

Read the full file at `web/src/components/Terminal.tsx`. Note the two effects: p2pState observer (82-112) and TerminalView creation (115-180).

- [ ] **Step 2: Add imports**

```typescript
import { useAtom, useSetAtom } from 'jotai';
import {
  sessionIdAtom, sessionNameAtom, effectiveModeAtom, p2pConnectionAtom,
  terminalSessionStateAtom, lastResizeAtom,
} from '../atoms/terminal';
```

- [ ] **Step 3: Add atom reads**

```typescript
const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
const [lastResize] = useAtom(lastResizeAtom);
const setLastResize = useSetAtom(lastResizeAtom);
```

- [ ] **Step 4: Replace p2pState observer effect with state machine effect**

Remove the current p2pState observer (lines 82-112). Add the state machine effect:

```typescript
// ── State machine effect ───────────────────────────────────────
// Drives all terminal session protocol: attach, reconnect, input
// buffering.  Replaces the old p2pState observer + ConnectionManager
// attach/reattach methods.

const P2P_MAX_RECONNECT = 10;
const ATTACH_TIMEOUT_MS = 10_000;

const bufferedInputRef = useRef<string[]>([]);
const reconnectCountRef = useRef(0);
const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(() => {
  if (mode !== 'p2p') { return; }
  const view = viewRef.current;

  switch (terminalState) {
    case 'idle':
      // Nothing to do — waiting for socket creation.
      break;

    case 'connecting':
      // Socket is being created by useP2PConnection.
      // Clear any stale state from a previous session.
      bufferedInputRef.current = [];
      break;

    case 'connected': {
      // Socket is open.  Send client.attach and wait for agent ok.
      const conn = p2pConnection!;
      const w = lastResize?.cols;
      const h = lastResize?.rows;
      const attachId = generateAttachId();

      conn.sendMessage({
        msg_type: 'client.attach',
        id: attachId,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          session_name: sessionName,
          ...(w !== undefined && h !== undefined ? { width: w, height: h } : {}),
        },
      });

      // Watch for ok / error response.
      const unsub = conn.onMessage((msg) => {
        if (msg.id !== attachId) { return; }
        if (msg.msg_type === 'ok') {
          setTerminalState('attached');
          // Flush buffered input.
          for (const data of bufferedInputRef.current) {
            viewRef.current?.sendText(data);
          }
          bufferedInputRef.current = [];
          if (attachTimerRef.current) {
            clearTimeout(attachTimerRef.current);
            attachTimerRef.current = null;
          }
        } else if (msg.msg_type === 'error') {
          setTerminalState('failed');
          if (attachTimerRef.current) {
            clearTimeout(attachTimerRef.current);
            attachTimerRef.current = null;
          }
        }
      });

      // Attach timeout.
      attachTimerRef.current = setTimeout(() => {
        attachTimerRef.current = null;
        unsub();
        setTerminalState('reconnecting');
      }, ATTACH_TIMEOUT_MS);

      return () => {
        unsub();
        if (attachTimerRef.current) {
          clearTimeout(attachTimerRef.current);
          attachTimerRef.current = null;
        }
      };
    }

    case 'attached':
      // Terminal I/O is live.  Clear reconnect counter on stable attach.
      reconnectCountRef.current = 0;
      if (view) { view.setExternalBanner('none', 0); }
      break;

    case 'reconnecting': {
      const count = reconnectCountRef.current + 1;
      reconnectCountRef.current = count;
      if (count > P2P_MAX_RECONNECT) {
        setTerminalState('failed');
        break;
      }
      if (view) { view.setExternalBanner('reconnecting', count); }
      // The socket will drop → useP2PConnection will reconnect →
      // p2pStateAtom → 'connected' → we transition to connecting via
      // the p2pState watcher below.
      break;
    }

    case 'failed':
      if (view) { view.setExternalBanner('failed', 0); }
      break;
  }
}, [mode, terminalState, sessionName, p2pConnection, lastResize,
    setTerminalState, setLastResize]);
```

- [ ] **Step 5: Add p2pState → state machine transition effect**

The state machine needs to react to p2pState changes (from useP2PConnection). Add a separate small effect:

```typescript
// Watch p2pState and feed transitions into the state machine.
const p2pState = p2pConnection?.connectionState;
useEffect(() => {
  if (mode !== 'p2p') { return; }

  if (p2pState === 'connected' && terminalState === 'connecting') {
    setTerminalState('connected');
  } else if (p2pState === 'disconnected' && terminalState === 'attached') {
    setTerminalState('reconnecting');
  } else if (p2pState === 'disconnected' && terminalState === 'reconnecting') {
    // Socket closed during reconnect — stay reconnecting,
    // useP2PConnection will try again.
  }
}, [mode, p2pState, terminalState, setTerminalState]);
```

- [ ] **Step 6: Buffer input in non-attached states**

Modify the `sendText` / input handling. When `terminalState !== 'attached'`, buffer input instead of sending:

```typescript
// In the TerminalView constructor's onData handler:
// (This lives in TerminalView.ts, not Terminal.tsx)
// The onData callback needs to check terminalState before sending.
// TerminalView receives the session state from outside.

// Actually, keep it simpler: add a callback from Terminal.tsx to TerminalView:
// TerminalView.inputGate = () => terminalState === 'attached'
// If gated, buffer; if not, send.

// OR: just check the atom in ConnectionManager.send().
// ConnectionManager reads terminalSessionStateAtom and buffers if not 'attached'.
```

Wait, this complicates things. Let me simplify:

The input buffering lives in Terminal.tsx, where we have access to the state. TerminalView.ts has an `onData` callback that calls `this.connection.send(data)`. We can't change who calls send without modifying TerminalView.ts.

Simpler approach: let ConnectionManager check terminalSessionStateAtom in `send()`. If not `attached`, buffer the input. When state transitions to `attached`, flush.

```typescript
// In ConnectionManager.send():
send(data: string): void {
  if (this.disposed) { return; }
  // Buffer input until attached.  The default jotai store works
  // without a Provider — we import the atom directly.
  const { getDefaultStore } = require('jotai');
  const state = getDefaultStore().get(terminalSessionStateAtom);
  if (state !== 'attached') {
    this.inputBuffer.push(data);
    return;
  }
  // Flush any previously buffered input.
  if (this.inputBuffer.length > 0) {
    for (const d of this.inputBuffer) { this.send(d); }
    this.inputBuffer = [];
    return;
  }
  // ... existing send logic
}
```

Hmm, but importing jotai's getDefaultStore is not idiomatic. 

Alternative: ConnectionManager already has `onStateChange` callback. Terminal.tsx uses it to get state changes. We can also add an `onSend` gate that checks the state machine.

Actually, the simplest approach: just let Terminal.tsx create the TerminalView class with a `sendGate` callback:

In Terminal.tsx, when creating TerminalView:
```typescript
view.sendGate = () => terminalState === 'attached';
view.onSendWhileGated = (data: string) => {
  bufferedInputRef.current.push(data);
};
```

But this is fragile and couples the class to React state.

Simplest correct approach: just pass the state atom to the TerminalView class via the constructor, and let ConnectionManager read it. Since jotai atoms are global, just import it:

```typescript
// ConnectionManager.ts
import { getDefaultStore } from 'jotai';
import { terminalSessionStateAtom } from '../atoms/terminal';

// In send():
send(data: string): void {
  if (this.disposed) { return; }
  const state = getDefaultStore().get(terminalSessionStateAtom);
  if (state !== 'attached') {
    this.inputBuffer.push(data);
    return;
  }
  // flush buffered
  for (const d of this.inputBuffer) { this.reallySend(d); }
  this.inputBuffer = [];
  this.reallySend(data);
}
```

This is the cleanest — ConnectionManager directly reads the global atom, no prop drilling.

- [ ] **Step 7: Add input buffer and flush to ConnectionManager**

- [ ] **Step 8: Handle relay mode in state machine**

For relay, the state machine is simpler:
- connecting → connected (relay authenticated)
- connected → attached (beginRelay sent, fire-and-forget)
- attached → reconnecting (relay disconnect)
- reconnecting → connecting (retry) / failed (max retries)

Add relay transitions to the state machine effect.

- [ ] **Step 9: Verify**

```bash
cd web && npx tsc --noEmit && npx eslint src/components/Terminal.tsx src/terminal/ConnectionManager.ts --max-warnings 0 && npx vitest run
```
Expected: all tests pass

- [ ] **Step 10: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/terminal/ConnectionManager.ts
git commit -m "feat: implement terminal session state machine

Replace p2pState observer + ConnectionManager attach with a 6-state
atom (idle→connecting→connected→attached→reconnecting→failed).
client.attach waits for agent ok before entering attached.
User input is buffered until attached.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full lint + tsc**

```bash
cd web && npx eslint src/ --ext .ts,.tsx --max-warnings 0 && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 2: Full test suite**

```bash
cd web && npx vitest run
```
Expected: all tests pass

- [ ] **Step 3: Push**

```bash
git push origin fix/sessions-hard-refresh
```
