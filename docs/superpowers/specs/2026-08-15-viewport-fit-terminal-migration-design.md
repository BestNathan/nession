# Design: Viewport-Fit Terminal — Complete the Controller Migration

**Date:** 2026-08-15
**Status:** Draft
**Branch:** `fix/mobile-scrollback` (per user decision)

**Relationship to prior work:**
- **Resumes:** `2026-08-12-terminal-architecture-refactor-design.md` + its plan — the layered
  terminal subsystem (state → controller → input → components). The migration stalled at
  Phase 4 (components built but not wired; `TerminalController` is a feature-poor skeleton).
- **Adopts (resizing model):** `2026-07-19-terminal-bidirectional-resize-design.md` — the client
  drives tmux size, tmux confirms via `%window-resize`, last-writer-wins.
- **Supersedes (resizing model):** `2026-07-19-tmux-fixed-size-terminal-design.md` — the fixed
  200×60 pane + client-only scrolling model that is the root cause of issue #240.

---

## 1. Problem

Issue #240 ("mobile scrollback") is a symptom of the **fixed-size terminal design**: the tmux pane
is created at a fixed 200×60 and the web client renders the full grid inside an
`overflow:auto` scroll container. On viewports smaller than the grid, this produces **two
independent vertical scroll surfaces** — the outer `scrollContainer` (pans the oversized grid)
and xterm's internal viewport (scrolls scrollback history). `scrollToBottom()` only drives the
latter, so "scroll to bottom" never reveals the newest output on mobile.

The fix is **viewport-fit**: the browser drives tmux size, the grid matches the viewport, the
outer scroll surface disappears, and xterm's viewport becomes the single scroll surface. This is
already the sizing model baked into the new `TerminalController` (`ResizeController` fits to the
container), but `TerminalController` is not yet mounted — the live path is still the legacy
`TerminalView`. This spec completes the migration so the live terminal is viewport-fit.

## 2. Decisions (confirmed with user, 2026-08-15)

1. **Path:** complete the `TerminalController` migration (C2), not patch the legacy `TerminalView`.
2. **Multi-client:** accept last-writer-wins (a client resize resizes the shared pane for everyone).
   No arbitration.
3. **Relay resize gap:** in scope — the agent must forward tmux resize events to the central server
   so relay clients receive `terminal.resize` (currently P2P-only; see `websocket.rs` TODO).
4. **Branch:** implement on `fix/mobile-scrollback`.
5. **Behavior change:** this is **no longer a behavior-preserving refactor** — the sizing model
   deliberately changes from fixed-size to viewport-fit.

## 3. Current State / Gap Analysis

The `terminal/` module contains two parallel implementations:

| Piece | Status |
|-------|--------|
| Legacy `TerminalView` + `components/Terminal.tsx` + `ConnectionManager` + `InputManager` + `TerminalSizeManager` | **Live** (mounted via `Dashboard → RenderTerminal → TerminalWorkspace → Terminal`) |
| New `TerminalController` + `ResizeController` + `InputRouter` + `useTerminalStateMachine` + `TerminalPane`/`TerminalViewport` | **Not mounted** (dead code, exported only) |
| `TerminalRuntime` (owns xterm + managers) | **Does not exist** |
| Managers: `Renderer`, `ThemeManager`, `FontSizeManager`, `MobileInput`, `MouseIntentResolver`, `AddonManager` | Wired **only** into legacy `TerminalView` |

**Feature-parity gap** — `TerminalController.attach()` opens a bare `Terminal` and lacks everything
the legacy `TerminalView` wires:

- `Renderer` (Canvas/WebGL + software-rasterizer fallback)
- `ThemeManager` (Catppuccin Mocha)
- `FontSizeManager` (zoom) + `fontSizeManager` on the handle
- `MobileInput` (touch IME textarea)
- `MouseIntentResolver` (click-vs-drag → SGR vs local selection)
- scrollback prefill (`capture_scrollback` on attach)
- scroll controls (`scrollToBottom` / `scrollPages` / `scrollLines`) — issue #240

Because `TerminalController` must reach full feature parity **before** it can replace the live
`TerminalView` (swapping early would drop mobile IME, mouse, theme, zoom, and scrollback at once),
parity is the critical path of this work.

## 4. Target Architecture (viewport-fit)

```
React Components            → read terminalViewModelAtomFamily; call controller methods
        │
Jotai (terminal/state/)     → 6 domains (session/terminal/input/ui/layout/capability)
        │
TerminalController          → imperative facade
        ├── InputRouter        → terminal/command/search/ai/custom handlers
        ├── ResizeController   → ResizeObserver → xterm.resize() + transport.sendResize()
        └── SelectionController → MouseIntentResolver + clipboard
        │
TerminalRuntime             → xterm instance + addons + managers
        │                     (Renderer, ThemeManager, FontSizeManager, AddonManager,
        │                      MobileInput, MouseIntentResolver)
        │
TerminalTransport           → interface (ConnectionManager implements it)
        │
WebSocket / P2P             → backend / tmux
```

The legacy `TerminalView` class, `components/Terminal.tsx` React shell, `ConnectionManager`,
`InputManager`, and the fixed-size `TerminalSizeManager` are **deleted** once parity is reached.
The manager classes listed under `TerminalRuntime` are **kept** (moved, not rewritten).

## 5. Resizing Model: fixed-size → viewport-fit

The single behavioral change at the heart of this spec.

**Before (fixed-size, root of #240):**

```
tmux pane fixed 200×60 (created by agent)
  → %window-resize 200 60 → agent → terminal.resize → term.resize(200,60)
  → TerminalSizeManager sizes mountElement to cols*cellW × rows*cellH (≈1680×1008)
  → scrollContainer(overflow:auto) pans the oversized grid  ← SECOND scroll surface
```

**After (viewport-fit):**

```
browser ResizeObserver (container size)
  → ResizeController computes cols = floor(width/cellW), rows = floor(height/cellH)
  → optimistic term.resize(cols, rows)              (no flicker)
  → transport.sendResize(cols, rows)                (terminal.resize → agent)
  → agent: tmux resize-window / PTY SIGWINCH
  → tmux confirms %window-resize → agent → terminal.resize (broadcast, P2P + relay)
  → term.resize(cols, rows)                          (authoritative confirm)
```

- **Single scroll surface**: xterm's viewport is the only scroller. The `scrollContainer` +
  `mountElement` wrapper and `TerminalSizeManager` are removed; `terminal.open()` mounts directly
  into the container.
- **`ResizeController` replaces `TerminalSizeManager`** as the sizing driver.
- **`SESSION_WIDTH`/`SESSION_HEIGHT` (200×60)** in `manager.rs` become a harmless create-time
  default: both attach backends already resize the pane to the client on attach
  (`PtySession::attach` opens a client-sized PTY → SIGWINCH; `ControlModeSession::attach` runs
  `resize-window -x -y`). No `window-size manual` lock exists in the code to remove (the fixed-size
  spec's `lock_session_size` was never implemented).
- **Font size** remains a user preference (zoom), but no longer resizes the mount surface — it only
  changes cell pixel size, which in turn changes how many cols/rows fit the viewport, feeding back
  through the ResizeObserver.

## 6. Relay Resize Fix

The bidirectional-resize spec already designed this but it was never wired for relay. Two
directions:

1. **agent → server → relay clients (the TODO).** The agent's control-mode resize task
   (`websocket.rs`, the `%window-resize` forwarding loop) sends `terminal.resize` only to the
   direct P2P sink. It must **additionally** send `agent.terminal.resize` upstream via
   `sync::terminal::send_terminal_resize` so the server (which already broadcasts
   `agent.terminal.resize` → `terminal.resize` to relay clients in `handler.rs`) can forward it.
   This requires the agent to hold a server sink (`TransportSink`) in the attach path — the piece
   the TODO explicitly deferred.
2. **client → server → agent (relay input resize).** `ConnectionManager.sendResize()` already calls
   `sendRelayResize` in relay mode; verify the server forwards `terminal.resize` (client) to the
   agent's attach backend. If a gap exists here, close it in the same change.

## 7. Scrollback Capabilities (#240)

The mobile scroll overlay (`TerminalScrollOverlay`) and the `TerminalHandle` scroll methods survive
the migration, but move onto the new controller:

- `TerminalController` (or `TerminalRuntime`) exposes `scrollToBottom` / `scrollPages` /
  `scrollLines`, delegating to `terminal.scrollToBottom()` etc. — now the **only** scroll surface,
  so no outer-container panning is needed.
- scrollback prefill (`capture_scrollback` on attach) is wired into `TerminalController.attach()`
  (both P2P and relay), so history survives a reconnect.

## 8. What Gets Deleted

- `web/src/terminal/TerminalView.ts` (legacy class)
- `web/src/components/Terminal.tsx` (legacy React shell + its inline state machine)
- `web/src/terminal/InputManager.ts` (its mouse-throttle + Ctrl+D logic folds into
  `InputController` / `TerminalInputHandler`)
- `web/src/terminal/TerminalSizeManager.ts` (fixed-size sizing; replaced by `ResizeController`)

Kept (moved under `TerminalRuntime`, not rewritten): `Renderer`, `ThemeManager`, `FontSizeManager`,
`AddonManager`, `MobileInput`, `MouseIntentResolver`, `DeviceProfile`, `ConnectionManager`.

`ConnectionManager` is **kept** as the concrete `TerminalTransport` implementation — it already
satisfies the interface shape and the refactor design treats its logic as unchanged. Only the
legacy *React* coupling around it (the `TerminalView`/`components/Terminal.tsx` shell) dies.

Agent-side: `SESSION_WIDTH`/`SESSION_HEIGHT` stay as create-time constants (overridden on attach,
see §5); no lock code to remove.

## 9. Multi-Client Behavior (last-writer-wins)

Two clients attached to one session (plain PTY mode shares one PTY; control mode is per-client but
`resize-window` affects the shared pane). A resize from either client resizes the pane for everyone;
the most recent resize wins. tmux confirms via `%window-resize` (control) or reflows via SIGWINCH
(plain). No arbitration, no minimum/maximum. This re-accepts the trade-off the fixed-size design
had removed, and is explicitly confirmed as acceptable.

## 10. Migration Phases

Resume the `2026-08-12-terminal-architecture-refactor` plan, amended with the viewport-fit change.
Each phase leaves the tree building and tests green.

1. **TerminalRuntime + parity.** Create `terminal/runtime/TerminalRuntime.ts` owning xterm +
   addons + managers (`Renderer`, `ThemeManager`, `FontSizeManager`, `AddonManager`,
   `MobileInput`, `MouseIntentResolver`). Wire it into `TerminalController.attach()`. Add
   scrollback prefill + `scrollToBottom`/`scrollPages`/`scrollLines` + `fontSizeManager` + cell
   dimensions. **Verification:** controller matches legacy feature set under unit tests.
2. **Viewport-fit sizing.** Replace `TerminalSizeManager` usage with `ResizeController` (already
   in the controller). Remove `scrollContainer`/`mountElement` from the mount path so
   `terminal.open()` targets the container directly. **Verification:** single scroll surface; #240
   scroll-to-bottom reveals the cursor; resize observer drives tmux.
3. **Relay resize.** Wire agent `%window-resize` → `agent.terminal.resize` upstream (server sink),
   and verify client→agent relay resize end-to-end. **Verification:** relay client resizes → tmux
   resizes → relay client receives confirm.
4. **Swap the live mount.** Point `Dashboard`/`RenderTerminal`/`TerminalWorkspace` at
   `TerminalPane` + `TerminalController` + `useTerminalStateMachine` (drop the legacy
   `components/Terminal.tsx` + inline state machine). **Verification:** full functional parity —
   mobile IME, mouse, theme, zoom, scrollback all work; Playwright screenshots.
5. **Delete legacy.** Remove `TerminalView.ts`, `components/Terminal.tsx`, `InputManager.ts`,
   `TerminalSizeManager.ts`, and the agent fixed-size create path. Update `terminal/index.ts`
   exports and coverage exclusions. **Verification:** `tsc`/`lint`/`vitest`/`build` clean; no dead
   imports remain.

## 11. Testing Strategy

- **Unit:** `TerminalRuntime` wires managers without throwing; `ResizeController` computes cols/rows
  from container + cell size; `TerminalController` exposes scroll/fontSize methods; `InputRouter`
  unchanged.
- **Rust:** agent resize path sends `agent.terminal.resize` upstream; `manager.rs` create no longer
  hardcodes 200×60 as the attach-time size.
- **Playwright (mandatory, per CLAUDE.md):** 375×812 mobile viewport — terminal fills the viewport
  (no oversized grid), `seq 1 500` generates scrollback, scroll-to-bottom reveals the newest line,
  three overlay buttons work, no horizontal pan; 1280×800 desktop — no overlay, terminal fills
  viewport; relay mode resize round-trips; two clients resize → last-writer-wins observable.

## 12. Risks / Open Questions

- **Parity is the critical path.** Missing any manager (mobile IME, mouse, theme) during the swap
  is a user-visible regression. Phase 1 must be verified before Phase 4.
- **Plain PTY has no `%window-resize`.** In `AttachMode::Plain` (the default), tmux confirms resize
  via SIGWINCH reflow, not a structured event. The frontend's optimistic `term.resize` is therefore
  the primary sizing signal; ensure the relay confirm path does not depend on an event that only
  control mode emits.
- **`AttachMode::Control` is "backward-compat".** Decide whether to keep both backends through this
  change, or fold plain-PTY only. Out of scope to delete control mode, but its resize path must not
  regress.
- **`lastResizeAtom` provenance.** It is currently written by the legacy `ResizeObserver`; the new
  `ResizeController` must keep it (or its successor) updated so `client.attach` still carries the
  initial width/height.
