# Fixed-Size tmux + Client-Only Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web terminal usable again by (a) locking tmux pane size on create via `window-size manual`, (b) deleting the CSS-transform scaling layer that broke native xterm behavior, and (c) replacing scale-based zoom with fontSize-based zoom.

**Architecture:** Agent creates every tmux session at 200×60 and locks it so no client can change the pane size. Web client's xterm cols/rows always equal tmux's; DOM is a single `scrollContainer` (`overflow: auto`) around a `mountElement` sized to exactly `cols*cellW × rows*cellH`. Font-size zoom changes xterm's `fontSize` (which changes cell size, which changes mountElement pixels) — never CSS transform. Browser never sends dimensions back to tmux.

**Tech Stack:** Rust (agent, tokio, anyhow), tmux 3.3+, TypeScript, xterm.js 5.5, React 18, Vitest, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-07-19-tmux-fixed-size-terminal-design.md`

---

## Task 1: Agent — lock tmux window-size on session create

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs` (add `lock_window_size` helper + call from `create_session`)
- Test: `crates/nession-agent/src/tmux/manager.rs` (add `#[tokio::test]` inline)

**Rationale:** Agent already creates sessions at 200×60, but tmux's default `window-size = latest` lets a CLI client's terminal size override the pane on attach. `set-option -t <name> window-size manual` locks the pane so no client (CLI or web) can resize it. This is the last remaining piece on the agent side.

- [ ] **Step 1: Read current `create_session` in `manager.rs`** to confirm what it looks like end-to-end (already investigated, but re-read for the exact byte-level state).

Run: `grep -n 'fn create_session\|fn lock_window_size\|SESSION_WIDTH' crates/nession-agent/src/tmux/manager.rs`
Expected: shows `SESSION_WIDTH: u16 = 200`, `SESSION_HEIGHT: u16 = 60`, `pub async fn create_session(...)` on the lines discussed.

- [ ] **Step 2: Write failing test for lock**

Add this test at the bottom of `crates/nession-agent/src/tmux/manager.rs` (inside the existing `#[cfg(test)] mod tests` block if there is one, otherwise create it). It uses a random session name to avoid collisions:

```rust
#[cfg(test)]
mod window_size_lock_tests {
    use super::*;

    fn unique_name(prefix: &str) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("{prefix}-{nanos}")
    }

    async fn read_window_size_option(session: &str) -> Result<String> {
        let out = Command::new("tmux")
            .args(["show-option", "-t", session, "-v", "window-size"])
            .output().await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_locks_window_size_to_manual() {
        // Skip on machines without tmux (CI covers it).
        if Command::new("tmux").arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = TmuxManager::new();
        let name = unique_name("lock-test");
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(&name, 200, 60, &cwd, &[]).await.expect("create");

        let val = read_window_size_option(&name).await.expect("show-option");
        assert_eq!(val, "manual", "expected window-size=manual, got {val:?}");

        // Cleanup — swallow errors, best-effort.
        let _ = Command::new("tmux").args(["kill-session", "-t", &name]).status().await;
    }
}
```

- [ ] **Step 3: Run test — verify it fails**

Run: `cargo test -p nession-agent --lib window_size_lock -- --nocapture`
Expected: FAIL with `expected window-size=manual, got "latest"` (or similar), because we haven't set the option yet.

If tmux isn't available, the test early-returns and passes without exercising anything. That's OK — CI has tmux.

- [ ] **Step 4: Add `lock_window_size` helper**

In `crates/nession-agent/src/tmux/manager.rs`, add this method to the `impl TmuxManager` block, right below `create_session`:

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

- [ ] **Step 5: Call `lock_window_size` from `create_session`**

Modify `create_session` in `crates/nession-agent/src/tmux/manager.rs`. Find the block that ends the current function:

```rust
        let status = cmd.status().await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {name}");
        }

        Ok(())
    }
```

Replace with:

```rust
        let status = cmd.status().await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {name}");
        }

        // Lock pane size so no attaching client can resize it. Applied AFTER
        // new-session succeeds; on failure we roll back by killing the session
        // so we don't leave a half-configured session lying around.
        if let Err(e) = self.lock_window_size(name).await {
            let _ = Command::new("tmux").args(["kill-session", "-t", name]).status().await;
            return Err(e);
        }

        Ok(())
    }
```

- [ ] **Step 6: Run test — verify it passes**

Run: `cargo test -p nession-agent --lib window_size_lock -- --nocapture`
Expected: PASS. `window-size = manual` after `create_session`.

- [ ] **Step 7: Run existing agent tests to verify no regressions**

Run: `cargo test -p nession-agent`
Expected: all pass. If any pre-existing test creates a session via `create_session` and later inspects size, it may need to accept that pane is now locked at 200×60 — that's the intended behavior; adjust the assertion to match.

- [ ] **Step 8: Clippy + fmt**

Run: `cargo clippy -p nession-agent -- -D warnings && cargo fmt --all -- --check`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "feat(agent): lock tmux window-size to manual on session create

Every session created by the agent now sets window-size=manual after
new-session, so no attaching CLI client can resize the pane. Combined
with the existing SESSION_WIDTH/HEIGHT=200×60 default, this makes pane
size stable across multi-client attach.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Web — write new TerminalSizeManager (slim signature) with tests

**Files:**
- Modify: `web/src/terminal/TerminalSizeManager.ts` (change constructor signature, add `recompute()`)
- Modify: `web/src/terminal/__tests__/TerminalSizeManager.test.ts` (update tests to new signature, add `recompute()` case)

**Rationale:** The slim manager drops `scrollContainer` from the constructor (never needed), and gains `recompute()` so `FontSizeManager` can trigger a mountElement pixel refresh when cell size changes. `handleResize` semantics unchanged: `term.resize(cols, rows)` + set mountElement CSS to `cols*cellW × rows*cellH`.

- [ ] **Step 1: Write failing tests**

Replace the entire body of `web/src/terminal/__tests__/TerminalSizeManager.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TerminalSizeManager } from '../TerminalSizeManager';

/** Attach a fake _renderService with given cell dimensions. */
function mockRenderService(term: Terminal, cellWidth: number, cellHeight: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = term as any;
  t._core = t._core ?? {};
  t._core._renderService = {
    dimensions: { css: { cell: { width: cellWidth, height: cellHeight } } },
  };
}

describe('TerminalSizeManager', () => {
  let term: Terminal;
  let mountElement: HTMLElement;

  beforeEach(() => {
    term = new Terminal();
    mountElement = document.createElement('div');
  });

  afterEach(() => { term.dispose(); });

  it('calls term.resize when handleResize is invoked', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(120, 40);

    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
    manager.dispose();
  });

  it('sets mountElement pixel dimensions from cell size × cols/rows', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(80, 24);

    expect(mountElement.style.width).toBe('800px');   // 80 * 10
    expect(mountElement.style.height).toBe('480px');  // 24 * 20
    manager.dispose();
  });

  it('falls back to 8x16 when render service is unavailable', () => {
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(80, 24);

    expect(mountElement.style.width).toBe('640px');   // 80 * 8
    expect(mountElement.style.height).toBe('384px');  // 24 * 16
    manager.dispose();
  });

  it('recompute() uses current term cols/rows and current cell size', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(200, 60);
    expect(mountElement.style.width).toBe('2000px');
    expect(mountElement.style.height).toBe('1200px');

    // Simulate a font-size increase: cells become 12×24.
    mockRenderService(term, 12, 24);
    manager.recompute();

    // term cols/rows still 200×60 (not changed by fontSize).
    expect(mountElement.style.width).toBe('2400px');   // 200 * 12
    expect(mountElement.style.height).toBe('1440px');  // 60 * 24
    manager.dispose();
  });

  it('handleResize is a no-op after dispose', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, mountElement);
    manager.dispose();

    manager.handleResize(80, 24);

    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('recompute is a no-op after dispose', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);
    manager.handleResize(80, 24);
    manager.dispose();
    mountElement.style.width = 'stale';
    mountElement.style.height = 'stale';

    manager.recompute();

    expect(mountElement.style.width).toBe('stale');
    expect(mountElement.style.height).toBe('stale');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd web && npx vitest run src/terminal/__tests__/TerminalSizeManager.test.ts`
Expected: FAIL because the constructor still takes `(term, scrollContainer, mountElement)` and there's no `recompute()`. Compilation errors are OK — they count as failure.

- [ ] **Step 3: Rewrite `TerminalSizeManager.ts`**

Replace the entire body of `web/src/terminal/TerminalSizeManager.ts` with:

```typescript
import type { Terminal } from '@xterm/xterm';

/**
 * Default cell dimensions used when xterm's render service is unavailable.
 * Derived from a 14px monospace font at devicePixelRatio=1 (cell width ≈ 8.4px,
 * height ≈ 16.8px, floored to integer pixels). These are only a fallback —
 * normally the real values are read from xterm's internal render service.
 * A debug message is logged when this fallback is hit so mismatches are
 * visible during development.
 */
const DEFAULT_CELL_WIDTH = 8;
const DEFAULT_CELL_HEIGHT = 16;

interface CellDimensions {
  width: number;
  height: number;
}

/**
 * Reads cell pixel dimensions from xterm's internal render service.
 * Falls back to defaults (8x16) when the internal API is unavailable
 * (e.g. terminal not yet opened, or internal structure changes).
 */
function getCellDimensions(term: Terminal): CellDimensions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderService = (term as any)._core?._renderService;
  const width = renderService?.dimensions?.css?.cell?.width;
  const height = renderService?.dimensions?.css?.cell?.height;
  if (width === undefined || height === undefined) {
    console.debug(
      '[TerminalSizeManager] xterm render service unavailable, ' +
        `falling back to default cell dimensions (${DEFAULT_CELL_WIDTH}x${DEFAULT_CELL_HEIGHT})`,
    );
    return { width: DEFAULT_CELL_WIDTH, height: DEFAULT_CELL_HEIGHT };
  }
  return { width, height };
}

/**
 * Manages terminal dimensions driven by tmux resize events.
 *
 * On every `terminal.resize` broadcast from tmux, `handleResize(cols, rows)`
 * runs and:
 *   1. Updates xterm's internal grid via `term.resize(cols, rows)`.
 *   2. Sets `mountElement`'s CSS pixel size to `cols*cellW × rows*cellH`.
 *
 * `recompute()` is a hook for `FontSizeManager`: after fontSize changes,
 * cellW/cellH change, so mountElement pixel size must be refreshed even
 * though cols/rows didn't change.
 *
 * The scroll container that wraps `mountElement` is not this class's
 * concern — browser-native `overflow: auto` handles scrolling without any
 * JS involvement.
 */
export class TerminalSizeManager {
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    private readonly mountElement: HTMLElement,
  ) {}

  /**
   * Handle a resize event originating from tmux.
   * Updates xterm's internal grid and the mount element's CSS pixel size.
   */
  handleResize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
    this.setMountPixels(cols, rows);
  }

  /**
   * Refresh mount element pixel size using current term cols/rows and current
   * cell dimensions. Call this after fontSize changes.
   */
  recompute(): void {
    if (this.disposed) return;
    this.setMountPixels(this.term.cols, this.term.rows);
  }

  dispose(): void {
    this.disposed = true;
  }

  private setMountPixels(cols: number, rows: number): void {
    const { width, height } = getCellDimensions(this.term);
    this.mountElement.style.width = `${cols * width}px`;
    this.mountElement.style.height = `${rows * height}px`;
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/TerminalSizeManager.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Do NOT run typecheck yet**

`TerminalView.ts` still imports the old 3-arg constructor. It will fail typecheck until Task 4 fixes the caller. That's expected — do not attempt to fix here; the intermediate state is documented and one commit later is resolved. **Do NOT commit until the caller is fixed.**

Note this in your working memory. This task ends without a commit; Task 4 will bundle the caller fix and both commit together.

---

## Task 3: Web — create FontSizeManager with tests

**Files:**
- Create: `web/src/terminal/FontSizeManager.ts`
- Create: `web/src/terminal/__tests__/FontSizeManager.test.ts`

- [ ] **Step 1: Write failing test**

Create `web/src/terminal/__tests__/FontSizeManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FontSizeManager } from '../FontSizeManager';

describe('FontSizeManager', () => {
  let term: Terminal;
  let onCellSizeChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    term = new Terminal({ fontSize: 14 });
    onCellSizeChange = vi.fn();
  });

  afterEach(() => { term.dispose(); });

  it('getSize returns current terminal fontSize', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    expect(mgr.getSize()).toBe(14);
  });

  it('zoomIn increases fontSize by 1 and notifies', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(term.options.fontSize).toBe(15);
    expect(mgr.getSize()).toBe(15);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('zoomOut decreases fontSize by 1 and notifies', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomOut();
    expect(term.options.fontSize).toBe(13);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('zoomIn clamps to MAX_FONT (40) and does not notify past ceiling', () => {
    term.options.fontSize = 40;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(term.options.fontSize).toBe(40);
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('zoomOut clamps to MIN_FONT (8) and does not notify past floor', () => {
    term.options.fontSize = 8;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomOut();
    expect(term.options.fontSize).toBe(8);
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('reset restores default and notifies when different from current', () => {
    term.options.fontSize = 20;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.reset();
    expect(term.options.fontSize).toBe(14);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('reset is a no-op when already at default (no notify)', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.reset();
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('calls term.refresh after fontSize change so xterm re-measures cells', () => {
    const refreshSpy = vi.spyOn(term, 'refresh');
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(refreshSpy).toHaveBeenCalledWith(0, term.rows - 1);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd web && npx vitest run src/terminal/__tests__/FontSizeManager.test.ts`
Expected: FAIL — file `FontSizeManager.ts` does not exist.

- [ ] **Step 3: Implement `FontSizeManager.ts`**

Create `web/src/terminal/FontSizeManager.ts`:

```typescript
import type { Terminal } from '@xterm/xterm';

const MIN_FONT = 8;
const MAX_FONT = 40;
const STEP = 1;

/**
 * Manages font-size zoom for the terminal.
 *
 * Zoom in/out mutates xterm's `options.fontSize`, which changes the cell
 * width/height. After the change, `term.refresh(0, rows-1)` forces xterm to
 * re-measure cells immediately (otherwise it happens on next repaint).
 * The `onCellSizeChange` callback lets `TerminalSizeManager` refresh the
 * mount element's pixel dimensions so the DOM stays consistent.
 *
 * Zoom is NEVER implemented via CSS transform. Transform breaks the
 * mouse-coordinate mapping xterm expects (clicks land at wrong cells).
 */
export class FontSizeManager {
  constructor(
    private readonly term: Terminal,
    private readonly onCellSizeChange: () => void,
    private readonly defaultSize: number,
  ) {}

  getSize(): number {
    return this.term.options.fontSize ?? this.defaultSize;
  }

  zoomIn(): void {
    this.setSize(this.getSize() + STEP);
  }

  zoomOut(): void {
    this.setSize(this.getSize() - STEP);
  }

  reset(): void {
    this.setSize(this.defaultSize);
  }

  private setSize(next: number): void {
    const clamped = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
    if (clamped === this.getSize()) return;
    this.term.options.fontSize = clamped;
    // Force xterm to re-measure cells now rather than on next repaint,
    // so getCellDimensions() called from onCellSizeChange sees fresh values.
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
    this.onCellSizeChange();
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd web && npx vitest run src/terminal/__tests__/FontSizeManager.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Do NOT commit yet**

`FontSizeManager` is only useful when `TerminalView` wires it up (Task 4) and `TerminalToolbar` consumes it (Task 5). Bundle the commit with those. Continue to Task 4.

---

## Task 4: Web — rebuild TerminalView DOM + wire new managers

**Files:**
- Modify: `web/src/terminal/TerminalView.ts` (remove scalingWrapper, remove ScalingManager, wire FontSizeManager)
- Modify: `web/src/terminal/types.ts` (rename `scalingManager` → `fontSizeManager` in `TerminalHandle`)
- Modify: `web/src/terminal/index.ts` (export `FontSizeManager`, remove `ScalingManager` export)
- Delete: `web/src/terminal/ScalingManager.ts`
- Delete: `web/src/terminal/__tests__/ScalingManager.test.ts`

**Rationale:** DOM collapses to `container → scrollContainer(overflow:auto) → mountElement`. No transform, no wrapper. `TerminalSizeManager` gets its new 2-arg constructor. `FontSizeManager` created and exposed on the imperative handle.

- [ ] **Step 1: Read current `TerminalView.ts`** to know exactly what to replace.

Run: `wc -l web/src/terminal/TerminalView.ts && sed -n '1,10p' web/src/terminal/TerminalView.ts`
Expected: 174 lines starting with the current imports.

- [ ] **Step 2: Rewrite `web/src/terminal/TerminalView.ts`**

Replace the entire file body:

```typescript
import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
import { FontSizeManager } from './FontSizeManager';
import { InputManager } from './InputManager';
import { ConnectionManager } from './ConnectionManager';
import type {
  TerminalViewOptions,
  TerminalViewState,
  ConnectionState,
} from './types';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

export class TerminalView {
  readonly terminal: Terminal;

  private size: TerminalSizeManager;
  private fontSize: FontSizeManager;
  private input: InputManager;
  private connection: ConnectionManager;

  private isDisposed = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;

  onStateChange: ((state: TerminalViewState) => void) | null = null;
  onCtrlD: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(container: HTMLElement, options: TerminalViewOptions) {
    // DOM: container → scrollContainer(overflow:auto) → mountElement
    // scrollContainer fills its parent; mountElement is sized to
    // cols*cellW × rows*cellH by TerminalSizeManager. When mount > scroll,
    // browser-native scrollbars appear. When mount < scroll, container
    // background (#1e1e2e, set on `container` by the React component) fills
    // the remainder — no transform, no wrapper.
    const scrollContainer = document.createElement('div');
    scrollContainer.style.cssText = 'width:100%; height:100%; overflow:auto;';

    const mountElement = document.createElement('div');
    mountElement.style.cssText = 'position:relative;';

    scrollContainer.appendChild(mountElement);
    container.appendChild(scrollContainer);

    const initialFontSize = options.deviceProfile?.fontSize ?? DEFAULT_FONT_SIZE;

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      theme: options.theme,
      allowProposedApi: true,
      scrollback: options.deviceProfile?.scrollback ?? 10000,
    });

    // Renderer/ThemeManager created for constructor side effects.
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);

    this.size = new TerminalSizeManager(this.terminal, mountElement);
    this.fontSize = new FontSizeManager(
      this.terminal,
      () => this.size.recompute(),
      initialFontSize,
    );
    this.input = new InputManager(this.terminal);
    this.connection = new ConnectionManager(options.connection);

    // Wire managers.
    this.input.onData((data: string) => {
      if (!this.isDisposed) { this.connection.send(data); }
    });
    this.input.onCtrlD(() => { this.onCtrlD?.(); });

    this.connection.onOutput = (data: string) => {
      if (!this.isDisposed) { this.terminal.write(data); }
    };
    this.connection.onStateChange = (state: ConnectionState, attempt: number) => {
      this.onStateChange?.({
        banner: state === 'reconnecting' ? 'reconnecting'
              : state === 'lost' ? 'failed'
              : 'none',
        reconnectAttempt: attempt,
        isConnected: state === 'connected',
      });
    };
    this.connection.onError = (err: Error) => { this.onError?.(err); };
    this.connection.onDisconnect = () => { this.onDisconnect?.(); };
    this.connection.onResize = (cols: number, rows: number) => {
      if (!this.isDisposed) { this.size.handleResize(cols, rows); }
    };

    this.terminal.open(mountElement);

    // Prime mount pixel size from xterm's default cols/rows (typically 80×24)
    // so the DOM has explicit dimensions before the first tmux resize arrives.
    // Once that arrives (usually < 100ms after client.attach) size flips to
    // the real pane size (typically 200×60).
    requestAnimationFrame(() => {
      if (!this.isDisposed) {
        this.size.handleResize(this.terminal.cols, this.terminal.rows);
      }
    });

    // Deferred attach (survives React StrictMode double-mount).
    this.attachTimer = setTimeout(() => {
      if (!this.isDisposed) {
        this.connection.attach().catch(() => {});
      }
    }, 50);
  }

  sendText(text: string): void {
    if (this.isDisposed) return;
    this.connection.send(text);
  }

  /** No-op: TerminalSizeManager is driven by tmux resize events, not viewport fits. */
  refit(): void {
    // Kept on the handle for API compatibility; nothing to do.
  }

  /** Get the font-size manager for external zoom controls. */
  get fontSizeManager(): FontSizeManager {
    return this.fontSize;
  }

  /** Push a banner state from an external observer (e.g. React watching P2P). */
  setExternalBanner(banner: 'none' | 'reconnecting' | 'failed', attempt: number): void {
    if (this.isDisposed) return;
    this.onStateChange?.({
      banner,
      reconnectAttempt: attempt,
      isConnected: banner === 'none',
    });
  }

  /** Re-issue attach (tmux redraw) after a transport reconnect. */
  reattach(): void {
    if (this.isDisposed) return;
    this.connection.reattach().catch(() => {});
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.attachTimer) { clearTimeout(this.attachTimer); this.attachTimer = null; }
    this.input.dispose();
    this.size.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
```

- [ ] **Step 3: Update `TerminalHandle` in `web/src/terminal/types.ts`**

Find and replace:

```typescript
/** Imperative methods exposed by the Terminal React component via ref. */
export interface TerminalHandle {
  sendText: (text: string) => void;
  refit: () => void;
  scalingManager: import('./ScalingManager').ScalingManager | null;
}
```

with:

```typescript
/** Imperative methods exposed by the Terminal React component via ref. */
export interface TerminalHandle {
  sendText: (text: string) => void;
  refit: () => void;
  fontSizeManager: import('./FontSizeManager').FontSizeManager | null;
}
```

- [ ] **Step 4: Update `web/src/terminal/index.ts`**

Find:

```typescript
export { ScalingManager } from './ScalingManager';
```

Replace with:

```typescript
export { FontSizeManager } from './FontSizeManager';
```

- [ ] **Step 5: Delete old ScalingManager files**

Run:

```bash
rm web/src/terminal/ScalingManager.ts
rm web/src/terminal/__tests__/ScalingManager.test.ts
```

- [ ] **Step 6: Update `web/src/components/Terminal.tsx`**

Find in `web/src/components/Terminal.tsx`:

```typescript
      sendText: (text: string) => {
        if (!isBlocked) { viewRef.current?.sendText(text); }
      },
      refit: () => viewRef.current?.refit(),
      scalingManager: viewRef.current?.scalingManager ?? null,
```

Replace with:

```typescript
      sendText: (text: string) => {
        if (!isBlocked) { viewRef.current?.sendText(text); }
      },
      refit: () => viewRef.current?.refit(),
      fontSizeManager: viewRef.current?.fontSizeManager ?? null,
```

- [ ] **Step 7: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: fails only in `TerminalToolbar.tsx` (still imports `ScalingManager`) and `TerminalView.tsx` (passes `scalingManager` prop). Fixed in Task 5.

- [ ] **Step 8: Do NOT commit yet — Task 5 finishes wiring**

Continue.

---

## Task 5: Web — rewire TerminalToolbar to FontSizeManager

**Files:**
- Modify: `web/src/components/TerminalToolbar.tsx` (rename prop + type)
- Modify: `web/src/components/TerminalLayout.tsx` (rename prop)
- Modify: `web/src/components/TerminalView.tsx` (rename prop when passing to layout)

- [ ] **Step 1: Rewrite `web/src/components/TerminalToolbar.tsx`**

Do these three edits inside the file.

First edit — imports and prop types (top of file):

Find:

```typescript
import type { ScalingManager } from '@/terminal/ScalingManager';

export interface TerminalToolbarProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  scalingManager?: ScalingManager | null;
}

interface ZoomControlsProps {
  scalingManager: ScalingManager;
  disabled: boolean;
}
```

Replace with:

```typescript
import type { FontSizeManager } from '@/terminal/FontSizeManager';

export interface TerminalToolbarProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  fontSizeManager?: FontSizeManager | null;
}

interface ZoomControlsProps {
  fontSizeManager: FontSizeManager;
  disabled: boolean;
}
```

Second edit — the `ZoomControls` component body:

Find:

```typescript
function ZoomControls({ scalingManager, disabled }: ZoomControlsProps) {
  const [scale, setScale] = useState(() => scalingManager.getScale());

  const handleZoomIn = () => {
    if (!scalingManager) {
      return;
    }
    scalingManager.zoomIn();
    setScale(scalingManager.getScale());
  };

  const handleZoomOut = () => {
    if (!scalingManager) {
      return;
    }
    scalingManager.zoomOut();
    setScale(scalingManager.getScale());
  };

  const handleZoomReset = () => {
    if (!scalingManager) {
      return;
    }
    scalingManager.reset();
    setScale(scalingManager.getScale());
  };
```

Replace with:

```typescript
function ZoomControls({ fontSizeManager, disabled }: ZoomControlsProps) {
  const [size, setSize] = useState(() => fontSizeManager.getSize());

  const handleZoomIn = () => {
    fontSizeManager.zoomIn();
    setSize(fontSizeManager.getSize());
  };

  const handleZoomOut = () => {
    fontSizeManager.zoomOut();
    setSize(fontSizeManager.getSize());
  };

  const handleZoomReset = () => {
    fontSizeManager.reset();
    setSize(fontSizeManager.getSize());
  };
```

Third edit — the label rendering. Find:

```typescript
      <span className="text-xs font-mono min-w-[3rem] text-center">
        {Math.round(scale * 100)}%
      </span>
```

Replace with (the label now shows the actual font size in `px`, which reflects the new semantic accurately):

```typescript
      <span className="text-xs font-mono min-w-[3rem] text-center">
        {size}px
      </span>
```

Fourth edit — the destructured props and the ZoomControls call site.

Find:

```typescript
export function TerminalToolbar({ sendText, disabled = false, scalingManager }: TerminalToolbarProps) {
```

Replace with:

```typescript
export function TerminalToolbar({ sendText, disabled = false, fontSizeManager }: TerminalToolbarProps) {
```

Find:

```typescript
          {scalingManager && (
            <ZoomControls scalingManager={scalingManager} disabled={disabled} />
          )}
```

Replace with:

```typescript
          {fontSizeManager && (
            <ZoomControls fontSizeManager={fontSizeManager} disabled={disabled} />
          )}
```

- [ ] **Step 2: Update `web/src/components/TerminalLayout.tsx`**

Find (near top):

```typescript
import type { ScalingManager } from '@/terminal/ScalingManager';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  sessionId: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  scalingManager?: ScalingManager | null;
}
```

Replace with:

```typescript
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  sessionId: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
}
```

Find in the same file:

```typescript
  fileOps,
  onTerminalReveal,
  scalingManager,
}: TerminalLayoutProps) {
```

Replace with:

```typescript
  fileOps,
  onTerminalReveal,
  fontSizeManager,
}: TerminalLayoutProps) {
```

Find:

```typescript
  const commandsPanel = (
    <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} scalingManager={scalingManager} />
  );
```

Replace with:

```typescript
  const commandsPanel = (
    <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} fontSizeManager={fontSizeManager} />
  );
```

- [ ] **Step 3: Update `web/src/components/TerminalView.tsx`**

Find:

```typescript
          scalingManager={terminalRef.current?.scalingManager ?? null}
```

Replace with:

```typescript
          fontSizeManager={terminalRef.current?.fontSizeManager ?? null}
```

- [ ] **Step 4: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Run web unit tests**

Run: `cd web && npm test -- --run`
Expected: all pass, including TerminalSizeManager and FontSizeManager suites.

- [ ] **Step 6: Run web lint**

Run: `cd web && npm run lint`
Expected: PASS with 0 warnings (project enforces `--max-warnings 0`).

- [ ] **Step 7: Build web**

Run: `cd web && npm run build`
Expected: succeeds without errors.

- [ ] **Step 8: Commit tasks 2 + 3 + 4 + 5 together**

```bash
git add web/src/terminal/TerminalSizeManager.ts \
        web/src/terminal/__tests__/TerminalSizeManager.test.ts \
        web/src/terminal/FontSizeManager.ts \
        web/src/terminal/__tests__/FontSizeManager.test.ts \
        web/src/terminal/TerminalView.ts \
        web/src/terminal/types.ts \
        web/src/terminal/index.ts \
        web/src/components/Terminal.tsx \
        web/src/components/TerminalToolbar.tsx \
        web/src/components/TerminalLayout.tsx \
        web/src/components/TerminalView.tsx
git rm web/src/terminal/ScalingManager.ts \
       web/src/terminal/__tests__/ScalingManager.test.ts
git commit -m "refactor(web): replace CSS-transform scaling with font-size zoom

Restore native xterm behavior:
- Delete ScalingManager (CSS transform: scale broke mouse coords and
  produced a viewport that felt non-native)
- Delete scalingWrapper DOM layer; TerminalView is now a single
  scrollContainer (overflow: auto) around a mountElement sized to
  exactly cols*cellW × rows*cellH
- Slim TerminalSizeManager: 2-arg constructor, add recompute() hook
  for FontSizeManager
- New FontSizeManager: zoom in/out/reset mutates term.options.fontSize
  and refreshes xterm cell measurement, then notifies TerminalSizeManager
- Rewire TerminalToolbar zoom buttons to FontSizeManager

Fixes 'no scrolling' and 'not native xterm' symptoms on
feat/terminal-architecture-restructure.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Playwright verification (end-to-end)

**Files:** none (verification only).

**Rationale:** The behavior we care about is emergent — scrollbars appearing, mount size correct, no CSS transform, zoom via fontSize. Verify by driving the app.

- [ ] **Step 1: Start clean local stack**

```bash
pkill -f 'target/debug/nession-(server|agent)' 2>/dev/null; true
pkill -f vite 2>/dev/null; true
rm -rf /tmp/nession-demo
mkdir -p /tmp/nession-demo
```

- [ ] **Step 2: Build and start server + agent in background**

```bash
cargo build -p nession-server -p nession-agent
HOME=/tmp/nession-demo cargo run -p nession-server > /tmp/nession-demo/server.log 2>&1 &
sleep 2
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml > /tmp/nession-demo/agent.log 2>&1 &
sleep 3
```

- [ ] **Step 3: Start Vite dev server**

```bash
cd web && npm run dev > /tmp/nession-demo/vite.log 2>&1 &
cd ..
sleep 3
```

- [ ] **Step 4: Kill any leftover test tmux sessions from prior runs**

```bash
tmux kill-server 2>/dev/null; true
```

- [ ] **Step 5: Drive UI via Playwright MCP**

Do this via the browser tools (mcp__playwright__browser_*):

1. `browser_navigate` → `http://localhost:13000`
2. Run `browser_evaluate` with `() => localStorage.clear()` to drop stale prefilled values.
3. `browser_navigate` reload.
4. Fill Server URL `ws://localhost:19090/ws`, Auth Token `dev`, click Connect.
5. Wait 2s for dashboard.
6. Click Create session button. Give it a name like `test-fs`. Submit.
7. Click Attach on the new session. In the attach dialog, accept defaults, click Attach.
8. Wait 2s for terminal to render.

- [ ] **Step 6: Verify DOM structure matches spec**

Run `browser_evaluate`:

```javascript
() => {
  const xterm = document.querySelector('.xterm');
  const mount = xterm?.parentElement;
  const scroll = mount?.parentElement;
  const outer = scroll?.parentElement;
  const cs = el => el ? getComputedStyle(el) : null;
  return {
    hasScalingWrapper: !!document.querySelector('[style*="scale("]'),
    outerTransform: cs(outer)?.transform,
    scrollOverflowY: cs(scroll)?.overflowY,
    scrollWidth: scroll?.getBoundingClientRect().width,
    scrollHeight: scroll?.getBoundingClientRect().height,
    mountStyleWidth: mount?.style.width,
    mountStyleHeight: mount?.style.height,
    xtermCols: xterm?.getAttribute('data-col-count') ?? null,
    // Query xterm rows/cols via .xterm-screen dimensions
    screenWidth: document.querySelector('.xterm-screen')?.clientWidth,
    screenHeight: document.querySelector('.xterm-screen')?.clientHeight,
  };
}
```

Assertions to make in your writeup:
- `hasScalingWrapper === false`
- `outerTransform` in {`'none'`, `'matrix(1, 0, 0, 1, 0, 0)'`}
- `scrollOverflowY === 'auto'`
- `mountStyleWidth`/`Height` are pixel strings (`"XXXpx"`), non-empty
- After tmux resize arrives, mount should be 200 * cellW × 60 * cellH

- [ ] **Step 7: Verify tmux is locked and 200×60**

Run in shell:

```bash
tmux ls -F '#{session_name} #{window_width}x#{window_height} #{window-size}' 2>/dev/null | grep -i test-fs
```

Expected: `test-fs 200x60 manual` (or with any preserved prefix; the key facts are `200x60` and `manual`).

- [ ] **Step 8: Verify no scrolling regression**

In the terminal, run `for i in $(seq 1 100); do echo "line $i"; done` — the bottom of the output should be visible; if the browser viewport is smaller than 200×60 * cell size, native scrollbars should appear on the scrollContainer. Screenshot:

```
mcp__playwright__browser_take_screenshot -> .playwright-mcp/screenshots/task6-after-scroll.png
```

- [ ] **Step 9: Verify zoom via fontSize**

Click the zoom-in button in TerminalToolbar 3 times. Screenshot:

```
mcp__playwright__browser_take_screenshot -> .playwright-mcp/screenshots/task6-zoomed-in.png
```

Then run `browser_evaluate`:

```javascript
() => {
  const mount = document.querySelector('.xterm')?.parentElement;
  const label = [...document.querySelectorAll('span')].find(s => /^\d+px$/.test(s.textContent ?? ''));
  return { mountWidth: mount?.style.width, mountHeight: mount?.style.height, label: label?.textContent };
}
```

Expected: `label` in the "17px" range (14 + 3 clicks), `mount` dimensions grown proportionally, no CSS transform on any ancestor.

- [ ] **Step 10: Cleanup**

```bash
pkill -f 'target/debug/nession-(server|agent)' 2>/dev/null; true
pkill -f vite 2>/dev/null; true
tmux kill-server 2>/dev/null; true
```

- [ ] **Step 11: Commit screenshots reference (if any doc updates)**

Screenshots go to `.playwright-mcp/screenshots/` (gitignored). If any were captured, reference them in the PR body under "核心功能截图". No commit needed for this step unless the plan updates warrant one.

---

## Task 7: Run full verification & prepare PR

**Files:** none (verification only).

- [ ] **Step 1: Run full Rust tests**

Run: `cargo test`
Expected: all pass.

- [ ] **Step 2: Run Rust clippy + fmt**

Run: `cargo clippy -- -D warnings && cargo fmt --all -- --check`
Expected: clean.

- [ ] **Step 3: Run web unit + lint + typecheck + build**

Run:

```bash
cd web
npm test -- --run
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all four succeed.

- [ ] **Step 4: Verify branch state**

Run: `git status && git log --oneline main..HEAD`
Expected: working tree clean; commits include (a) agent lock, (b) web refactor + tests.

- [ ] **Step 5: Push branch**

```bash
git push -u origin feat/terminal-architecture-restructure
```

- [ ] **Step 6: Do NOT create PR automatically**

Report back to the user with the branch name and let them decide when to open the PR. Include:

- Which tasks completed
- Which tests passed (Rust + web)
- Screenshots collected in `.playwright-mcp/screenshots/`
- Any surprises or deviations from the plan

---

## Summary of file changes

- Rust — Agent
  - `crates/nession-agent/src/tmux/manager.rs`: add `lock_window_size`; call from `create_session`

- Web — Terminal core
  - `web/src/terminal/TerminalView.ts`: rewrite DOM to two layers, wire FontSizeManager
  - `web/src/terminal/TerminalSizeManager.ts`: slim signature `(term, mountElement)`, add `recompute()`
  - `web/src/terminal/FontSizeManager.ts`: NEW
  - `web/src/terminal/types.ts`: `scalingManager` → `fontSizeManager`
  - `web/src/terminal/index.ts`: swap export
  - `web/src/terminal/ScalingManager.ts`: DELETED
  - `web/src/terminal/__tests__/ScalingManager.test.ts`: DELETED
  - `web/src/terminal/__tests__/FontSizeManager.test.ts`: NEW
  - `web/src/terminal/__tests__/TerminalSizeManager.test.ts`: updated for new signature

- Web — React components
  - `web/src/components/Terminal.tsx`: expose `fontSizeManager` on handle
  - `web/src/components/TerminalToolbar.tsx`: rewire zoom to FontSizeManager, label to `<n>px`
  - `web/src/components/TerminalLayout.tsx`: prop rename
  - `web/src/components/TerminalView.tsx`: prop rename
