# Viewport-Fit Terminal Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the stalled `TerminalController` migration and switch the sizing model from fixed-size (dual scroll surface) to viewport-fit (single scroll surface), resolving issue #240.

**Architecture:** The new layered terminal (state → controller → input → components) becomes the live path. `TerminalRuntime` owns xterm + its managers (Renderer/Theme/FontSize/Addon/MobileInput/MouseIntentResolver); `TerminalController` is the imperative facade; `ResizeController` drives viewport-fit sizing so xterm's viewport is the only scroll surface. Legacy `TerminalView`/`Terminal.tsx`/`TerminalSizeManager`/`InputManager` are deleted after parity is reached. Agent forwards tmux resize events upstream so relay clients receive `terminal.resize`.

**Tech Stack:** TypeScript, React 19, Jotai, xterm.js 5.5, Vitest + Testing Library; Rust (nession-agent) for the relay resize forward.

**Spec:** `docs/superpowers/specs/2026-08-15-viewport-fit-terminal-migration-design.md`

---

## File Structure

**Create:**
- `web/src/terminal/runtime/TerminalRuntime.ts` — xterm instance + addons + managers + scroll/mobile/mouse + cell dims
- `web/src/terminal/runtime/__tests__/TerminalRuntime.test.ts`
- `web/src/terminal/controller/__tests__/TerminalController.test.ts` — already exists, extended

**Modify (web):**
- `web/src/terminal/controller/TerminalController.ts` — use `TerminalRuntime`; add scroll/fontSize/cellDims/scrollback-prefill
- `web/src/terminal/controller/ResizeController` (in `TerminalController.ts`) — fontSize→resize coupling
- `web/src/terminal/components/TerminalWorkspace.tsx` — swap legacy `Terminal` → `TerminalPane`/controller
- `web/src/terminal/hooks/useTerminalStateMachine.ts` — already extracted; wire as the live state machine
- `web/src/terminal/index.ts` — update exports (remove legacy)
- `web/vite.config.ts` — coverage exclusions

**Delete (web, Phase 5):**
- `web/src/terminal/TerminalView.ts`
- `web/src/components/Terminal.tsx`
- `web/src/terminal/InputManager.ts`
- `web/src/terminal/TerminalSizeManager.ts`
- `web/src/components/TerminalView.tsx` (re-export shim) — repoint to `terminal/components/TerminalWorkspace`

**Modify (Rust):**
- `crates/nession-agent/src/connection/server_client.rs` — `ServerClientHandle::send_terminal_resize`
- `crates/nession-agent/src/server/websocket.rs` — thread a resize sender into `AgentServer`; forward `%window-resize` upstream
- `crates/nession-agent/src/main.rs` — pass the handle/sender into `AgentServer::new`

---

## Phase 1: TerminalRuntime + Feature Parity

Goal: build `TerminalRuntime` owning xterm + managers, and make `TerminalController` reach feature parity with the legacy `TerminalView` (renderer, theme, font size, mobile input, mouse intent, scroll, cell dims, scrollback prefill). The app is still running on the legacy path — these are new, parallel, testable units.

### Task 1: TerminalRuntime class (TDD)

**Files:**
- Create: `web/src/terminal/runtime/TerminalRuntime.ts`
- Test: `web/src/terminal/runtime/__tests__/TerminalRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/terminal/runtime/__tests__/TerminalRuntime.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { TerminalRuntime } from '../TerminalRuntime';

// xterm needs a DOM element; jsdom provides one but xterm's real open() is
// heavy — we assert construction + delegation without relying on rendering.
describe('TerminalRuntime', () => {
  it('creates an xterm Terminal with default options', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(rt.terminal).toBeDefined();
    expect(rt.terminal.options.fontSize).toBe(14);
    expect(rt.terminal.options.scrollback).toBe(10000);
    rt.dispose();
  });

  it('exposes cell dimensions with an 8×16 fallback', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const dims = rt.cellDimensions;
    expect(dims.width).toBeGreaterThanOrEqual(8);
    expect(dims.height).toBeGreaterThanOrEqual(16);
    rt.dispose();
  });

  it('delegates scroll methods to xterm', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const spyBottom = vi.spyOn(rt.terminal, 'scrollToBottom').mockImplementation(() => {});
    const spyPages = vi.spyOn(rt.terminal, 'scrollPages').mockImplementation(() => {});
    rt.scrollToBottom();
    rt.scrollPages(-1);
    expect(spyBottom).toHaveBeenCalled();
    expect(spyPages).toHaveBeenCalledWith(-1);
    rt.dispose();
  });

  it('exposes a fontSizeManager', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(rt.fontSizeManager).toBeDefined();
    expect(typeof rt.fontSizeManager.zoomIn).toBe('function');
    rt.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/terminal/runtime/__tests__/TerminalRuntime.test.ts`
Expected: FAIL — cannot resolve `../TerminalRuntime`.

- [ ] **Step 3: Implement TerminalRuntime**

Create `web/src/terminal/runtime/TerminalRuntime.ts`:

```ts
import { Terminal } from '@xterm/xterm';
import { Renderer } from '../Renderer';
import { ThemeManager } from '../ThemeManager';
import { FontSizeManager } from '../FontSizeManager';
import { MobileInput } from '../MobileInput';
import { MouseIntentResolver } from '../MouseIntentResolver';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

interface XtermInternals {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } };
    };
  };
}

export interface TerminalRuntimeOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
}

/**
 * Owns the xterm instance and everything wired to it: renderer, theme, font
 * size, addons, mobile input (touch), and mouse-intent resolution. The
 * controller delegates to this instead of constructing a bare Terminal, so the
 * two implementations share one lifecycle.
 */
export class TerminalRuntime {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private renderer: Renderer;
  private theme: ThemeManager;
  private mouseIntent: MouseIntentResolver;
  private mobileInput: MobileInput | null = null;
  private disposed = false;
  /** Settable hook run after font-size changes (wired by the controller). */
  private fontSizeCallback: () => void = () => {};

  constructor(options: TerminalRuntimeOptions) {
    const initialFontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 10000,
    });

    this.renderer = new Renderer(this.terminal, options.rendererType);
    this.theme = new ThemeManager(this.terminal);
    this.mouseIntent = new MouseIntentResolver(this.terminal);
    // The controller wires this via the setter below (fontSize → resize).
    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback(),
      initialFontSize,
    );
  }

  /** Wire a callback run after font-size changes (e.g. re-run resize). */
  set onCellSizeChange(cb: () => void) {
    this.fontSizeCallback = cb;
  }

  /** Mount xterm into `element`. */
  open(element: HTMLElement): void {
    this.terminal.open(element);
  }

  /** On touch devices, install a visible textarea for IME input. */
  installMobileInput(parent: HTMLElement, onSend: (text: string) => void): void {
    if ('ontouchstart' in window && !this.mobileInput) {
      this.mobileInput = new MobileInput(this.terminal, parent, { onSend });
    }
  }

  /** Cell pixel size, falling back to 8×16 (14px monospace defaults). */
  get cellDimensions(): { width: number; height: number } {
    const rs = (this.terminal as unknown as XtermInternals)._core?._renderService;
    return {
      width: rs?.dimensions?.css?.cell?.width ?? 8,
      height: rs?.dimensions?.css?.cell?.height ?? 16,
    };
  }

  scrollToBottom(): void { this.terminal.scrollToBottom(); }
  scrollPages(pages: number): void { this.terminal.scrollPages(pages); }
  scrollLines(lines: number): void { this.terminal.scrollLines(lines); }

  focus(): void {
    if (this.mobileInput) { this.mobileInput.focus(); }
    else { this.terminal.focus(); }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.mobileInput?.dispose();
    this.mouseIntent.dispose();
    this.terminal.dispose();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/terminal/runtime/__tests__/TerminalRuntime.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/runtime/TerminalRuntime.ts web/src/terminal/runtime/__tests__/TerminalRuntime.test.ts
git commit -m "feat: add TerminalRuntime owning xterm + managers"
```

### Task 2: Re-point TerminalController at TerminalRuntime

**Files:**
- Modify: `web/src/terminal/controller/TerminalController.ts` (replace the bare `new Terminal` in `attach()`)

- [ ] **Step 1: Add a constructor option for runtime config**

In `TerminalController.ts`, change the constructor signature to accept renderer + fontSize:

```ts
export interface TerminalControllerOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
}

export class TerminalController {
  // ...existing fields...
  private runtime: TerminalRuntime | null = null;

  constructor(
    session: TerminalSession,
    transportFactory: () => TerminalTransport,
    private options: TerminalControllerOptions,
  ) {
    this.session = session;
    this.transportFactory = transportFactory;
    this.initInputRouter();
  }
```

- [ ] **Step 2: Replace bare Terminal creation in `attach()`**

Replace the `new Terminal({...})` block and `terminal.open(element)` in `attach()` with:

```ts
    const runtime = new TerminalRuntime(this.options);
    runtime.onCellSizeChange = () => {
      // Font size changed → recompute cols/rows for the same container.
      this.resizeController?.remeasure();
    };
    const terminal = runtime.terminal;
    this.runtime = runtime;
    this._terminal = terminal;
    // ...transport wiring unchanged (transport.onOutput → terminal.write, etc.)...

    runtime.open(element);
    runtime.installMobileInput(element, (text) => { this.transport?.send(text); });
```

- [ ] **Step 3: Add scroll + fontSize + cell-dim accessors**

Add to `TerminalController`:

```ts
  scrollToBottom(): void { this.runtime?.scrollToBottom(); }
  scrollPages(pages: number): void { this.runtime?.scrollPages(pages); }
  scrollLines(lines: number): void { this.runtime?.scrollLines(lines); }

  get fontSizeManager(): FontSizeManager | null { return this.runtime?.fontSizeManager ?? null; }

  get cellDimensions(): { width: number; height: number } {
    return this.runtime?.cellDimensions ?? { width: 8, height: 16 };
  }
```

Update `getCellDimensions()` (private, used by `ResizeController`) to delegate:

```ts
  private getCellDimensions(): { width: number; height: number } {
    return this.cellDimensions;
  }
```

- [ ] **Step 4: Update `detach()` to dispose the runtime**

In `detach()`, after `this._terminal?.dispose()`:

```ts
    this.runtime?.dispose();
    this.runtime = null;
    this._terminal = null;
```

- [ ] **Step 5: Add `remeasure()` to ResizeController**

In `ResizeController`, add a method that re-runs the size calculation against the last observed container size (used after a font-size change):

```ts
  private lastContainer = { width: 0, height: 0 };
  private lastCell = { width: 8, height: 16 };

  observe(container, cellWidth, cellHeight) { /* existing, but also stash: */
    this.lastCell = { width: cellWidth, height: cellHeight };
    // ...existing observer setup...
  }

  remeasure(): void {
    const { width, height } = this.lastContainer;
    if (width <= 0 || height <= 0) { return; }
    const cols = Math.max(1, Math.floor(width / this.lastCell.width));
    const rows = Math.max(1, Math.floor(height / this.lastCell.height));
    if (cols < 2 || rows < 2) { return; }
    this.controller.resize(cols, rows);
  }
```

Also update the observer callback to stash `lastContainer` on each entry.

- [ ] **Step 6: Run the full terminal test suite**

Run: `cd web && npx vitest run src/terminal`
Expected: all existing terminal tests pass (TerminalController.test.ts may need its constructor call updated to pass `{ rendererType: 'canvas' }` — fix the test if `new TerminalController(...)` is called without the third arg).

- [ ] **Step 7: Commit**

```bash
git add web/src/terminal/controller/TerminalController.ts web/src/terminal/controller/__tests__/TerminalController.test.ts
git commit -m "refactor: TerminalController delegates to TerminalRuntime"
```

### Task 3: Scrollback prefill on attach

**Files:**
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Modify: `web/src/terminal/ConnectionManager.ts` (add a prefill path) — or handle in the transport wiring

- [ ] **Step 1: Write a failing test for prefill ordering**

In `TerminalController.test.ts`, add a test asserting that when the transport emits initial output before any live output, it is written first:

```ts
it('writes transport output in order to xterm', () => {
  const controller = new TerminalController(
    { id: 's1', name: 'n', status: 'idle', mode: 'p2p', startedAt: 0 },
    () => transportStub,
    { rendererType: 'canvas' },
  );
  const writes: unknown[] = [];
  const terminal = { write: (d: unknown) => writes.push(d) };
  // ...attach with a stubbed runtime...
  expect(writes.length).toBeGreaterThanOrEqual(1);
});
```

> Note: the existing `capture_scrollback` prefill is an agent-side feature (the agent sends captured scrollback as the first `terminal.output` before live output, see `websocket.rs` control-mode path). The frontend's job is only to write output in arrival order. Assert that `terminal.write` is called for each `transport.onOutput` payload in order; the prefill ordering is already guaranteed by the agent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/terminal/controller/__tests__/TerminalController.test.ts`
Expected: FAIL (new test).

- [ ] **Step 3: Confirm/keep the ordering behavior**

The existing `attach()` already wires `transport.onOutput = (data) => terminal.write(data)`. If the test still fails only because of missing scaffolding, fix the test's stub to mirror the real attach wiring. No production code change should be required — this task is a regression guard for ordering.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/terminal/controller/__tests__/TerminalController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/controller/__tests__/TerminalController.test.ts
git commit -m "test: guard scrollback prefill ordering on attach"
```

---

## Phase 2: Viewport-Fit Sizing (single scroll surface)

The new `ResizeController` already sizes xterm to the container (viewport-fit) and `terminal.open()` mounts directly — there is no `scrollContainer`/`mountElement` wrapper in the new path. This phase verifies the fontSize↔resize coupling and documents the single-scroll-surface invariant.

### Task 4: fontSize change triggers a resize recompute (TDD)

**Files:**
- Test: `web/src/terminal/controller/__tests__/TerminalController.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('fontSize zoom triggers a resize recompute', () => {
  const controller = new TerminalController(
    { id: 's1', name: 'n', status: 'idle', mode: 'p2p', startedAt: 0 },
    () => transportStub,
    { rendererType: 'canvas' },
  );
  // Attach to a jsdom container and let ResizeController observe it.
  const el = document.createElement('div');
  el.style.width = '400px';
  el.style.height = '200px';
  document.body.appendChild(el);
  controller.attach(el);
  const resizeSpy = vi.spyOn(controller, 'resize');
  controller.fontSizeManager?.zoomIn();
  expect(resizeSpy).toHaveBeenCalled();
  controller.detach();
  el.remove();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/terminal/controller/__tests__/TerminalController.test.ts`
Expected: FAIL — `resize` not called (or `remeasure` not wired).

- [ ] **Step 3: Wire the hook (already stubbed in Task 2)**

Confirm `TerminalRuntime.onCellSizeChange` → `ResizeController.remeasure()` is wired in `attach()` (added in Task 2 Step 2). If `ResizeController` has not yet observed a container size (attach was called but `observe` runs on the next `requestAnimationFrame`), the test must first flush the RAF. Adjust the test to `await new Promise(r => requestAnimationFrame(() => r()))` after `attach`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/terminal/controller/__tests__/TerminalController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/controller/__tests__/TerminalController.test.ts
git commit -m "test: fontSize zoom triggers viewport resize recompute"
```

---

## Phase 3: Relay Resize Forward (Rust)

Goal: the agent forwards tmux `%window-resize` events to the central server so relay clients (browser → server → agent) receive `terminal.resize`, matching the P2P path. Today the control-mode resize loop sends only to the direct P2P sink.

### Task 5: `ServerClientHandle::send_terminal_resize` (TDD)

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs`
- Modify: `crates/nession-agent/src/sync/terminal.rs` (reuse payload type)

- [ ] **Step 1: Write the failing test**

In `server_client.rs` `#[cfg(test)] mod tests`, add:

```rust
#[tokio::test]
async fn send_terminal_resize_queues_message() {
    let (outbox, mut rx) = mpsc::unbounded_channel::<WsMessage>();
    let (shutdown_tx, _) = mpsc::channel(1);
    let handle = ServerClientHandle {
        outbox,
        shutdown_tx,
        agent_id: "agent-1".to_string(),
        metadata: Default::default(),
        sync_needed: Arc::new(AtomicBool::new(false)),
        connected: Arc::new(AtomicBool::new(true)),
    };
    handle.send_terminal_resize("agent-1:sess-1", 120, 40).await.unwrap();
    // rx receives one text message whose parsed JSON has
    // msg_type == "agent.terminal.resize" and payload.session_id == "agent-1:sess-1"
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p nession-agent send_terminal_resize_queues_message`
Expected: FAIL — method `send_terminal_resize` not found.

- [ ] **Step 3: Implement the method**

Add to `impl ServerClientHandle` in `server_client.rs`:

```rust
    /// Queue a terminal resize event for delivery to the central server, which
    /// broadcasts it to relay clients attached to the session.
    ///
    /// `session_id` is the FULL `agent:name` id — the server's
    /// `handle_agent_terminal_resize` looks up relay clients by
    /// `payload.session_id` (not the bare session name).
    pub async fn send_terminal_resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let payload = AgentTerminalResizePayload {
            session_id: session_id.to_string(),
            cols,
            rows,
        };
        let msg = new_message("agent.terminal.resize", payload);
        self.enqueue(&msg)
    }
```

Add the import:

```rust
use nession_common::protocol::AgentTerminalResizePayload;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p nession-agent send_terminal_resize_queues_message`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs
git commit -m "feat: add ServerClientHandle::send_terminal_resize"
```

### Task 6: Thread a resize sender into AgentServer and forward `%window-resize`

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs`
- Modify: `crates/nession-agent/src/main.rs`

- [ ] **Step 1: Add a resize-sender field to AgentServer**

In `AgentServer`, add a field holding a clonable sender. Use a `ServerClientHandle` if available at construction; otherwise a dedicated `mpsc::UnboundedSender<AgentTerminalResizePayload>` that `main.rs` drains into the handle. Choose the dedicated channel (simpler, keeps `AgentServer` decoupled from `ServerClientHandle`):

```rust
pub struct AgentServer {
    // ...existing fields...
    /// Sink for forwarding tmux resize events to the central server (relay).
    /// Carries the FULL session id (`agent:name`), cols, rows.
    resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
}
```

- [ ] **Step 2: Extend `AgentServer::new` to accept the sender**

```rust
    pub fn new(
        listen_address: impl Into<String>,
        agent_id: impl Into<String>,
        tls: Option<...>,
        default_working_dir: String,
        file_root: &str,
        attach_mode: AttachMode,
        resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
    ) -> Result<Self> {
        // ...existing...
        Ok(Self { /* ...existing... */ resize_tx })
    }
```

- [ ] **Step 3: Forward resize in the control-mode resize loop**

In the control-mode attach path (the spawned task that loops over `resize_rx`), after `send_terminal_resize_msg(&sink, ...)`, also enqueue upstream using the FULL session id (`{agent_id}:{session_name}` — the server keys relay clients by full id):

```rust
let full_id = format!("{agent_id}:{session_name_resize}");
while let Some((cols, rows)) = resize_rx.recv().await {
    let _ = resize_tx.send((full_id.clone(), cols, rows));
    if !send_terminal_resize_msg(&sink_resize, &session_name_resize, cols, rows).await {
        break;
    }
}
```

Clone `resize_tx` and `agent_id` into the task before spawning. (The P2P-facing `send_terminal_resize_msg` still uses the bare `session_name`, matching how P2P clients are keyed; only the upstream server message carries the full id.)

- [ ] **Step 4: Wire `main.rs`**

In `main.rs`, create the channel, spawn a forwarder that drains it into `ServerClientHandle::send_terminal_resize` (skipping while disconnected), and pass the sender into `AgentServer::new`:

```rust
let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(String, u16, u16)>();
let handle_clone = server_handle.clone();
tokio::spawn(async move {
    while let Some((session_id, cols, rows)) = resize_rx.recv().await {
        if handle_clone.is_connected() {
            let _ = handle_clone.send_terminal_resize(&session_id, cols, rows).await;
        }
    }
});
// ...pass resize_tx into AgentServer::new(...)
```

- [ ] **Step 5: Build + clippy + test**

Run: `cargo build -p nession-agent && cargo clippy -p nession-agent -- -D warnings && cargo test -p nession-agent`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs crates/nession-agent/src/main.rs
git commit -m "feat: forward tmux resize events to central server for relay"
```

---

## Phase 4: Swap the Live Mount

Goal: make the live terminal use `TerminalController` + `TerminalPane` + `useTerminalStateMachine`, dropping the legacy `components/Terminal.tsx` shell and its inline state machine. This is the risky step — only proceed after Phase 1 parity is verified.

### Task 7: Rewrite TerminalWorkspace to render TerminalPane (TDD for the wiring)

**Files:**
- Modify: `web/src/terminal/components/TerminalWorkspace.tsx`
- Modify: `web/src/terminal/components/TerminalPane.tsx`
- Test: `web/src/terminal/components/__tests__/TerminalPane.test.tsx` (exists)

- [ ] **Step 1: Write/refresh the failing TerminalPane test**

Ensure `TerminalPane.test.tsx` asserts the controller is attached to a DOM node and renders banner/viewport/overlay. Run to confirm it fails against the current `TerminalPane` if it is still wired to a `null` controller.

- [ ] **Step 2: Build a `useTerminal` hook that creates a controller per session**

Create `web/src/terminal/hooks/useTerminal.ts`:

```ts
import { useMemo } from 'react';
import { TerminalController } from '../controller/TerminalController';
import type { TerminalTransport } from '../transport/TerminalTransport';

export function useTerminal(
  sessionId: string,
  sessionName: string,
  mode: 'p2p' | 'relay',
  transportFactory: () => TerminalTransport,
  rendererType: 'webgl' | 'canvas',
): TerminalController {
  return useMemo(
    () => new TerminalController(
      { id: sessionId, name: sessionName, status: 'idle', mode, startedAt: 0 },
      transportFactory,
      { rendererType },
    ),
    // Rebuild on identity/mode change only (same rule as legacy TerminalView).
    [sessionId, sessionName, mode, rendererType],
  );
}
```

- [ ] **Step 3: Rewire TerminalWorkspace's terminal element**

In `TerminalWorkspace.tsx`, replace the legacy `<Terminal ref={terminalRef} ... />` element with a controller-driven pane. The `transportFactory` wraps the existing `ConnectionManager` into a `TerminalTransport`:

```tsx
import { TerminalController } from '../controller/TerminalController';
import { TerminalPane } from './TerminalPane';
import { useTerminalStateMachine } from '../hooks/useTerminalStateMachine';
import { ConnectionManager } from '../ConnectionManager';

// inside TerminalWorkspace, replace `terminalElement`:
const { terminalState, reconnectCount } = useTerminalStateMachine({ serverConnection: wsService });
const controller = useTerminal(sessionId, sessionName, effectiveMode, () =>
  new ConnectionManager({
    mode: effectiveMode,
    sessionName,
    sessionId,
    p2pConnection: p2pConnection ?? undefined,
    serverConnection: !isP2P ? wsService : undefined,
  }) as unknown as TerminalTransport,
  renderer ?? 'canvas');

const terminalElement = (
  <TerminalPane sessionId={sessionId} controller={controller} reconnectAttempt={reconnectCount} />
);
```

- [ ] **Step 4: Handle `terminalHandle` imperative methods**

The toolbar still calls `sendText`/`scrollPages`/`scrollToBottom`/`fontSizeManager` via `terminalHandle`. Because the controller is now owned inside `TerminalWorkspace` (not via a ref), route those calls to `controller` directly instead of the legacy `terminalHandle`:

```tsx
sendText={(text) => controller.send(text)}
onScrollPages={(pages) => controller.scrollPages(pages)}
onScrollToBottom={() => controller.scrollToBottom()}
fontSizeManager={controller.fontSizeManager}
```

Remove the `terminalHandle`/`terminalRef`/`setTerminalHandle` plumbing.

- [ ] **Step 5: Run tsc + vitest**

Run: `cd web && npx tsc --noEmit && npx vitest run src/terminal/components`
Expected: 0 errors; component tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/terminal/components/TerminalWorkspace.tsx web/src/terminal/components/TerminalPane.tsx web/src/terminal/hooks/useTerminal.ts web/src/terminal/components/__tests__/TerminalPane.test.tsx
git commit -m "refactor: swap live terminal to TerminalController + TerminalPane"
```

### Task 8: Wire the extracted state machine as the sole state machine

**Files:**
- Modify: `web/src/terminal/hooks/useTerminalStateMachine.ts` (already extracted — ensure it matches the legacy inline effect)
- Delete: the inline state-machine `useEffect` in `web/src/components/Terminal.tsx` (deferred to Phase 5)

- [ ] **Step 1: Diff the two state machines for parity**

Compare `useTerminalStateMachine.ts` (new) against the inline `useEffect` switch in `components/Terminal.tsx` (legacy). They must be behaviorally identical. If the extracted hook is missing any case (e.g. the relay `beginRelay` call, the `P2P_MAX_RECONNECT` bound), port it over now.

- [ ] **Step 2: Run the state-machine test**

Run: `cd web && npx vitest run src/terminal/hooks/__tests__/useTerminalStateMachine.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit (if changed)**

```bash
git add web/src/terminal/hooks/useTerminalStateMachine.ts
git commit -m "refactor: align useTerminalStateMachine with legacy inline effect"
```

---

## Phase 5: Delete Legacy

Goal: remove the now-dead legacy files and fix exports/coverage so nothing references them.

### Task 9: Delete legacy files and fix exports

**Files:**
- Delete: `web/src/terminal/TerminalView.ts`, `web/src/components/Terminal.tsx`, `web/src/terminal/InputManager.ts`, `web/src/terminal/TerminalSizeManager.ts`
- Modify: `web/src/components/TerminalView.tsx` (re-export shim → repoint)
- Modify: `web/src/terminal/index.ts`
- Modify: `web/vite.config.ts`

- [ ] **Step 1: Repoint the TerminalView re-export shim**

`web/src/components/TerminalView.tsx` currently re-exports `TerminalWorkspace`. Keep it (Dashboard/App may still import it) but ensure it no longer references the legacy class:

```tsx
export { TerminalWorkspace as TerminalView } from '../terminal/components/TerminalWorkspace';
export type { AttachedSession } from '../terminal/components/TerminalWorkspace';
```

- [ ] **Step 2: Update terminal/index.ts exports**

Remove legacy exports (`TerminalView`, `InputManager`, `TerminalSizeManager`, `ConnectionManager`) and add the new runtime:

```ts
export { TerminalRuntime } from './runtime/TerminalRuntime';
export { TerminalController, ResizeController } from './controller/TerminalController';
export { TerminalPane, TerminalViewport, TerminalBanner, TerminalWorkspace, TerminalTabs } from './components';
// keep state/input/transport exports
```

- [ ] **Step 3: Remove dead files**

```bash
git rm web/src/terminal/TerminalView.ts web/src/components/Terminal.tsx web/src/terminal/InputManager.ts web/src/terminal/TerminalSizeManager.ts
```

- [ ] **Step 4: Update coverage exclusions in vite.config.ts**

Remove `TerminalView.ts`, `Terminal.tsx`, `TerminalSizeManager.ts`, `InputManager.ts` from the coverage `exclude` list; add the new glue files that are browser-only (`TerminalWorkspace.tsx`, `TerminalPane.tsx`) if not already excluded.

- [ ] **Step 5: Full gates**

```bash
cd web && npx tsc --noEmit && npm run lint && npm test && npm run coverage && npm run build
```

Expected: 0 errors / warnings; coverage ≥ 80%; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy terminal implementation"
```

---

## Phase 6: Playwright Verification (mandatory per CLAUDE.md)

### Task 10: Functional + visual verification

**Stack** (isolated HOME):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

- [ ] **Step 1: Mobile — single scroll surface + #240**

1. `browser_resize` 375×812; navigate http://localhost:13000; `localStorage.clear()`; reload; log in; attach a session.
2. Type `seq 1 500` + Enter to build scrollback.
3. `browser_evaluate`: `() => { const v = document.querySelector('.xterm-viewport'); return { hasOuterScroll: !!document.querySelector('[style*="overflow: auto"]'), viewportScrollTop: v?.scrollTop }; }` — assert **no** oversized outer scroll container (viewport-fit), and the terminal fills the viewport.
4. Tap "Scroll to bottom" → `xterm-viewport.scrollTop` equals max; the newest line (prompt) is visible; no horizontal pan.
5. `browser_console_messages` — no errors.

- [ ] **Step 2: Desktop — no overlay, viewport-fit**

1. `browser_resize` 1280×800; assert scroll buttons absent; terminal fills the viewport.

- [ ] **Step 3: Relay resize round-trip**

1. Force relay mode; resize the browser; verify the tmux pane resizes (via `browser_evaluate` on the terminal cols/rows, or `tmux display-message -p '#{window_width}x#{window_height}'`).

- [ ] **Step 4: Screenshots**

Capture to `.playwright-mcp/screenshots/`: `mobile-viewport-fit.png`, `mobile-scroll-to-bottom.png`, `desktop-viewport-fit.png`.

- [ ] **Step 5: Cleanup**

```bash
pkill -f 'target/debug/nession-(server|agent)'; pkill -f vite
```

---

## Self-Review

- **Spec coverage:** §4 (target arch) → Tasks 1–2; §5 (viewport-fit) → Task 4 + Playwright Step 1; §6 (relay resize) → Tasks 5–6; §7 (#240 scrollback) → Tasks 1–3 + Playwright; §8 (delete list) → Task 9; §10 (5 phases) → Tasks 1–9 map 1:1 to Phases 1–5; multi-client (last-writer-wins) → unchanged behavior, verified in Playwright Step 3.
- **Placeholder scan:** no TBD/TODO. The relay-resize key question was resolved during self-review — the server's `handle_agent_terminal_resize` keys relay clients by the FULL `session_id` (`agent:name`), so Tasks 5–6 carry the full id end-to-end.
- **Type consistency:** `TerminalRuntime` methods (`scrollToBottom`/`scrollPages`/`scrollLines`/`cellDimensions`/`fontSizeManager`/`installMobileInput`) match the accessors `TerminalController` exposes in Task 2; `ResizeController.remeasure()` is defined in Task 2 Step 5 and called from Task 2 Step 2 and Task 4; `ServerClientHandle::send_terminal_resize(session_id, cols, rows)` in Task 5 matches the `(String, u16, u16)` full-id channel shape in Task 6. `FontSizeManager` is constructed with a delegating closure (`() => this.fontSizeCallback()`) so the `onCellSizeChange` setter mutates a plain field, never a private member.
