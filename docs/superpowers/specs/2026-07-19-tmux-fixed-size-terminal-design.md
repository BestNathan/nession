# Design: Fixed-Size tmux Sessions with Client-Only Rendering

**Date:** 2026-07-19
**Status:** Draft

**Relationship to prior work:**
- **Kept:** `2026-07-16-tmux-control-mode-design.md` — tmux → agent → server → web resize broadcast pathway remains the sole source of dimension truth
- **Superseded:** the scaling / viewport-fit / CSS-transform sections of `2026-07-18-terminal-architecture-restructure-design.md`. `TerminalSizeManager` survives as a slimmer version; `ScalingManager` is deleted; `FontSizeManager` is new

---

## 1. Overview

Every tmux session is created at a **fixed large size (default 200×60)** and locked so tmux never resizes the pane, regardless of which clients attach. The web client renders the tmux output at exactly the pane's size, and adapts to browser viewport changes purely through client-side scrolling and font-size zoom. **The browser never sends a size back to tmux.**

This inverts the current architecture's assumption that the web client is the "master" of terminal dimensions and eliminates:
- The `FitAddon` / viewport-driven resize path
- The CSS-transform scaling in `ScalingManager`
- Auto-computed create-time sizing
- Any outbound `client.resize` / `refresh-client -C` protocol

The result is a small, deterministic renderer whose only inputs are (a) the pane dimensions tmux broadcasts and (b) the user's font-size preference.

## 2. Motivation

The current `feat/terminal-architecture-restructure` branch has three symptoms observed in the running app:
1. **Scrolling is broken** — `.xterm-viewport.scrollHeight === clientHeight`; wheel events are inert
2. **The UI feels unlike native xterm** — CSS `transform: scale(1.3)` visually stretches the terminal but breaks the mouse-coordinate mapping xterm expects
3. **tmux stays at 80×24** — the web client never tells tmux to grow, and there is no protocol/UI to do so

Root cause analysis in the current spec traced these to a conflation of three concerns (tmux size, xterm grid size, visual size) that the new managers tried to keep in sync bidirectionally. This document takes a different position: **tmux size is fixed at create time, and the client only reads it**. The three concerns then become three independent knobs, each with one clear owner.

## 3. Non-Goals

The following are explicitly out of scope for this design:

- **Browser → tmux resize.** The browser will never send its own dimensions to tmux. Not on attach, not on window resize, not on zoom. This is a hard architectural rule to avoid the multi-client interference problems detailed in `2026-07-18-terminal-architecture-restructure-design.md`.
- **Content re-flow at a different width.** tmux does not re-format its ANSI stream per client. When the browser viewport is wider than the tmux pane, `ls` output does not re-wrap to a wider line. Filling the wider viewport is a visual affordance only (via background color + user-controlled font-size zoom).
- **Different behavior for alt-screen vs normal-screen.** Because xterm's cols/rows always equal tmux's cols/rows, both mode categories work identically. No mode detection is required.
- **Dynamic session-size UI at create time.** The default `200×60` is hard-coded for this iteration. A future enhancement may expose it in `CreateSessionDialog`.

## 4. Architecture

### 4.1 Data Flow (single direction)

```
tmux pane fixed at 200×60 (created by agent, locked via window-size=manual)
  │
  │  %window-resize @<id> 200 60  (control mode; emitted once on create,
  │                                 and again if tmux internal state forces
  │                                 it — but never in response to a client)
  ▼
nession-agent (control_mode parser → agent.terminal.resize {session_id, cols:200, rows:60})
  ▼
nession-server (broadcasts terminal.resize {cols:200, rows:60} to attached clients)
  ▼
web ConnectionManager.onResize(200, 60)
  ▼
TerminalSizeManager.handleResize(200, 60):
  ├── term.resize(200, 60)                     xterm internal grid
  └── mountElement.style: 200*cellW × 60*cellH  CSS pixel size
  ▼
DOM: scrollContainer(overflow:auto) contains mountElement(1680×1008 @ 14px)
  ▼
Browser: if viewport < mountElement, native scrollbars appear;
         if viewport > mountElement, empty space fills with #1e1e2e
```

### 4.2 Component Responsibilities

| Component | Responsibility | Change |
|-----------|---------------|--------|
| **Agent — `session/create`** | Create tmux session with fixed size + lock | **New: append `-x -y` + `set-option window-size manual` + `resize-window`** |
| **Protocol — `CreateSessionPayload`** | Carry optional `cols` / `rows` | **New optional fields with `#[serde(default)]`** for future flexibility. Current web UI does not send them; agent defaults to 200×60 when absent |
| **Server** | Broker `terminal.resize` broadcasts | **No change** |
| **`ConnectionManager`** | Emit `onResize` from received `terminal.resize` | **No change** (already implemented) |
| **`TerminalSizeManager`** | Set xterm grid + mountElement pixel size on resize | **Simplify:** remove any mode detection, remove ScalingManager coordination |
| **`TerminalView` (DOM)** | Own `scrollContainer` + `mountElement` structure | **Simplify:** remove `scalingWrapper` (no more CSS transform); `scrollContainer` is `100%×100%; overflow:auto` |
| **`ScalingManager`** | (Removed) | **Delete** |
| **`FontSizeManager` (new)** | Font-size zoom in/out/reset; notify `TerminalSizeManager` to recompute mount pixels when cell size changes | **New** — replaces `ScalingManager`. Never uses CSS transform |
| **`TerminalToolbar` zoom controls** | Call `FontSizeManager` methods instead of `ScalingManager` | **Rewire only** |
| **`CreateSessionDialog` / `useDashboardHandlers`** | Kick off session creation | **No change** — no dimensions sent |

### 4.3 DOM Structure

```html
<div class="h-full w-full" style="background: #1e1e2e">    <!-- container -->
  <div style="width:100%; height:100%; overflow:auto">     <!-- scrollContainer -->
    <div style="width:1680px; height:1008px; position:relative">  <!-- mountElement -->
      <!-- xterm renders here at exactly cols*cellW × rows*cellH -->
    </div>
  </div>
</div>
```

Two facts guaranteed by this structure:

1. **`mountElement` is always exactly `cols*cellW × rows*cellH` pixels.** This is enforced every time `TerminalSizeManager.handleResize` runs, and again whenever `FontSizeManager` changes `fontSize` (cellW/cellH change → mount pixel size must be recomputed).
2. **`scrollContainer` provides browser-native scrolling** whenever `mountElement > scrollContainer`. No custom wheel handling, no CSS transform mapping problems, no scrollbar-simulation library. Just `overflow: auto`.

## 5. Detailed Component Design

### 5.1 Agent: Session Creation

Current session-create logic executes something like:
```bash
tmux new-session -d -s <name>
```

New logic (pseudocode; actual implementation in Rust):
```rust
async fn create_session(name: &str, cols: u16, rows: u16) -> Result<()> {
    let cols = cols.max(MIN_COLS).min(MAX_COLS);   // clamp for sanity
    let rows = rows.max(MIN_ROWS).min(MAX_ROWS);

    // 1. Create at the requested size.
    run(&["tmux", "new-session", "-d", "-s", name,
          "-x", &cols.to_string(), "-y", &rows.to_string()])?;

    // 2. Lock: pane size no longer follows any client.
    run(&["tmux", "set-option", "-t", name, "window-size", "manual"])?;

    // 3. Belt-and-braces: some tmux versions honor -x/-y only after the first
    //    attach, so explicitly resize the window to the target size now.
    run(&["tmux", "resize-window", "-t", name,
          "-x", &cols.to_string(), "-y", &rows.to_string()])?;

    Ok(())
}
```

**Constants** (in `nession-common`):
```rust
pub const DEFAULT_TMUX_COLS: u16 = 200;
pub const DEFAULT_TMUX_ROWS: u16 = 60;
pub const MIN_COLS: u16 = 80;   // don't accept smaller than legacy VT default
pub const MAX_COLS: u16 = 500;  // sanity ceiling
pub const MIN_ROWS: u16 = 24;
pub const MAX_ROWS: u16 = 200;
```

**Protocol change** — `CreateSessionPayload` gets two optional fields:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionPayload {
    // ... existing fields ...
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}
```

When both are `None` (current web UI behavior), the agent uses `DEFAULT_TMUX_COLS`/`DEFAULT_TMUX_ROWS`.

**Existing sessions** created before this change stay at whatever size they had. Applying `window-size manual` retroactively is not attempted — old sessions render at their own size and continue to work.

### 5.2 Web: TerminalView DOM

Replace the current three-layer wrapper (containerDiv → scalingWrapper → scrollContainer → mountElement) with two layers:

```typescript
// TerminalView.ts constructor
constructor(container: HTMLElement, options: TerminalViewOptions) {
  const scrollContainer = document.createElement('div');
  scrollContainer.style.cssText = 'width:100%; height:100%; overflow:auto;';

  const mountElement = document.createElement('div');
  mountElement.style.cssText = 'position:relative;';    // width/height set by TerminalSizeManager

  scrollContainer.appendChild(mountElement);
  container.appendChild(scrollContainer);

  // ... rest of constructor ...
}
```

Removed:
- `scalingWrapper` (the transform host is gone entirely)
- `display: inline-block` on scrollContainer (was collapsing it to content size)
- The `requestAnimationFrame` fit-to-viewport block (which called `ScalingManager.fitToViewport`)

### 5.3 Web: TerminalSizeManager

The class shrinks to its essence:

```typescript
export class TerminalSizeManager {
  constructor(
    private readonly term: Terminal,
    private readonly mountElement: HTMLElement,
  ) {}

  handleResize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
    this.recomputeMountPixels(cols, rows);
  }

  // Called by FontSizeManager after fontSize changes (cell dimensions changed).
  recompute(): void {
    if (this.disposed) return;
    this.recomputeMountPixels(this.term.cols, this.term.rows);
  }

  private recomputeMountPixels(cols: number, rows: number): void {
    const { width, height } = getCellDimensions(this.term);
    this.mountElement.style.width  = `${cols * width}px`;
    this.mountElement.style.height = `${rows * height}px`;
  }

  dispose(): void { this.disposed = true; }
  private disposed = false;
}
```

Notes:
- `scrollContainer` is no longer a constructor parameter — this manager never needs to reference it (native `overflow:auto` handles scrolling without JS involvement).
- `getCellDimensions` unchanged — reads from `term._core._renderService.dimensions.css.cell`.

### 5.4 Web: FontSizeManager

Replaces `ScalingManager`. Zoom acts on the actual xterm font size, not on CSS transform.

```typescript
const MIN_FONT = 8;
const MAX_FONT = 40;
const STEP    = 1;

export class FontSizeManager {
  constructor(
    private readonly term: Terminal,
    private readonly onCellSizeChange: () => void,   // notify TerminalSizeManager
    private readonly defaultSize: number,
  ) {}

  zoomIn():  void { this.setSize(this.term.options.fontSize! + STEP); }
  zoomOut(): void { this.setSize(this.term.options.fontSize! - STEP); }
  reset():   void { this.setSize(this.defaultSize); }

  getSize(): number { return this.term.options.fontSize ?? this.defaultSize; }

  private setSize(next: number): void {
    const clamped = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
    if (clamped === this.term.options.fontSize) return;
    this.term.options.fontSize = clamped;
    // xterm re-measures cells on next render tick; refresh forces it now.
    this.term.refresh(0, this.term.rows - 1);
    this.onCellSizeChange();     // TerminalSizeManager.recompute()
  }
}
```

The `onCellSizeChange` callback is the crucial coupling: after fontSize changes, `mountElement` pixel dimensions are stale (still using old cellW/cellH). The manager owns the notification so the coupling is one-way and explicit.

### 5.5 Wiring in TerminalView

```typescript
this.size     = new TerminalSizeManager(this.terminal, mountElement);
this.fontSize = new FontSizeManager(
  this.terminal,
  () => this.size.recompute(),
  options.deviceProfile?.fontSize ?? 14,
);

this.connection.onResize = (cols, rows) => {
  if (!this.isDisposed) this.size.handleResize(cols, rows);
};
```

The `TerminalHandle` imperative API exposes `fontSizeManager` (renamed from `scalingManager`) for `TerminalToolbar`'s zoom buttons to call.

### 5.6 Initial Pane Size Handshake

Between `terminal.open()` and the first `terminal.resize` broadcast from tmux, there is a small window where xterm has default cols/rows (typically 80×24) that don't match the pane. Behavior during this window:

- xterm renders its default 80×24 grid
- `mountElement` pixel size is set from the default (80*cellW × 24*cellH ≈ 672×403)
- As soon as the first `terminal.resize` arrives (typically < 100ms after `client.attach`), `TerminalSizeManager.handleResize` runs and everything jumps to 200×60

If the visible "flicker" is objectionable, `TerminalView` can defer showing the mountElement (e.g., `visibility: hidden`) until the first resize arrives, then reveal. This spec chooses to accept the flicker as a starting point — it's brief and only happens on attach. A follow-up may add the visibility gate.

## 6. Protocol

### 6.1 CreateSessionPayload additions

Serde-compatible additive change:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionPayload {
    // ... existing ...
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}
```

Old clients (no `cols`/`rows` in the JSON) → `None` → agent uses defaults. New clients that pass values (future feature) → agent uses them, clamped to `[MIN, MAX]`.

### 6.2 No new inbound messages

There is no `client.resize` from browser to server, no `session.resize` request. The web client is purely reactive.

## 7. UX Behavior Matrix

Fontsize = 14 → cellW ≈ 8.4, cellH ≈ 16.8. mountElement at 200×60 = 1680×1008 px.

| Viewport | mount vs viewport | User sees |
|----------|-------------------|-----------|
| 1920×1080 (desktop full) | mount 1680×1008 < viewport | Terminal near-fills; small margin right/bottom (240 × 72 px) filled with #1e1e2e |
| 1440×900 (laptop) | mount > viewport in both axes | Horizontal + vertical scrollbars; user drags to pan |
| 375×667 (phone portrait) | mount ≫ viewport | Both scrollbars; touch pan works via native overflow |
| 3840×2160 (4K full) | mount ≪ viewport | Large empty area right/bottom. User can zoom-in (fontSize ↑) to fill; e.g. fontSize 32 → mount 3840×2304 |
| top / vim running | Same as above | Alt-screen content is exactly 200×60 chars; viewports smaller than mount scroll to see all of it |

## 8. Migration & Compatibility

- **Existing sessions** (created before this change) keep their current size. `window-size manual` is not retroactively applied — no logic depends on that, and users may already have sessions at 80×24 they expect to keep working.
- **Old CLI clients** attaching to new sessions get a 200×60 pane; if their terminal is smaller, tmux presents an under-sized view (standard tmux behavior when `window-size = manual` and client < pane).
- **Web ↔ Web** on the same session: both see 200×60. Neither influences the other. Independent scroll/zoom state per browser tab.

## 9. Testing Strategy

### 9.1 Unit tests

- `TerminalSizeManager.test.ts` — resize → term.resize + mount pixels; recompute after fontSize change picks up new cellW/cellH
- `FontSizeManager.test.ts` (new) — zoomIn/Out clamps to `[MIN_FONT, MAX_FONT]`; callback fires; reset returns to default
- Delete `ScalingManager.test.ts`

### 9.2 Integration tests

- Agent `session/create` — verifies the three tmux commands run in order; verifies `window-size` option is `manual` after creation

### 9.3 Playwright verification

Per project convention (`CLAUDE.md` § Development Cycle):

1. Fresh `HOME=/tmp/nession-demo` stack
2. Create session via web UI → confirm pane is 200×60 (via `tmux list-sessions -F '#{window_width}x#{window_height}'` in a shell)
3. Attach → verify xterm cols/rows match, mountElement pixel size matches, no CSS transform on any ancestor
4. Resize browser larger → confirm mount unchanged, right/bottom empty area appears
5. Resize browser smaller → confirm native scrollbars appear on scrollContainer
6. Click zoom-in in toolbar → confirm fontSize increases, mountElement grows, scrollbars adjust
7. Attach same session from a CLI client → confirm pane still 200×60, CLI shows only what fits in its terminal

Screenshots (before/after each state) go into `.playwright-mcp/screenshots/` and reference the PR body.

## 10. Risks & Open Questions

**Risk: `tmux resize-window` fails silently if `window-size != manual`.**
Mitigation: we set `window-size manual` first, then `resize-window`. Order matters in the code.

**Risk: `window-size manual` requires tmux ≥ 2.9.**
Verified: agent Docker images use Ubuntu 24.04 (tmux 3.4) and Debian bookworm (tmux 3.3a); local dev has tmux 3.6b. All ≥ 2.9. Documented in agent README.

**Open: What happens if a very old tmux is used?**
The `set-option window-size` call fails, `resize-window` may then not do what we expect, and the session ends up at whatever size `tmux new-session -x -y` gave it. This is acceptable degradation: functionality preserved, only the "locked" guarantee is lost.

**Open: Do we surface fontSize in the URL / persist it?**
Not in this iteration. Zoom is session-instance-local; refresh resets to default. Adding persistence is a follow-up.

**Open: Should we clamp `cols` / `rows` differently for mobile-created sessions in a future UI?**
Yes, but that's a `CreateSessionDialog` enhancement. This spec's constants are a starting point.

## 11. Rollout Plan

1. Land protocol changes (backward compatible)
2. Land agent session-create changes
3. Land web TerminalView + TerminalSizeManager simplification
4. Land FontSizeManager, wire into TerminalToolbar
5. Delete ScalingManager
6. Playwright verification + PR
