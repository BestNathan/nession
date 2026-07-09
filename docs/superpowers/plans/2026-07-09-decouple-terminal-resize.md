# Decouple Web Terminal Resize from tmux Window Size — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all web→tmux resize synchronization from `Terminal.tsx` so xterm.js canvas resizes independently via `fitAddon.fit()` only.

**Architecture:** Delete `sendResize()`, the relay-mode `term.onResize` handler that calls `sendTerminalResize()`, and all call sites. Replace `fit() + sendResize()` patterns with just `fit()`. Remove the resize debounce timer (no longer needed since `fit()` is a lightweight DOM measurement). Keep `sendTerminalResize()` on `WebSocketService` for CLI client compatibility.

**Tech Stack:** TypeScript, React, xterm.js 5.5

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/src/components/Terminal.tsx` | Modify | Remove resize sync, keep fit-only |
| `web/src/services/websocket.ts` | No change | `sendTerminalResize()` stays for CLI |
| `web/src/services/__tests__/websocket.test.ts` | No change | Tests for `sendTerminalResize` stay |

---

## How to verify

After changes, run the dev stack and confirm:
1. Resize browser window → terminal canvas fills container (visual check)
2. Text in tmux session wraps naturally at the browser's width
3. `npm run lint` passes with `--max-warnings 0`
4. `npx tsc --noEmit` passes

---

### Task 1: Remove `sendResize()` function and its call inside `refitRef`

**Files:**
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Delete the `sendResize` function (lines 452–472)**

Delete this entire block:
```typescript
    /** Send the current terminal dimensions to the remote end. */
    const sendResize = () => {
      if (!active) {return;}
      const { cols, rows } = term;
      try {
        if (mode === 'p2p') {
          const conn = p2pConnRef.current;
          if (conn && conn.connectionState === 'connected') {
            conn.sendMessage({
              msg_type: 'terminal.resize',
              id: generateId(),
              timestamp: Math.floor(Date.now() / 1000),
              payload: { session_name: sessionName, width: cols, height: rows },
            });
          }
        } else if (mode === 'relay' && serverConnection?.isConnected()) {
          serverConnection.sendTerminalResize(sessionId, cols, rows);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };
```

- [ ] **Step 2: Update the `refitRef` documentation comment (lines 102–105)**

Before:
```typescript
  // Holds the "refit terminal + push new dimensions" closure, assigned inside
  // the connection effect. Lets the imperative refit() reuse the effect's
  // fitAddon + sendResize without duplicating the mode-aware resize logic.
```

After:
```typescript
  // Holds the "refit terminal" closure, assigned inside the connection effect.
  // Lets the imperative refit() reuse the effect's fitAddon without duplicating
  // the mode-aware logic.
```

- [ ] **Step 3: Update `refitRef` to remove `sendResize()` call (near line 548)**

Before:
```typescript
    refitRef.current = () => {
      if (!active) {return;}
      requestAnimationFrame(() => {
        if (!active) {return;}
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // Container may be zero-sized (still hidden) — ignore.
        }
      });
    };
```

After:
```typescript
    refitRef.current = () => {
      if (!active) {return;}
      requestAnimationFrame(() => {
        if (!active) {return;}
        try {
          fitAddon.fit();
        } catch {
          // Container may be zero-sized (still hidden) — ignore.
        }
      });
    };
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "refactor: remove sendResize function and its call in refitRef

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Remove relay-mode `term.onResize` handler

**Files:**
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Remove the `relayResizeDisposable` code block (lines 618–632)**

Delete this entire block:
```typescript
      // Forward terminal resize events, debounced to 150ms to avoid flooding
      // the server during rapid window resizes or drag operations.
      relayResizeDisposable = term.onResize(({ cols, rows }) => {
        if (!active) {return;}
        if (resizeTimer) {clearTimeout(resizeTimer);}
        resizeTimer = setTimeout(() => {
          try {
            if (serverConnection?.isConnected()) {
              serverConnection.sendTerminalResize(sessionId, cols, rows);
            }
          } catch (err) {
            reportError(err instanceof Error ? err : new Error(String(err)));
          }
        }, 150);
      });
```

- [ ] **Step 2: Remove the `relayResizeDisposable` variable declaration (line 421)**

Change:
```typescript
    let relayUnsubOutput: (() => void) | null = null;
    let relayInputDisposable: IDisposable | null = null;
    let relayResizeDisposable: IDisposable | null = null;
    let dataDisposable: IDisposable | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
```

To:
```typescript
    let relayUnsubOutput: (() => void) | null = null;
    let relayInputDisposable: IDisposable | null = null;
    let dataDisposable: IDisposable | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 3: Remove the `relayResizeDisposable?.dispose()` call from cleanup (line 704)**

Delete this line:
```typescript
      relayResizeDisposable?.dispose();
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "refactor: remove relay-mode term.onResize handler that synced to tmux

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Remove `sendResize()` calls from attach and window resize

**Files:**
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Remove `sendResize()` call after initial attach (line 639)**

Delete the line:
```typescript
      // Send initial dimensions now that the terminal is open.
      sendResize();
```

(Keep `attachSentRef.current = true` and `wasConnectedRef.current = true` above it.)

- [ ] **Step 2: Update the window resize handler to remove `sendResize()` (lines 656–669)**

Before:
```typescript
    const handleWindowResize = () => {
      if (resizeTimer) {clearTimeout(resizeTimer);}
      resizeTimer = setTimeout(() => {
        if (!active) {return;}
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // Ignore fit errors during rapid resize transitions.
        }
      }, 150);
    };

    window.addEventListener('resize', handleWindowResize);
```

After:
```typescript
    const handleWindowResize = () => {
      if (!active) {return;}
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during rapid resize transitions.
      }
    };

    window.addEventListener('resize', handleWindowResize);
```

- [ ] **Step 3: Remove `resizeTimer` variable declaration (line 423)**

Delete:
```typescript
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 4: Remove `resizeTimer` cleanup from the effect cleanup function (lines 687–690)**

Delete:
```typescript
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
```

- [ ] **Step 5: Verify lint and typecheck**

```bash
cd web && npm run lint
```
Expected: PASS with `--max-warnings 0`

```bash
cd web && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "refactor: remove sendResize calls, resizeTimer, and debounce logic

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Run full web test suite

**Files:**
- No changes — verification only

- [ ] **Step 1: Run test suite**

```bash
cd web && npm test
```
Expected: all tests pass

- [ ] **Step 2: Run full CI pre-check**

```bash
cd web && npm run build && npm run lint && npm test
```
Expected: all pass
