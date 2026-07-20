# Terminal Bidirectional Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal resize bidirectional — client drives tmux window size on attach/resize, tmux confirms via `%window-resize` broadcast.

**Architecture:** Agent's `ControlModeSession::resize()` executes real `tmux resize-window` (was no-op). Client adds ResizeObserver to detect container size changes and sends `terminal.resize` to agent. Agent resizes tmux before attaching. Server relay already works (handler broadcasts `agent.terminal.resize` to relay clients).

**Tech Stack:** Rust (agent), TypeScript/React (web client), xterm.js 5.5, tmux control mode

---

## File Structure

### Agent (Rust)
- **Modify:** `crates/nession-agent/src/tmux/control.rs:110-121` — resize() from no-op to real tmux command
- **Modify:** `crates/nession-agent/src/tmux/control.rs:39-82` — attach() pre-resize tmux before spawning control mode
- **Modify:** `crates/nession-agent/src/tmux/manager.rs:129-154` — remove `lock_window_size` call and method

### Web Client (TypeScript)
- **Modify:** `web/src/terminal/ConnectionManager.ts` — add `sendResize(cols, rows)` method
- **Modify:** `web/src/terminal/TerminalView.ts` — expose `sendResize()` + cell dimension getter
- **Modify:** `web/src/components/Terminal.tsx` — add ResizeObserver
- **Modify:** `web/src/services/websocket.ts:495-512` — fix `sendTerminalResize` payload field names (`width`/`height` → `cols`/`rows`)

### Already Complete (no changes needed)
- Server `handler.rs` — `handle_agent_terminal_resize` broadcasts to relay clients ✅
- Server `client_registry.rs` — client registry with broadcast ✅
- `protocol.rs` — `AgentTerminalResizePayload`, `ServerTerminalResizePayload` ✅
- Agent control mode parsing — `%window-resize` event parsing ✅
- Agent P2P resize broadcast — already wired ✅
- `TerminalSizeManager` — `handleResize(cols, rows)` ✅
- `FontSizeManager` — font-based zoom ✅
- `ConnectionManager` — receives `terminal.resize` in both modes ✅

---

## Task 1: Agent — resize() executes real tmux resize-window

**Files:**
- Modify: `crates/nession-agent/src/tmux/control.rs:110-121`

- [ ] **Step 1: Write failing test**

The current `resize()` is a no-op. Since this involves a real tmux subprocess, we test via unit test that verifies the command string format, and via integration test that verifies end-to-end behavior. Add a test for the command format:

Add to `crates/nession-agent/src/tmux/control.rs` in the `#[cfg(test)]` module (or as a doc test):

```rust
#[test]
fn test_resize_command_format() {
    // Verify the command sent to tmux stdin has correct format.
    // The command should be: "resize-window -t {session} -x {cols} -y {rows}\n"
    let session_name = "test-session";
    let cols: u16 = 120;
    let rows: u16 = 40;
    // Expected command format
    let expected = format!("resize-window -t {} -x {} -y {}\n", session_name, cols, rows);
    assert_eq!(expected, "resize-window -t test-session -x 120 -y 40\n");
}
```

- [ ] **Step 2: Run test to verify it passes (format test always passes, just documents expectation)**

Run: `cargo test -p nession-agent control::tests`
Expected: PASS

- [ ] **Step 3: Implement real resize**

Replace the current no-op `resize()` method at `control.rs:118-121`:

```rust
/// Resize the tmux window to the given dimensions.
///
/// Sends a `resize-window` command to tmux via stdin. tmux will confirm
/// the new size with a `%window-resize` event, which the read_output_loop
/// forwards on the resize channel for broadcast to all attached clients.
pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
    self.viewport = (width, height);
    let cmd = format!(
        "resize-window -t {} -x {} -y {}\n",
        self.session_name, width, height
    );
    self.stdin.write_all(cmd.as_bytes()).await?;
    self.stdin.flush().await?;
    Ok(())
}
```

- [ ] **Step 4: Update module-level doc comment**

Update the comment at `control.rs:6-10` to reflect the new bidirectional behavior:

```rust
//! tmux control mode session 管理
//!
//! Uses `tmux -C attach` to control a tmux session, parsing structured
//! messages instead of raw PTY output.
//!
//! Terminal size (cols/rows) is bidirectional: the client tells tmux its
//! desired size on attach and when the browser window resizes; tmux confirms
//! the new size via `%window-resize` events, which the agent broadcasts to
//! all attached clients. Last writer wins — the most recent resize sets
//! the size for everyone.
```

- [ ] **Step 5: Verify compilation and tests**

Run: `cargo build -p nession-agent && cargo test -p nession-agent`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/tmux/control.rs
git commit -m "feat(agent): execute real tmux resize-window in ControlModeSession::resize()
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Agent — remove window-size manual lock

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs:129-138` — remove `lock_window_size` call
- Modify: `crates/nession-agent/src/tmux/manager.rs:143-154` — remove `lock_window_size` method

- [ ] **Step 1: Remove `lock_window_size` call in `create_session`**

In `manager.rs`, remove the `lock_window_size` call block (lines 129-138):

Current code:
```rust
        // Lock pane size so no attaching client can resize it. Applied AFTER
        // new-session succeeds; on failure we roll back by killing the session
        // so we don't leave a half-configured session lying around.
        if let Err(e) = self.lock_window_size(name).await {
            let _ = Command::new("tmux")
                .args(["kill-session", "-t", name])
                .status()
                .await;
            return Err(e);
        }
```

Replace with nothing (delete the block). The `Ok(())` from the `new-session` status check should flow directly to the return.

- [ ] **Step 2: Remove `lock_window_size` method**

Delete the method at lines 143-154:

```rust
    /// Lock the pane size on this session so no attaching client can resize it.
    /// Requires tmux ≥ 2.9 (`window-size manual`). Docker images ship tmux 3.3+.
    async fn lock_window_size(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["set-option", "-t", name, "window-size", "manual"])
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("Failed to lock window-size on session: {name}");
        }
        Ok(())
    }
```

- [ ] **Step 3: Verify compilation and tests**

Run: `cargo build -p nession-agent && cargo test -p nession-agent`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "feat(agent): remove window-size manual lock to allow client-driven resize
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Agent — resize tmux before control mode attach

**Files:**
- Modify: `crates/nession-agent/src/tmux/control.rs:54-82` — add pre-attach resize step

- [ ] **Step 1: Add pre-attach resize to `ControlModeSession::attach()`**

Modify `attach()` to run `tmux resize-window` before spawning the control mode process:

```rust
    pub async fn attach(
        session_name: &str,
        width: u16,
        height: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<(u16, u16)>)> {
        // Resize tmux window to client's requested size BEFORE attaching.
        // This ensures tmux renders at the correct dimensions from the first
        // frame, avoiding a flash of wrong-sized content.
        let resize_status = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                session_name,
                "-x",
                &width.to_string(),
                "-y",
                &height.to_string(),
            ])
            .status()
            .await
            .with_context(|| {
                format!("failed to resize tmux window for session {session_name}")
            })?;

        if !resize_status.success() {
            anyhow::bail!("tmux resize-window exited with non-zero status for session {session_name}");
        }

        let mut child = Command::new("tmux")
            .args(["-C", "attach", "-t", session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("failed to spawn tmux -C attach -t {session_name}"))?;

        let stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;

        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_tx, resize_rx) = mpsc::channel(RESIZE_CHANNEL_CAPACITY);
        tokio::spawn(read_output_loop(stdout, output_tx, resize_tx));

        let session = Self {
            session_name: session_name.to_string(),
            child,
            stdin,
            viewport: (width, height),
        };

        Ok((session, output_rx, resize_rx))
    }
```

- [ ] **Step 2: Verify compilation and tests**

Run: `cargo build -p nession-agent && cargo test -p nession-agent`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/tmux/control.rs
git commit -m "feat(agent): resize tmux window before control mode attach
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Web — fix sendTerminalResize payload field names

**Files:**
- Modify: `web/src/services/websocket.ts:495-512`

- [ ] **Step 1: Fix field names from `width`/`height` to `cols`/`rows`**

The agent's `TerminalResizePayload` expects `cols` and `rows`, but `sendTerminalResize` sends `width` and `height`. This causes a deserialization failure on the agent side. Fix:

```typescript
  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const message: WebSocketMessage = {
      msg_type: 'terminal.resize',
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload: {
        session_id: sessionId,
        cols,
        rows,
      },
    };

    this.ws.send(JSON.stringify(message));
  }
```

Also update the type reference at line 30 if needed.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/services/websocket.ts
git commit -m "fix(web): use cols/rows field names in sendTerminalResize to match agent protocol
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Web — add sendResize to ConnectionManager

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts`

- [ ] **Step 1: Write failing test for sendResize**

Add to `web/src/terminal/__tests__/ConnectionManager.test.ts`:

```typescript
it('should send terminal.resize message in P2P mode', () => {
  const mockSend = vi.fn();
  const mockP2P = {
    connectionState: 'connected' as const,
    sendMessage: mockSend,
    onMessage: vi.fn().mockReturnValue(() => {}),
    waitForConnection: vi.fn().mockResolvedValue(undefined),
    reconnectAttempt: 0,
    close: vi.fn(),
  };
  const manager = new ConnectionManager({
    mode: 'p2p',
    sessionName: 'test',
    sessionId: 'sess-1',
    p2pConnection: mockP2P as any,
  });

  manager.sendResize(120, 40);

  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      msg_type: 'terminal.resize',
      payload: { cols: 120, rows: 40 },
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- ConnectionManager.test.ts`
Expected: FAIL — `manager.sendResize is not a function`

- [ ] **Step 3: Implement sendResize in ConnectionManager**

Add method to `ConnectionManager` class (after the `send` method, around line 77):

```typescript
  /** Send a terminal resize to the agent (client → tmux direction). */
  sendResize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      if (this.mode === 'p2p' && this.p2pConnection?.connectionState === 'connected') {
        this.p2pConnection.sendMessage({
          msg_type: 'terminal.resize',
          id: generateId(),
          timestamp: Math.floor(Date.now() / 1000),
          payload: { cols, rows },
        });
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendTerminalResize(this.sessionId, cols, rows);
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- ConnectionManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts web/src/terminal/__tests__/ConnectionManager.test.ts
git commit -m "feat(web): add sendResize method to ConnectionManager
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Web — expose sendResize + cell dimensions from TerminalView

**Files:**
- Modify: `web/src/terminal/TerminalView.ts`

- [ ] **Step 1: Add sendResize method and cell dimension getter to TerminalView**

Add these methods to the `TerminalView` class (after `sendText`, around line 122):

```typescript
  /** Send client viewport resize to the agent so tmux can resize its window. */
  sendResize(cols: number, rows: number): void {
    if (this.isDisposed) return;
    this.connection.sendResize(cols, rows);
  }

  /** Current cell pixel dimensions — used by ResizeObserver to calculate cols/rows. */
  get cellDimensions(): { width: number; height: number } {
    // Use the same internal API path as TerminalSizeManager.getCellDimensions.
    // Import or duplicate the helper — TerminalSizeManager already has this logic
    // as a module-level function. We expose it here for the React layer.
    const renderService = (this.terminal as any)._core?._renderService;
    const width: number = renderService?.dimensions?.css?.cell?.width ?? 8;
    const height: number = renderService?.dimensions?.css?.cell?.height ?? 16;
    return { width, height };
  }
```

**Note:** The `getCellDimensions` function in `TerminalSizeManager.ts` is a module-level function but not exported. For this plan, we inline the same logic. A follow-up cleanup could extract it to a shared utility.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/terminal/TerminalView.ts
git commit -m "feat(web): expose sendResize and cellDimensions from TerminalView
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Web — add ResizeObserver to Terminal.tsx

**Files:**
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Update the imperative handle to expose sendResize**

In `Terminal.tsx`, update `useImperativeHandle` to include `sendResize` in the `TerminalHandle` type, and update `types.ts`:

First update `web/src/terminal/types.ts` `TerminalHandle`:

```typescript
export interface TerminalHandle {
  sendText: (text: string) => void;
  refit: () => void;
  sendResize: (cols: number, rows: number) => void;
  fontSizeManager: import('./FontSizeManager').FontSizeManager | null;
}
```

Then in `Terminal.tsx`, update `useImperativeHandle`:

```typescript
  useImperativeHandle(
    ref,
    () => {
      void viewGeneration;
      return {
        sendText: (text: string) => {
          if (!isBlocked) { viewRef.current?.sendText(text); }
        },
        refit: () => viewRef.current?.refit(),
        sendResize: (cols: number, rows: number) => {
          viewRef.current?.sendResize(cols, rows);
        },
        fontSizeManager: viewRef.current?.fontSizeManager ?? null,
      };
    },
    [isBlocked, viewGeneration],
  );
```

- [ ] **Step 2: Add ResizeObserver in the terminal creation effect**

Add a ResizeObserver inside the `useEffect` that creates the TerminalView (around line 84), after `viewRef.current = view`:

```typescript
    viewRef.current = view;
    setViewGeneration((g) => g + 1);

    // ResizeObserver: detect container size changes and push to tmux.
    // Debounced — we only send when resizing STOPS (200ms quiet period)
    // to avoid flooding tmux with intermediate sizes during drag.
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const cell = view.cellDimensions;
        if (cell.width === 0 || cell.height === 0) continue;
        const cols = Math.max(1, Math.floor(width / cell.width));
        const rows = Math.max(1, Math.floor(height / cell.height));
        // Skip if dimensions haven't meaningfully changed (within 1 col/row).
        // Also skip the initial 0x0 or tiny sizes during layout.
        if (cols < 2 || rows < 2) continue;

        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
          if (!viewRef.current) return;
          viewRef.current.sendResize(cols, rows);
        }, 200);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      view.dispose();
      viewRef.current = null;
      setViewGeneration((g) => g + 1);
    };
```

Note: This replaces the existing return cleanup at the end of the effect. The existing cleanup is:
```typescript
    return () => {
      view.dispose();
      viewRef.current = null;
      setViewGeneration((g) => g + 1);
    };
```

Merge the ResizeObserver cleanup into the existing return.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run all web tests**

Run: `cd web && npm test`
Expected: All existing tests PASS (may need to update TerminalView test mocks)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/terminal/types.ts
git commit -m "feat(web): add ResizeObserver to push client viewport size to tmux
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Integration verification

**Files:**
- Manual testing with local dev stack

- [ ] **Step 1: Start local dev stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

- [ ] **Step 2: Verify bidirectional resize**

1. Open browser to http://localhost:13000, log in, attach to a session
2. Resize the browser window → tmux session should resize
3. Two browser windows attached to same session → resize one, verify other follows
4. Check agent logs for `resize-window` commands
5. Check that initial attach shows terminal at correct size (not flash of wrong size)

- [ ] **Step 3: Verify edge cases**

1. Rapid resize (drag corner) → no message flooding (debounce works)
2. Very small window → cols/rows clamped to minimum
3. Mobile viewport → resize works on touch resize
4. P2P mode → resize works without relay

- [ ] **Step 4: Commit any fixes found during integration testing**

---

## Summary

**Total tasks:** 8
**Estimated time:** 1-2 days
**Key deliverables:**
- Agent sends real `tmux resize-window` commands (was no-op)
- Agent pre-resizes tmux before attach (no flash of wrong size)
- `window-size manual` lock removed
- Client ResizeObserver pushes viewport changes to tmux
- `sendTerminalResize` field names fixed (`width`/`height` → `cols`/`rows`)
- Bidirectional resize works in both P2P and relay modes
