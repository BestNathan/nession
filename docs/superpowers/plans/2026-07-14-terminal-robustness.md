# Terminal Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 reviewed terminal defects plus wire up renderer selection and a per-agent address-probe cache, so P2P/relay reconnects are visible and non-destructive, renderer is auto-detected/selectable/persisted, and attach never blocks on latency probing.

**Architecture:** Three work lines. **A (connection resilience):** relay reconnect cap → `lost`; P2P reconnect banner + re-attach driven from React observing `connectionState`. **B (probe cache):** server `agents.list` returns `addresses`; a new app-level hook probes each online agent every 5min (bare-handshake ping, no session/attach); `AttachDialog` becomes a cache display + selector. **C (renderer + wiring):** detect WebGL, add a Renderer row to `AttachDialog`, persist to localStorage, pass `deviceProfile`/`targetColumns`/`rendererType` into the engine, and make `Renderer` fall back to Canvas on context-loss. Ride-along fixes: toolbar-disabled consistency, font restore, ResizeObserver debounce, mouse-move-only throttle.

**Tech Stack:** Rust (nession-server, tokio, serde_json), React 19 + TypeScript, xterm.js 5.5, Vitest, Tailwind v4, shadcn/ui.

**Branch:** `feat/terminal-robustness` (already created from latest main).

---

## File Structure

**Work line A — connection resilience:**
- Modify: `web/src/terminal/ConnectionManager.ts` — relay reconnect cap + `lost`; add public `reattach()`.
- Modify: `web/src/terminal/TerminalView.ts` — add `setExternalBanner()` + `reattach()` engine methods.
- Modify: `web/src/components/Terminal.tsx` — observe P2P `connectionState`, drive banner + reattach.
- Test: `web/src/terminal/__tests__/ConnectionManager.test.ts`, `web/src/terminal/__tests__/TerminalView.test.ts`.

**Work line B — probe cache:**
- Modify: `crates/nession-server/src/server/handler.rs:386-409` — add `addresses` to each agent JSON.
- Test: `crates/nession-server/tests/integration_test.rs` — assert `addresses` present.
- Modify: `web/src/types.ts` — `Agent.addresses?: ProbedAddress[]`.
- Create: `web/src/hooks/useAddressProbeCache.ts` — per-agent probe cache + 5min poll.
- Test: `web/src/hooks/__tests__/useAddressProbeCache.test.ts`.
- Modify: `web/src/components/env/AttachDialog.tsx` — read cache, drop live probing, add "Re-test".
- Modify: `web/src/services/websocket.ts` — parse `addresses` in `listAgents()`.

**Work line C — renderer + wiring:**
- Modify: `web/src/terminal/Renderer.ts` — export `detectWebGLSupport()`; context-loss → Canvas.
- Test: `web/src/terminal/__tests__/Renderer.test.ts`.
- Modify: `web/src/services/attachPrefs.ts` — add `renderer` field.
- Test: `web/src/services/__tests__/attachPrefs.test.ts`.
- Modify: `web/src/components/env/AttachDialog.tsx` — Renderer selection row.
- Modify: `web/src/components/env/AttachDialog.tsx` `AttachChoice`, `web/src/components/useAttachFlow.ts`, `web/src/components/TerminalView.tsx` (`AttachedSession`) — thread `renderer` through.
- Modify: `web/src/components/Terminal.tsx` — pass `deviceProfile`, `targetColumns`, `rendererType`.

**Ride-along fixes:**
- Modify: `web/src/components/TerminalView.tsx:159` — add `disabled` to fallback toolbar.
- Modify: `web/src/terminal/ViewportManager.ts` — font restore + ResizeObserver debounce.
- Modify: `web/src/terminal/InputManager.ts` — throttle move events only.
- Test: `web/src/terminal/__tests__/ViewportManager.test.ts`, `web/src/terminal/__tests__/InputManager.test.ts`.

---

## Work Line A — Connection Resilience

### Task 1: Relay reconnect cap → `lost`

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts`
- Test: `web/src/terminal/__tests__/ConnectionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe('Relay mode', ...)` block in `ConnectionManager.test.ts`:

```typescript
    it('transitions to lost after RELAY_MAX_ATTEMPTS and fires onDisconnect', () => {
      const ws = makeMockWs();
      let stateCb: ((status: string) => void) | null = null;
      (ws.onConnectionChange as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (status: string) => void) => { stateCb = cb; return () => {}; },
      );
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws,
      });
      const states: string[] = [];
      const onDisconnect = vi.fn();
      cm.onStateChange = (s) => states.push(s);
      cm.onDisconnect = onDisconnect;

      // 11 disconnect signals: attempts 1..10 reconnecting, the 11th → lost.
      for (let i = 0; i < 11; i++) { stateCb?.('disconnected'); }

      expect(states).toContain('lost');
      expect(states.filter((s) => s === 'reconnecting').length).toBe(10);
      vi.advanceTimersByTime(3000);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      cm.dispose();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/terminal/__tests__/ConnectionManager.test.ts -t "transitions to lost"`
Expected: FAIL — currently only ever emits `reconnecting` (never `lost`).

- [ ] **Step 3: Implement the cap**

In `ConnectionManager.ts`, add the constant near the top of the file (after the `decodeB64` function, before `export class ConnectionManager`):

```typescript
const RELAY_MAX_ATTEMPTS = 10;
```

Replace the `setupRelay` state-change branch (the `onConnectionChange` callback body, currently lines 162-170):

```typescript
    this.relayUnsubState = svc.onConnectionChange((status) => {
      if (this.disposed) { return; }
      if (status === 'disconnected' || status === 'connecting') {
        const next = this.reconnectAttempt + 1;
        if (next > RELAY_MAX_ATTEMPTS) {
          this.setState('lost', RELAY_MAX_ATTEMPTS);
        } else {
          this.setState('reconnecting', next);
        }
      } else if (status === 'authenticated') {
        this.setState('connected', 0);
        this.attach().catch(() => {});
      }
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/terminal/__tests__/ConnectionManager.test.ts`
Expected: PASS (all ConnectionManager tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts web/src/terminal/__tests__/ConnectionManager.test.ts
git commit -m "fix: relay reconnect caps at 10 attempts then transitions to lost (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Engine `reattach()` + `setExternalBanner()`

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts`
- Modify: `web/src/terminal/TerminalView.ts`
- Test: `web/src/terminal/__tests__/ConnectionManager.test.ts`, `web/src/terminal/__tests__/TerminalView.test.ts`

- [ ] **Step 1: Write the failing test for ConnectionManager.reattach**

Add inside `describe('P2P mode', ...)` in `ConnectionManager.test.ts`:

```typescript
    it('reattach re-sends client.attach', async () => {
      const p2p = makeMockP2P();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', p2pConnection: p2p,
      });
      await cm.reattach();
      const send = p2p.sendMessage as ReturnType<typeof vi.fn>;
      const types = send.mock.calls.map((c) => (c[0] as { msg_type: string }).msg_type);
      expect(types).toContain('client.attach');
      cm.dispose();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/terminal/__tests__/ConnectionManager.test.ts -t "reattach"`
Expected: FAIL — `cm.reattach is not a function`.

- [ ] **Step 3: Add reattach() to ConnectionManager**

In `ConnectionManager.ts`, add this public method immediately after the existing `attach()` method (after its closing brace, before `dispose()`):

```typescript
  /** Re-issue attach after a reconnect so tmux redraws the full screen. */
  async reattach(): Promise<void> {
    return this.attach();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/terminal/__tests__/ConnectionManager.test.ts -t "reattach"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for TerminalView methods**

First inspect the existing `TerminalView.test.ts` setup (mocks for xterm) so the new test reuses it. Add this test to `TerminalView.test.ts` (inside the top-level `describe('TerminalView', ...)`):

```typescript
  it('setExternalBanner forwards banner state to onStateChange', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = new TerminalView(container, {
      rendererType: 'canvas',
      connection: { mode: 'p2p', sessionName: 's', sessionId: 'a:s' },
    });
    const states: string[] = [];
    view.onStateChange = (st) => states.push(st.banner);
    view.setExternalBanner('reconnecting', 3);
    view.setExternalBanner('none', 0);
    expect(states).toEqual(['reconnecting', 'none']);
    view.dispose();
    document.body.removeChild(container);
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npx vitest run src/terminal/__tests__/TerminalView.test.ts -t "setExternalBanner"`
Expected: FAIL — `view.setExternalBanner is not a function`.

- [ ] **Step 7: Add setExternalBanner() + reattach() to TerminalView**

In `TerminalView.ts`, add both public methods after `refit()` (before `dispose()`):

```typescript
  /** Push a banner state from an external observer (e.g. React watching P2P). */
  setExternalBanner(banner: 'none' | 'reconnecting' | 'failed', attempt: number): void {
    if (this.isDisposed) { return; }
    this.onStateChange?.({
      banner,
      reconnectAttempt: attempt,
      isConnected: banner === 'none',
    });
  }

  /** Re-issue attach (tmux redraw) after a transport reconnect. */
  reattach(): void {
    if (this.isDisposed) { return; }
    this.connection.reattach().catch(() => {});
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/TerminalView.test.ts src/terminal/__tests__/ConnectionManager.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts web/src/terminal/TerminalView.ts web/src/terminal/__tests__/
git commit -m "feat: engine reattach() + setExternalBanner() for P2P reconnect handling (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Terminal.tsx observes P2P connectionState → banner + reattach

**Files:**
- Modify: `web/src/components/Terminal.tsx`
- Modify: `web/src/terminal/types.ts` (extend `TerminalHandle` if needed — see below; not required, uses viewRef directly)

- [ ] **Step 1: Add the observer effect**

In `Terminal.tsx`, the component receives `p2pConnection` as a prop. Add a new effect after the existing banner-notify effect (after the `useEffect` that calls `onBannerChangeRef.current?.(...)`, around line 50). This effect observes the live P2P `connectionState` and drives the engine imperatively:

```typescript
  // Observe P2P transport reconnects. connectionState is a getter (no re-render
  // on change), but this component re-renders whenever the owner does, and the
  // owner (via useP2PWithFallback) re-renders on every P2P state transition —
  // so reading it here in an effect keyed on the value tracks it correctly.
  const p2pState = p2pConnection?.connectionState;
  const prevP2pStateRef = useRef(p2pState);
  useEffect(() => {
    if (mode !== 'p2p') { return; }
    const view = viewRef.current;
    if (!view) { return; }
    const prev = prevP2pStateRef.current;
    prevP2pStateRef.current = p2pState;

    if (p2pState === 'reconnecting') {
      view.setExternalBanner('reconnecting', p2pConnection?.reconnectAttempt ?? 0);
    } else if (p2pState === 'connected' && prev === 'reconnecting') {
      // Transport came back after a drop: clear banner and redraw tmux.
      view.setExternalBanner('none', 0);
      view.reattach();
    }
    // 'disconnected' is handled by useP2PWithFallback (address rotation / relay).
  }, [mode, p2pState, p2pConnection]);
```

Note: `viewRef` currently holds a `TerminalView` instance. `setExternalBanner`/`reattach` were added in Task 2. This effect must appear **after** the terminal-creation effect defines `viewRef`, but React runs effects in order — since `viewRef` is a ref (not a dependency), ordering of definition doesn't matter, only that the ref is populated. Place it directly after the banner-notify effect for readability.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (`viewRef.current` is `TerminalView | null`; the new methods exist on `TerminalView`.)

- [ ] **Step 3: Manual reasoning check (no unit test — integration covered by Playwright)**

The imperative effect is hard to unit-test without a full xterm mount. Confirm by reading: on `reconnecting` it sets the banner; on recovery (`connected` after `reconnecting`) it clears and reattaches. The dependency array excludes callback refs (kept stable) and includes only `mode`, `p2pState`, `p2pConnection` — none of which change on unrelated re-renders (connection object is identity-stable per useP2PConnection's useMemo). So the terminal is NOT rebuilt on reconnect.

- [ ] **Step 4: Build + lint**

Run: `cd web && npm run build && npm run lint`
Expected: build succeeds, 0 lint warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "feat: show P2P reconnect banner and reattach on recovery without rebuild (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Work Line C — Renderer detection, context-loss fallback, wiring

(Ordered before Work Line B because B's AttachDialog changes and C's AttachDialog changes touch the same file; doing C's renderer row first, then B's cache display, avoids conflicting edits.)

### Task 4: Renderer — export detectWebGLSupport() + Canvas fallback on context-loss

**Files:**
- Modify: `web/src/terminal/Renderer.ts`
- Test: `web/src/terminal/__tests__/Renderer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `Renderer.test.ts`:

```typescript
  it('exports detectWebGLSupport returning a boolean', async () => {
    const { detectWebGLSupport } = await import('../Renderer');
    expect(typeof detectWebGLSupport()).toBe('boolean');
    // jsdom has no WebGL context.
    expect(detectWebGLSupport()).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/terminal/__tests__/Renderer.test.ts -t "detectWebGLSupport"`
Expected: FAIL — export missing.

- [ ] **Step 3: Refactor supportsWebGL into an exported function + context-loss fallback**

In `Renderer.ts`, replace the whole file body with:

```typescript
import type { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

/** Check whether the runtime supports WebGL rendering. */
export function detectWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl') || canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

export class Renderer {
  type: 'webgl' | 'canvas';

  constructor(private term: Terminal, preferred?: 'webgl' | 'canvas') {
    if (preferred === 'webgl' && detectWebGLSupport()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.fallbackToCanvas();
        });
        term.loadAddon(webgl);
        this.type = 'webgl';
        return;
      } catch {
        console.warn('[Renderer] WebGL unavailable, falling back to Canvas');
      }
    }
    term.loadAddon(new CanvasAddon());
    this.type = 'canvas';
  }

  /** Load the Canvas renderer after a WebGL context loss so the terminal
   *  keeps rendering instead of relying on xterm's implicit DOM fallback. */
  private fallbackToCanvas(): void {
    try {
      this.term.loadAddon(new CanvasAddon());
      this.type = 'canvas';
    } catch {
      /* terminal disposed mid-loss — nothing to do */
    }
  }
}
```

Note: `type` changed from `readonly` to mutable because context-loss now updates it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/Renderer.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Update TerminalView to use the exported helper (remove dead private)**

`TerminalView.ts` constructs `new Renderer(this.terminal, options.rendererType)` — unchanged. No edit needed here. Verify nothing else imported the old private static:

Run: `cd web && rtk grep -rn "supportsWebGL" src/`
Expected: no matches (it was private). If any, replace with `detectWebGLSupport()`.

- [ ] **Step 6: Commit**

```bash
git add web/src/terminal/Renderer.ts web/src/terminal/__tests__/Renderer.test.ts
git commit -m "feat: export detectWebGLSupport() and fall back to Canvas on WebGL context loss (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: attachPrefs — persist renderer choice

**Files:**
- Modify: `web/src/services/attachPrefs.ts`
- Test: `web/src/services/__tests__/attachPrefs.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `attachPrefs.test.ts`:

```typescript
  it('defaults renderer to webgl', () => {
    expect(loadAttachPrefs().renderer).toBe('webgl');
  });

  it('round-trips saved renderer', () => {
    saveAttachPrefs({ mode: 'auto', renderer: 'canvas' });
    expect(loadAttachPrefs().renderer).toBe('canvas');
  });

  it('falls back to webgl for an invalid stored renderer', () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'auto', renderer: 'bogus' }));
    expect(loadAttachPrefs().renderer).toBe('webgl');
  });
```

Also update the existing `returns defaults when nothing stored` test to expect the new shape:

```typescript
  it('returns defaults when nothing stored', () => {
    expect(loadAttachPrefs()).toEqual({ mode: 'auto', renderer: 'webgl' });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/services/__tests__/attachPrefs.test.ts`
Expected: FAIL — `renderer` undefined.

- [ ] **Step 3: Add renderer field**

Replace `attachPrefs.ts` body with:

```typescript
import type { AttachMode } from '../types';

const STORAGE_KEY = 'nession_attach_prefs';

export type RendererType = 'webgl' | 'canvas';

export interface AttachPrefs {
  mode: AttachMode;
  renderer: RendererType;
}

const DEFAULT_PREFS: AttachPrefs = { mode: 'auto', renderer: 'webgl' };

function isAttachMode(v: unknown): v is AttachMode {
  return v === 'auto' || v === 'p2p' || v === 'relay';
}

function isRenderer(v: unknown): v is RendererType {
  return v === 'webgl' || v === 'canvas';
}

/** Read last-used attach prefs from localStorage, falling back to defaults. */
export function loadAttachPrefs(): AttachPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<AttachPrefs>;
    return {
      mode: isAttachMode(parsed.mode) ? parsed.mode : 'auto',
      renderer: isRenderer(parsed.renderer) ? parsed.renderer : 'webgl',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist attach prefs for next time. Failures are non-fatal. */
export function saveAttachPrefs(prefs: AttachPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}
```

- [ ] **Step 4: Fix existing caller in useAttachFlow.ts**

`useAttachFlow.ts` calls `saveAttachPrefs({ mode: choice.mode })` — now missing `renderer`. Update it (this is completed fully in Task 8; for now make it compile):

Run: `cd web && npx tsc --noEmit`
If it errors on `saveAttachPrefs({ mode: choice.mode })`, change that line to `saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });` — `choice.renderer` is added to `AttachChoice` in Task 8. If Task 8 not yet done, temporarily use `saveAttachPrefs({ mode: choice.mode, renderer: 'webgl' });` and note it gets finalized in Task 8.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/services/__tests__/attachPrefs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/services/attachPrefs.ts web/src/services/__tests__/attachPrefs.test.ts web/src/components/useAttachFlow.ts
git commit -m "feat: persist renderer choice in attachPrefs (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Terminal.tsx passes deviceProfile, targetColumns, rendererType

**Files:**
- Modify: `web/src/components/Terminal.tsx`
- Modify: `web/src/terminal/types.ts` (add `renderer` to `TerminalProps`)

- [ ] **Step 1: Add renderer prop to TerminalProps**

In `types.ts`, add to `TerminalProps` interface:

```typescript
  /** Renderer chosen at attach; forced to 'canvas' if WebGL unsupported. */
  renderer?: 'webgl' | 'canvas';
```

- [ ] **Step 2: Wire the options in Terminal.tsx**

In `Terminal.tsx`, import the profile detector at top:

```typescript
import { detectProfile } from '../terminal';
```

Destructure `renderer` from props (add to the existing prop destructure list):

```typescript
    renderer,
```

In the terminal-creation effect, replace the `new TerminalView(...)` options object so it passes a measured device profile, the renderer type, and target columns:

```typescript
    const profile = detectProfile(container.clientWidth || window.innerWidth);
    const view = new TerminalView(container, {
      rendererType: renderer ?? 'canvas',
      deviceProfile: profile,
      targetColumns: 80,
      connection: connOpts,
    });
```

Add `renderer` to the effect's dependency array (so switching renderer rebuilds the engine — acceptable, only happens on a fresh attach):

```typescript
  }, [sessionId, sessionName, mode, p2pConnection, serverConnection, renderer]);
```

- [ ] **Step 3: Wire targetColumns into TerminalView engine**

`TerminalView.ts` receives `options.targetColumns` but currently ignores it. In its constructor, after creating `this.viewport`, add:

```typescript
    if (options.targetColumns) {
      this.viewport.setTargetColumns(options.targetColumns);
    }
```

- [ ] **Step 4: Verify TypeScript + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 5: Run terminal engine tests**

Run: `cd web && npx vitest run src/terminal/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/terminal/types.ts web/src/terminal/TerminalView.ts
git commit -m "fix: pass deviceProfile/targetColumns/rendererType into terminal engine (#51)

Prevents first-frame font flash (clientWidth=0 mis-detecting phone),
activates WebGL renderer selection, and wires the previously-dead
targetColumns option.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Work Line B — Address probe cache

### Task 7: Server — agents.list returns addresses

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs:386-409`
- Test: `crates/nession-server/tests/integration_test.rs`

- [ ] **Step 1: Write the failing test**

In `integration_test.rs`, extend `test_client_agents_list_returns_registered_agents` (add assertions after the existing `status` assertion at line 1006):

```rust
    // agents.list now carries the probed address list (issue #51) so clients
    // can latency-probe without an attach round-trip.
    let addresses = agents[0]["addresses"].as_array().unwrap();
    assert!(!addresses.is_empty(), "expected synthesized address from ip/port");
    assert!(addresses[0]["url"].as_str().unwrap().contains("10.0.0.50"));
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p nession-server --test integration_test test_client_agents_list_returns_registered_agents`
Expected: FAIL — `addresses` is Null (`.as_array()` unwrap panics).

- [ ] **Step 3: Add addresses to the agent JSON**

In `handler.rs`, in `handle_client_agents_list`, the `agents_json` map closure (lines 388-408) builds each agent object. Add an `addresses` field. Replace the `json!({ ... })` inside `.map(|a| { ... })` to include:

```rust
                json!({
                    "agent_id": a.agent_id,
                    "hostname": a.hostname,
                    "ip_address": a.ip_address,
                    "port": a.port,
                    "status": match a.status {
                        AgentStatus::Online => "online",
                        AgentStatus::Offline => "offline",
                        AgentStatus::Degraded => "degraded",
                    },
                    "session_count": a.session_count,
                    "active_sessions": a.active_sessions,
                    "last_heartbeat": a.last_heartbeat.to_rfc3339(),
                    "addresses": serde_json::to_value(&a.addresses).unwrap_or(json!([])),
                    "metadata": {
                        "nession_version": a.metadata.nession_version,
                        "tmux_version": a.metadata.tmux_version,
                        "os_version": a.metadata.os_version,
                    },
                })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-server --test integration_test test_client_agents_list_returns_registered_agents`
Expected: PASS.

- [ ] **Step 5: Clippy + fmt**

Run: `cargo clippy -p nession-server -- -D warnings && cargo fmt --all -- --check`
Expected: 0 warnings, formatting clean.

- [ ] **Step 6: Commit**

```bash
git add crates/nession-server/src/server/handler.rs crates/nession-server/tests/integration_test.rs
git commit -m "feat: agents.list returns probed addresses for client-side latency probing (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: web types + websocket.listAgents parse addresses; AttachChoice.renderer

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/services/websocket.ts`
- Modify: `web/src/components/env/AttachDialog.tsx` (`AttachChoice`)
- Modify: `web/src/components/useAttachFlow.ts`
- Modify: `web/src/components/TerminalView.tsx` (`AttachedSession`)

- [ ] **Step 1: Add addresses to Agent type**

In `types.ts`, add to the `Agent` interface (after `metadata`):

```typescript
  /** Candidate P2P endpoints with server probe status (issue #51). Empty for
   *  legacy servers that don't yet send them in agents.list. */
  addresses?: ProbedAddress[];
```

`ProbedAddress` is already defined in this file — no import needed.

- [ ] **Step 2: Verify listAgents passes addresses through**

`websocket.ts` `listAgents()` returns `response.agents` typed as `Agent[]`. Since parsing is structural (JSON → typed), no code change is needed if `AgentsListResponse.agents` is `Agent[]`. Confirm:

Run: `cd web && rtk grep -n "AgentsListResponse" src/services/websocket.ts src/types.ts`

If `AgentsListResponse.agents` is `Agent[]`, the new `addresses` field flows through automatically. No edit. If it's a narrower inline type, add `addresses?: ProbedAddress[]` to it.

- [ ] **Step 3: Add renderer to AttachChoice**

In `AttachDialog.tsx`, add to the `AttachChoice` interface:

```typescript
  /** Renderer the user picked (webgl/canvas). */
  renderer: 'webgl' | 'canvas';
```

- [ ] **Step 4: Thread renderer through useAttachFlow → AttachedSession**

In `TerminalView.tsx`, add to `AttachedSession` interface:

```typescript
  /** Renderer chosen in the attach dialog. */
  renderer?: 'webgl' | 'canvas';
```

In `useAttachFlow.ts` `confirmAttach`, set it on the attached session and persist it:

```typescript
  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachDialogSession(null);
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    setAttachedSession({
      sessionId: session.session_id,
      sessionName: session.session_name,
      attachInfo: choice.attachInfo,
      orderedUrls: choice.orderedUrls,
      latencies: choice.latencies,
      selectedAddress: choice.selectedUrl ?? undefined,
      renderer: choice.renderer,
    });
    setView('terminal');
  }, []);
```

In `TerminalView.tsx`, pass it to `<Terminal>` (add the prop in the `terminalElement` JSX):

```typescript
      renderer={session.renderer}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/services/websocket.ts web/src/components/env/AttachDialog.tsx web/src/components/useAttachFlow.ts web/src/components/TerminalView.tsx
git commit -m "feat: thread agent addresses and renderer choice through attach flow (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: useAddressProbeCache hook

**Files:**
- Create: `web/src/hooks/useAddressProbeCache.ts`
- Test: `web/src/hooks/__tests__/useAddressProbeCache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/__tests__/useAddressProbeCache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAddressProbeCache } from '../useAddressProbeCache';
import type { Agent } from '../../types';

vi.mock('../../services/addressSelection', () => ({
  testAddresses: vi.fn(async (addrs: { url: string }[]) =>
    addrs.map((a) => ({ url: a.url, latencyMs: 42 })),
  ),
  orderByLatency: (results: { url: string; latencyMs: number | null }[]) =>
    results.map((r) => r.url),
}));

function agent(id: string, urls: string[]): Agent {
  return {
    agent_id: id, hostname: id, ip_address: '10.0.0.1', port: 8080,
    status: 'online', session_count: 0, last_heartbeat: new Date().toISOString(),
    addresses: urls.map((url) => ({
      url, network_type: 'lan' as const, priority: 0, status: 'unknown' as const,
    })),
  };
}

describe('useAddressProbeCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probes online agents and caches per-agent results', async () => {
    const agents = [agent('a1', ['ws://x/ws'])];
    const { result } = renderHook(() => useAddressProbeCache(agents));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const probe = result.current.getProbe('a1');
    expect(probe?.orderedUrls).toEqual(['ws://x/ws']);
    expect(probe?.latencies[0].latencyMs).toBe(42);
  });

  it('getProbe returns undefined for an unprobed agent', async () => {
    const { result } = renderHook(() => useAddressProbeCache([]));
    expect(result.current.getProbe('missing')).toBeUndefined();
  });

  it('re-probes on the 5-minute interval', async () => {
    const { testAddresses } = await import('../../services/addressSelection');
    const agents = [agent('a1', ['ws://x/ws'])];
    renderHook(() => useAddressProbeCache(agents));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const firstCalls = (testAddresses as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect((testAddresses as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(firstCalls);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/hooks/__tests__/useAddressProbeCache.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Create `web/src/hooks/useAddressProbeCache.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AddressLatency } from '../types';
import { testAddresses, orderByLatency } from '../services/addressSelection';

/** One agent's cached browser-latency probe. */
export interface AgentProbe {
  latencies: AddressLatency[];
  orderedUrls: string[];
  probedAt: number;
}

export interface AddressProbeCache {
  /** Read a fresh (< TTL) probe for an agent, or undefined. */
  getProbe: (agentId: string) => AgentProbe | undefined;
  /** Force a re-probe of one agent now. */
  refreshAgent: (agentId: string) => void;
}

const POLL_INTERVAL_MS = 5 * 60_000;
const TTL_MS = 5 * 60_000;

/**
 * App-level per-agent address probe cache (issue #51).
 *
 * On login and every 5 minutes, latency-probes every online agent's advertised
 * addresses directly from the browser (bare WebSocket handshake — no session,
 * no attach). AttachDialog reads this cache so attach never blocks on probing.
 * Probes that fail are not cached (retried next cycle); entries older than the
 * TTL are treated as stale and not returned.
 *
 * `now` is injectable for tests; defaults to Date.now.
 */
export function useAddressProbeCache(
  agents: Agent[],
  now: () => number = Date.now,
): AddressProbeCache {
  const [cache, setCache] = useState<Map<string, AgentProbe>>(new Map());

  // Keep the latest agents list in a ref so the interval callback reads current
  // data without being re-created (which would reset the timer each render).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const probeAgent = useCallback(async (a: Agent) => {
    const addresses = a.addresses ?? [];
    if (a.status !== 'online' || addresses.length === 0) { return; }
    const latencies = await testAddresses(addresses);
    const reachable = latencies.some((l) => l.latencyMs !== null);
    if (!reachable) { return; } // failure — don't cache, retry next cycle
    const orderedUrls = orderByLatency(latencies);
    setCache((prev) => {
      const next = new Map(prev);
      next.set(a.agent_id, { latencies, orderedUrls, probedAt: now() });
      return next;
    });
  }, [now]);

  const probeAll = useCallback(() => {
    for (const a of agentsRef.current) {
      if (a.status === 'online' && (a.addresses?.length ?? 0) > 0) {
        void probeAgent(a);
      }
    }
  }, [probeAgent]);

  // Initial probe + 5-minute polling.
  useEffect(() => {
    probeAll();
    const timer = setInterval(probeAll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [probeAll]);

  const getProbe = useCallback(
    (agentId: string): AgentProbe | undefined => {
      const entry = cache.get(agentId);
      if (!entry) { return undefined; }
      if (now() - entry.probedAt > TTL_MS) { return undefined; } // stale
      return entry;
    },
    [cache, now],
  );

  const refreshAgent = useCallback(
    (agentId: string) => {
      const a = agentsRef.current.find((x) => x.agent_id === agentId);
      if (a) { void probeAgent(a); }
    },
    [probeAgent],
  );

  return { getProbe, refreshAgent };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/__tests__/useAddressProbeCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `cd web && npm run lint`
Expected: 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/useAddressProbeCache.ts web/src/hooks/__tests__/useAddressProbeCache.test.ts
git commit -m "feat: per-agent address probe cache with 5min polling (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Wire the cache into the app and pass to AttachDialog

**Files:**
- Modify: `web/src/components/Dashboard.tsx` (owns the agents list — inspect first)
- Modify: `web/src/components/env/AttachDialog.tsx` (accept probe prop)

- [ ] **Step 1: Inspect where agents + AttachDialog live**

Run: `cd web && rtk grep -n "AttachDialog\|useAddressProbeCache\|listAgents\|agents" src/components/Dashboard.tsx | head -30`

Identify the component that (a) holds the `agents: Agent[]` state and (b) renders `<AttachDialog>`. This is where `useAddressProbeCache(agents)` is called and its `getProbe`/`refreshAgent` are passed down.

- [ ] **Step 2: Instantiate the cache at the agents-list owner**

In the component that owns `agents` (Dashboard or its container), add:

```typescript
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
```

```typescript
  const probeCache = useAddressProbeCache(agents);
```

Pass `probeCache` down to wherever `<AttachDialog>` is rendered (via props through the chain — add a `probeCache: AddressProbeCache` prop to intermediate components as needed).

- [ ] **Step 3: Add probeCache prop to AttachDialog**

In `AttachDialog.tsx`, add to `AttachDialogProps`:

```typescript
  /** Per-agent latency cache; supplies probe data without live testing. */
  probeCache: import('../../hooks/useAddressProbeCache').AddressProbeCache;
```

- [ ] **Step 4: TypeScript compiles (integration wired in next task)**

Run: `cd web && npx tsc --noEmit`
Expected: errors ONLY where `<AttachDialog>` is rendered without the new required prop. Add `probeCache={probeCache}` at each call site. Re-run until clean.

- [ ] **Step 5: Build + lint**

Run: `cd web && npm run build && npm run lint`
Expected: succeeds, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/
git commit -m "feat: instantiate address probe cache and pass to AttachDialog (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: AttachDialog reads cache, drops live probing, adds Renderer row + Re-test

**Files:**
- Modify: `web/src/components/env/AttachDialog.tsx`
- Test: `web/src/components/env/__tests__/AttachDialog.test.tsx`

- [ ] **Step 1: Read the existing AttachDialog test to reuse mocks**

Run: `cd web && sed -n '1,60p' src/components/env/__tests__/AttachDialog.test.tsx`

Note the existing render helper and how `wsService`/`session` are mocked, so the new tests match the file's style.

- [ ] **Step 2: Write failing tests**

Add to `AttachDialog.test.tsx` (adapt the render helper name to the file's existing one):

```typescript
  it('shows cached latency without live probing', async () => {
    const probeCache = {
      getProbe: vi.fn().mockReturnValue({
        latencies: [{ url: 'ws://lan/ws', latencyMs: 12 }],
        orderedUrls: ['ws://lan/ws'],
        probedAt: Date.now(),
      }),
      refreshAgent: vi.fn(),
    };
    // render with probeCache (use the file's render helper + a p2p session
    // whose agent has addresses:[{url:'ws://lan/ws',...}])
    // ...assert '12ms' appears and no 'Testing…' spinner is shown.
  });

  it('re-test button calls refreshAgent', async () => {
    const probeCache = { getProbe: vi.fn().mockReturnValue(undefined), refreshAgent: vi.fn() };
    // render, click the "Re-test" button, expect probeCache.refreshAgent called
    // with the session's agent_id.
  });

  it('renders a Renderer row with WebGL and Canvas options', async () => {
    // render; expect buttons/labels 'WebGL' and 'Canvas' present.
  });
```

Fill in the render calls to match the existing helper in the file (it already constructs `session`, `wsService`, `onConfirm`). Extract `agent_id` from `session.session_id` (`"agent_id:session_name"`).

- [ ] **Step 3: Run to verify failure**

Run: `cd web && npx vitest run src/components/env/__tests__/AttachDialog.test.tsx`
Expected: FAIL — probeCache prop unused, no Renderer row, no Re-test button.

- [ ] **Step 4: Refactor AttachDialog**

Make these changes in `AttachDialog.tsx`:

1. Add `probeCache` and derive `agentId` from `session`:

```typescript
export function AttachDialog({ isOpen, onClose, session, wsService, onConfirm, probeCache }: AttachDialogProps) {
```

```typescript
  const agentId = session?.agent_id ?? session?.session_id.split(':')[0] ?? null;
```

2. Add renderer state, seeded from prefs + WebGL support:

```typescript
import { detectWebGLSupport } from '../../terminal/Renderer';
```

```typescript
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('webgl');
  const webglSupported = detectWebGLSupport();
```

In the per-open reset effect, seed renderer from prefs (clamped to support):

```typescript
    const prefs = loadAttachPrefs();
    setMode(prefs.mode === 'relay' ? 'auto' : prefs.mode);
    setRenderer(webglSupported ? prefs.renderer : 'canvas');
```

3. Replace the address-testing effect. The dialog still calls `requestAttach` to get `attachInfo` (token + addresses) but NO LONGER calls `testAddresses`. Latency comes from the cache:

```typescript
  useEffect(() => {
    if (!isOpen || !session) { return; }
    let cancelled = false;
    setError(null);
    setAttachInfo(null);
    void (async () => {
      try {
        const info = await wsService.requestAttach(session.session_id, 'p2p');
        if (!cancelled) { setAttachInfo(info); }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to query agent addresses');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, session, wsService]);
```

4. Derive latency + order from the cache (fall back to empty):

```typescript
  const cached = agentId ? probeCache.getProbe(agentId) : undefined;
  const results: AddressLatency[] = cached?.latencies ?? [];
  const orderedUrls = cached?.orderedUrls ?? [];
  const bestUrl = orderedUrls[0] ?? null;
  const latencyByUrl = new Map(results.map((r) => [r.url, r.latencyMs]));
```

Remove the now-unused `testing`/`setResults`/`setTesting` state and the `testAddresses`/`orderByLatency` imports (keep `orderByLatency` only if still referenced — it is not, now). Remove `results` state (replaced by `cached`).

5. Update `handleConfirm` to include renderer and cache-derived data:

```typescript
  const handleConfirm = useCallback(() => {
    if (!session || !attachInfo) { return; }
    const manual = selectedUrl === AUTO_URL ? null : selectedUrl;
    onConfirm(session, { mode, attachInfo, orderedUrls, latencies: results, selectedUrl: manual, renderer });
  }, [session, attachInfo, selectedUrl, orderedUrls, results, mode, renderer, onConfirm]);
```

6. Add a Renderer row + a Re-test button in the JSX (after the Connection Path block, before the `error` line):

```tsx
          <div className="space-y-2">
            <Label>Renderer</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRenderer('webgl')}
                disabled={!webglSupported}
                className={cn(
                  'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                  renderer === 'webgl' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
                  !webglSupported && 'opacity-50 cursor-not-allowed',
                )}
              >
                <span className="text-sm font-medium">WebGL</span>
                <span className="text-[10px] text-muted-foreground leading-tight">
                  {webglSupported ? 'GPU-accelerated' : 'not supported'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRenderer('canvas')}
                className={cn(
                  'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                  renderer === 'canvas' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
                )}
              >
                <span className="text-sm font-medium">Canvas</span>
                <span className="text-[10px] text-muted-foreground leading-tight">compatibility</span>
              </button>
            </div>
          </div>
```

For the Re-test control, add a small button in the Connection Path header (inside `PathList`, or pass an `onRetest` prop). Simplest: add next to the `<Label>Connection Path</Label>` a button when `agentId` is set:

```tsx
            {agentId ? (
              <button
                type="button"
                onClick={() => probeCache.refreshAgent(agentId)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline"
              >
                Re-test
              </button>
            ) : null}
```

(Thread `agentId`, `probeCache`, `latencyByUrl`, `bestUrl` into `PathList` as props, or inline the list in the main component. Keep the existing `AddressRow`/`PathList` structure; just source latency from the cache and add the Re-test button.)

7. The Attach button's `disabled` no longer depends on `testing` (removed): `disabled={!attachInfo}`, label always `'Attach'`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/env/__tests__/AttachDialog.test.tsx`
Expected: PASS.

- [ ] **Step 6: TypeScript + build + lint**

Run: `cd web && npx tsc --noEmit && npm run build && npm run lint`
Expected: no errors, 0 warnings. Fix any unused-import lint errors from the removed `testAddresses`/`testing` code.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/env/AttachDialog.tsx web/src/components/env/__tests__/AttachDialog.test.tsx
git commit -m "feat: AttachDialog reads probe cache, adds Renderer row + Re-test, drops live probing (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Ride-Along Fixes

### Task 12: Toolbar disabled consistency (problem 4)

**Files:**
- Modify: `web/src/components/TerminalView.tsx:159`

- [ ] **Step 1: Add disabled prop to the fallback-branch toolbar**

In `TerminalView.tsx`, the non-fileOps branch renders `<TerminalToolbar sendText={...} />` without `disabled`. Change it to match the fileOps branch:

```tsx
              <TerminalToolbar
                sendText={(text) => terminalRef.current?.sendText(text)}
                disabled={toolbarDisabled}
              />
```

- [ ] **Step 2: Build + lint**

Run: `cd web && npm run build && npm run lint`
Expected: succeeds, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TerminalView.tsx
git commit -m "fix: disable toolbar during reconnect in the no-fileOps layout branch (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: ViewportManager — font restore + ResizeObserver debounce (problems 6, 7)

**Files:**
- Modify: `web/src/terminal/ViewportManager.ts`
- Test: `web/src/terminal/__tests__/ViewportManager.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `ViewportManager.test.ts`:

```typescript
  it('debounces ResizeObserver callbacks via rAF (single fit per frame)', async () => {
    const manager = new ViewportManager(term, fitAddon, container);
    const fitSpy = vi.spyOn(fitAddon, 'fit');
    fitSpy.mockClear();
    // Simulate the ResizeObserver firing several times in one frame.
    const ro = (manager as unknown as { observer: { callback: ResizeObserverCallback } }).observer;
    ro.callback?.([], {} as ResizeObserver);
    ro.callback?.([], {} as ResizeObserver);
    ro.callback?.([], {} as ResizeObserver);
    await new Promise((r) => requestAnimationFrame(r));
    expect(fitSpy.mock.calls.length).toBeLessThanOrEqual(1);
    manager.dispose();
  });

  it('restores font size upward when the container widens within a profile', () => {
    const manager = new ViewportManager(term, fitAddon, container);
    // Force a shrink first.
    (manager as unknown as { profile: { fontSize: number } }).profile.fontSize = 14;
    term.options.fontSize = 10;
    Object.defineProperty(term, 'cols', { value: 120, configurable: true });
    (manager as unknown as { targetCols: number }).targetCols = 80;
    (manager as unknown as { scaleFont: () => void }).scaleFont();
    expect(term.options.fontSize).toBe(14); // restored toward profile max
    manager.dispose();
  });
```

Note: `MockResizeObserver` in this test file does not store the callback for retrieval. Update it so the test can invoke it:

```typescript
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
```

(Already present — the `observer` field on ViewportManager holds this instance; the cast in the test reads `.callback`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/terminal/__tests__/ViewportManager.test.ts -t "debounces|restores font"`
Expected: FAIL — no rAF coalescing; scaleFont only shrinks.

- [ ] **Step 3: Implement debounce + font restore**

In `ViewportManager.ts`:

Add a rAF handle field:

```typescript
  private rafHandle: number | null = null;
```

Replace the ResizeObserver construction so callbacks coalesce into one rAF:

```typescript
    this.observer = new ResizeObserver(() => {
      if (this.disposed) { return; }
      if (this.rafHandle !== null) { return; }
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        if (!this.disposed) { this.fit(); }
      });
    });
    this.observer.observe(container);
```

In `dispose()`, cancel a pending frame:

```typescript
  dispose(): void {
    this.disposed = true;
    if (this.rafHandle !== null) { cancelAnimationFrame(this.rafHandle); this.rafHandle = null; }
    this.observer.disconnect();
    this.wheelCleanup?.();
    this.wheelCleanup = null;
  }
```

Rewrite `scaleFont()` so it restores upward as well as shrinking. Replace the whole method:

```typescript
  private scaleFont(): void {
    const currentFont = this.term.options.fontSize ?? FONT_MAX;
    const cols = this.term.cols;
    const profileFont = this.profile.fontSize;

    // Wide enough to hit target columns: restore toward the profile font size.
    if (cols >= this.targetCols) {
      if (currentFont < profileFont) {
        this.term.options.fontSize = profileFont;
        this.reflowAfterFontChange();
      }
      return;
    }

    // Too narrow: shrink so more columns fit, down to FONT_MIN.
    if (currentFont <= FONT_MIN) { return; }
    const newFont = Math.max(FONT_MIN, Math.round(currentFont * cols / this.targetCols));
    if (newFont >= currentFont) { return; }
    this.term.options.fontSize = newFont;
    this.reflowAfterFontChange();
  }

  /** Re-fit after a font-size change, two rAFs out so xterm applies metrics. */
  private reflowAfterFontChange(): void {
    requestAnimationFrame(() => {
      if (this.disposed) { return; }
      requestAnimationFrame(() => {
        if (this.disposed) { return; }
        try { this.fitAddon.fit(); } catch { /* ignore */ }
      });
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/ViewportManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ViewportManager.ts web/src/terminal/__tests__/ViewportManager.test.ts
git commit -m "fix: debounce ResizeObserver via rAF and restore font size on widen (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: InputManager — throttle mouse-move only (problem 8)

**Files:**
- Modify: `web/src/terminal/InputManager.ts`
- Test: `web/src/terminal/__tests__/InputManager.test.ts`

- [ ] **Step 1: Read the existing test to match style**

Run: `cd web && sed -n '1,50p' src/terminal/__tests__/InputManager.test.ts`

- [ ] **Step 2: Write failing test**

Add to `InputManager.test.ts` (adapt to the file's existing term-mock helper):

```typescript
  it('passes mouse button press/release through immediately (only motion is throttled)', () => {
    // SGR mouse press = "\x1b[<0;10;10M", release = "\x1b[<0;10;10m",
    // motion = "\x1b[<35;10;10M". Press/release must not be delayed.
    const received: string[] = [];
    const term = makeMockTerm(); // existing helper in this file
    const im = new InputManager(term);
    im.onData((d) => received.push(d));
    emitData(term, '\x1b[<0;10;10M');  // press — immediate
    expect(received).toContain('\x1b[<0;10;10M');
    im.dispose();
  });
```

If the file has no `makeMockTerm`/`emitData` helpers, use the same construction the existing tests use (they capture `term.onData`'s callback). Match the file exactly.

- [ ] **Step 3: Run to verify failure**

Run: `cd web && npx vitest run src/terminal/__tests__/InputManager.test.ts -t "press/release"`
Expected: FAIL — press currently goes through the throttle (delayed under fake timers) or is treated as generic mouse data.

- [ ] **Step 4: Narrow the throttle to motion events**

In `InputManager.ts`, replace `isMouseEvent` with a motion-specific check. SGR motion events have bit 5 (32) set in the button code (e.g. `\x1b[<35;...`); press/release/wheel do not carry the motion flag the same way. Simplest robust rule: only throttle SGR sequences whose button parameter has the 32 (motion) bit set.

```typescript
/** SGR mouse motion events carry the 0x20 (32) "motion" bit in the button code
 *  (e.g. "\x1b[<35;..."). Only these are throttled; press/release/wheel are
 *  passed through immediately so quick clicks are never delayed or merged. */
function isMouseMotion(data: string): boolean {
  const m = /^\x1b\[<(\d+);/.exec(data);
  if (!m) { return false; }
  const button = Number(m[1]);
  return (button & 32) === 32;
}
```

In the `term.onData` handler, swap the branch:

```typescript
      if (isMouseMotion(data)) {
        this.sendMouseData(data);
      } else {
        for (const cb of this.dataCallbacks) {
          cb(data);
        }
      }
```

Remove the old `isMouseEvent` function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/InputManager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/terminal/InputManager.ts web/src/terminal/__tests__/InputManager.test.ts
git commit -m "fix: throttle only mouse-motion events so clicks are never delayed (#51)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Verification

### Task 15: Full gate + Playwright screenshots

- [ ] **Step 1: Rust gate**

Run: `cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check`
Expected: all pass, 0 warnings.

- [ ] **Step 2: Web gate**

Run: `cd web && npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: 0 TS errors, 0 lint warnings, all tests pass, build succeeds.

- [ ] **Step 3: Coverage check**

Run: `cd web && npm run coverage`
Expected: ≥ 80% threshold holds.

- [ ] **Step 4: Start the local demo stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

- [ ] **Step 5: Playwright MCP screenshots**

Navigate to `http://localhost:13000`, log in, and capture (save to `.playwright-mcp/screenshots/`):
1. AttachDialog showing cached latency + Renderer row (WebGL/Canvas).
2. AttachDialog with Re-test button.
3. Terminal attached (verify no first-frame font flash — reload and observe).
4. P2P reconnect banner (kill agent briefly, observe "Reconnecting…").
5. Relay "Connection lost" banner (force relay + drop server past cap).

- [ ] **Step 6: Clean up demo stack**

```bash
pkill -f 'target/debug/nession-(server|agent)'; pkill -f vite
```

- [ ] **Step 7: Push + open PR**

```bash
git push -u origin feat/terminal-robustness
gh pr create --title "feat: terminal robustness — reconnect visibility, probe cache, renderer selection (#51)" --body "$(cat <<'EOF'
Closes #51

## 概述
终端健壮性 epic:修复 9 项审查发现 + 渲染器探测/选择/持久化 + 地址探测前移。

## 工作线
- **A 连接健壮性**: relay 重连上限→lost;P2P 重连横幅 + 恢复后重新 attach(不重建、不丢滚动历史)。
- **B 地址探测前移**: server `agents.list` 返回 addresses;`useAddressProbeCache` per-agent 5min 主动轮询;AttachDialog 退化为缓存展示器 + Re-test。
- **C 渲染器 + 接线**: WebGL 能力探测;AttachDialog Renderer 行;localStorage 持久化;`deviceProfile`/`targetColumns`/`rendererType` 接线;context-loss 回退 Canvas。
- **搭车修复**: toolbar 禁用一致(4)、字号可恢复(6)、ResizeObserver 防抖(7)、鼠标 motion-only 节流(8)。

## 核心功能截图
（见 `.playwright-mcp/screenshots/`）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Problems 1(T1),2(T2-3),3(T6),4(T12),5(T4),6(T13),7(T13),8(T14),9(spec-only). Renderer detect/select/persist(T4,5,8,11). Probe cache: server(T7),types(T8),hook(T9),wiring(T10),dialog(T11). All success criteria mapped.
- **Type consistency:** `AttachChoice.renderer`, `AttachedSession.renderer`, `TerminalProps.renderer`, `AttachPrefs.renderer` all `'webgl' | 'canvas'`. Engine methods `setExternalBanner(banner, attempt)` + `reattach()` consistent between T2 definition and T3 usage. `AgentProbe`/`AddressProbeCache` names consistent T9→T10→T11.
- **Ordering:** Work Line C's renderer prep (T4-6) precedes B's dialog rewrite (T11) so the single AttachDialog file is edited with full knowledge of both the renderer row and cache display; T8 adds `AttachChoice.renderer` before T11 consumes it; T5 notes the useAttachFlow temporary until T8 finalizes it.
- **Known deferral:** Problem 9 (sub-row remainder) intentionally not implemented — recorded in spec §12.
