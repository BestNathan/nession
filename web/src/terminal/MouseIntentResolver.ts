import type { Terminal } from '@xterm/xterm';

/**
 * Distinguishes click from drag so the web terminal can support both:
 *   click → SGR mouse sequence → PTY → TUI application
 *   drag  → local text selection in the browser
 *
 * ## Design
 *
 * `shouldForceSelection` always returns true — xterm.js handles all mouse
 * events as selection.  This class listens for raw DOM mouse events on
 * `terminal.element` (sibling to xterm's own listener, so xterm's
 * `stopPropagation()` can't block us), detects click intent (fast press +
 * release, <5 px movement), and manually injects SGR extended-mouse
 * sequences (CSI ? 1006) into the terminal data pipeline.
 *
 * A mouse-active gate checks `coreMouseService` so clicks are only sent
 * when the TUI has actually enabled SGR mouse mode.  When mouse mode is
 * off, all mouse events stay local for text selection.
 *
 * Double/triple clicks are detected by timing and left to xterm for native
 * word/line selection.  Shift+click always forces local selection.
 *
 * ## State machine
 *
 *   IDLE ─mousedown─→ PENDING (start 80 ms timer)
 *   PENDING ─timer──→ CLICK_INTENT → send SGR press
 *   PENDING ─move>5px→ DRAG (cancel timer)
 *   PENDING ─mouseup─→ send press+release (sub-80 ms click)
 *   CLICK_INTENT ─mouseup─→ send SGR release → IDLE
 *   CLICK_INTENT ─move>5px→ send release (cancel), → DRAG
 *   DRAG ─mouseup─→ IDLE
 *   (any) ─window blur─→ send release if CLICK_INTENT, reset
 */

/** Pixel-distance threshold: movement below this is treated as a click. */
const CLICK_DISTANCE_PX = 5;
/** Milliseconds before a stationary press is committed as a click. */
const FLUSH_DELAY_MS = 80;
/** Maximum interval between clicks to count as a multi-click. */
const MULTI_CLICK_MS = 400;

type ResolverState = 'idle' | 'pending' | 'click_intent' | 'drag';

/** Shape of the internal core-mouse service we read for the active gate. */
interface CoreMouseService {
  areMouseEventsActive: boolean;
  activeEncoding: string;
}

export class MouseIntentResolver {
  private state: ResolverState = 'idle';
  private downPos = { x: 0, y: 0 };
  private downCell: { col: number; row: number } | null = null;
  private downButton = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastClickTime = 0;
  private lastClickCol = -1;
  private lastClickRow = -1;
  private disposed = false;

  /** Original `shouldForceSelection` — restored on dispose. */
  private origShouldForceSelection:
    | ((e: MouseEvent) => boolean)
    | null = null;

  // Bound handlers retained for removeEventListener.
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: () => void;
  private boundBlur: () => void;

  /**
   * Callback invoked with raw SGR escape sequences for click events.
   * Wire this to the terminal → PTY data path.
   */
  onSend: ((data: string) => void) | null = null;

  constructor(
    private terminal: Terminal,
  ) {
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundBlur = this.handleBlur.bind(this);
    this.install();
  }

  // ── Install / remove ──────────────────────────────────────────────

  private install(): void {
    // Override xterm's selection gate: always treat mouse as local
    // selection.  Click SGR sequences are injected manually below.
    const core = (this.terminal as unknown as Record<string, unknown>)
      ._core as Record<string, unknown> | undefined;
    const sel = core?._selectionService as
      | { shouldForceSelection: (e: MouseEvent) => boolean }
      | undefined;
    if (sel) {
      this.origShouldForceSelection = sel.shouldForceSelection.bind(sel);
      sel.shouldForceSelection = () => true;
    }

    // Listen on terminal.element (xterm's own wrapper, created during
    // construction).  xterm attaches its mousedown here too and calls
    // stopPropagation(); if we listened on a parent we'd be blocked.
    const el = this.terminal.element;
    if (el) {
      el.addEventListener('mousedown', this.boundMouseDown);
    }
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
    window.addEventListener('blur', this.boundBlur);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.cancelPending();

    const el = this.terminal.element;
    if (el) {
      el.removeEventListener('mousedown', this.boundMouseDown);
    }
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('mouseup', this.boundMouseUp);
    window.removeEventListener('blur', this.boundBlur);

    // Restore xterm's original selection behaviour.
    if (this.origShouldForceSelection) {
      const core = (this.terminal as unknown as Record<string, unknown>)
        ._core as Record<string, unknown> | undefined;
      const sel = core?._selectionService as
        | { shouldForceSelection: (e: MouseEvent) => boolean }
        | undefined;
      if (sel) {
        sel.shouldForceSelection = this.origShouldForceSelection;
      }
    }

    this.onSend = null;
  }

  // ── DOM handlers ──────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    if (this.disposed) { return; }
    if (e.button !== 0) { return; }
    if (e.shiftKey) { return; }

    // Only send clicks when the TUI has actually enabled SGR mouse mode.
    if (!this.isMouseActive()) { return; }

    // Multi-click detection: let xterm handle word/line selection.
    const now = Date.now();
    const cell = this.cellFromEvent(e);
    if (
      now - this.lastClickTime < MULTI_CLICK_MS &&
      cell &&
      Math.abs(cell.col - this.lastClickCol) <= 1 &&
      Math.abs(cell.row - this.lastClickRow) <= 1
    ) {
      this.lastClickTime = now;
      this.lastClickCol = cell.col;
      this.lastClickRow = cell.row;
      return;
    }
    this.lastClickTime = now;
    if (cell) {
      this.lastClickCol = cell.col;
      this.lastClickRow = cell.row;
    }

    this.state = 'pending';
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downButton = e.button;
    this.downCell = cell;

    this.flushTimer = setTimeout(() => this.flushPress(), FLUSH_DELAY_MS);
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.disposed) { return; }
    if (this.state !== 'pending' && this.state !== 'click_intent') { return; }

    const dx = e.clientX - this.downPos.x;
    const dy = e.clientY - this.downPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= CLICK_DISTANCE_PX) { return; }

    // Movement detected — it's a drag.
    if (this.state === 'click_intent') {
      // Press was already sent; release to cancel so the TUI doesn't
      // see a stuck button.
      this.sendRelease();
    }
    this.cancelPending();
    this.state = 'drag';
  }

  private handleMouseUp(): void {
    if (this.disposed) { return; }

    if (this.state === 'pending') {
      this.cancelPending();
      this.sendPress();
      this.sendRelease();
    } else if (this.state === 'click_intent') {
      this.sendRelease();
    }

    this.state = 'idle';
    this.downCell = null;
  }

  /**
   * Window lost focus while a click was in flight.  Send a release so the
   * TUI doesn't end up with a permanently-held button.
   */
  private handleBlur(): void {
    if (this.disposed) { return; }
    if (this.state === 'click_intent') {
      this.sendRelease();
    }
    this.cancelPending();
    this.state = 'idle';
    this.downCell = null;
  }

  // ── Timer ─────────────────────────────────────────────────────────

  private flushPress(): void {
    if (this.state !== 'pending') { return; }
    this.state = 'click_intent';
    this.sendPress();
  }

  private cancelPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── SGR construction ──────────────────────────────────────────────

  private sendPress(): void {
    if (!this.downCell) { return; }
    this.onSend?.(
      encodeSgrSequence(this.downButton, this.downCell.col, this.downCell.row, false),
    );
  }

  private sendRelease(): void {
    if (!this.downCell) { return; }
    this.onSend?.(
      encodeSgrSequence(this.downButton, this.downCell.col, this.downCell.row, true),
    );
  }

  // ── Mouse-active gate ─────────────────────────────────────────────

  /**
   * Returns true when the TUI has enabled SGR mouse tracking, meaning it
   * wants to receive mouse events.  Reads xterm's internal
   * `coreMouseService` which mirrors the application's DECSET sequences.
   */
  private isMouseActive(): boolean {
    const core = (this.terminal as unknown as Record<string, unknown>)
      ._core as Record<string, unknown> | undefined;
    const ms = core?.coreMouseService as CoreMouseService | undefined;
    if (ms) {
      return ms.areMouseEventsActive && ms.activeEncoding === 'SGR';
    }
    // Fallback: check the CSS class xterm toggles on enable.
    return this.terminal.element?.classList.contains('enable-mouse-events') ?? false;
  }

  // ── Coordinate conversion ─────────────────────────────────────────

  /**
   * Pixel → cell coordinate conversion, mirroring xterm's own
   * `getMouseReportCoords`.  Uses the `.xterm-screen` element's bounding
   * rect minus CSS padding for the origin, then divides by cell pixel
   * dimensions.  Result is 1-indexed and clamped.
   */
  private cellFromEvent(e: MouseEvent): { col: number; row: number } | null {
    const screenEl = this.terminal.element?.querySelector('.xterm-screen') as
      | HTMLElement
      | undefined;
    if (!screenEl) { return null; }

    const rect = screenEl.getBoundingClientRect();
    const style = screenEl.ownerDocument.defaultView?.getComputedStyle(screenEl);
    const padLeft = style ? parseInt(style.paddingLeft, 10) || 0 : 0;
    const padTop = style ? parseInt(style.paddingTop, 10) || 0 : 0;

    const cell = this.cellPixelSize();
    const x = e.clientX - rect.left - padLeft;
    const y = e.clientY - rect.top - padTop;

    const col = Math.min(
      Math.max(Math.floor(x / cell.width) + 1, 1),
      this.terminal.cols,
    );
    const row = Math.min(
      Math.max(Math.floor(y / cell.height) + 1, 1),
      this.terminal.rows,
    );
    return { col, row };
  }

  private cellPixelSize(): { width: number; height: number } {
    const core = (this.terminal as unknown as Record<string, unknown>)
      ._core as Record<string, unknown> | undefined;
    const rs = core?._renderService as
      | { dimensions?: { css?: { cell?: { width: number; height: number } } } }
      | undefined;
    const c = rs?.dimensions?.css?.cell;
    return { width: c?.width ?? 8, height: c?.height ?? 16 };
  }
}

// ── Exported pure helpers (testable without a Terminal instance) ────

/**
 * Build a CSI ? 1006 SGR extended-mouse sequence.
 *
 * Press:  `\x1b[<{code};{col};{row}M`
 * Release: `\x1b[<{code};{col};{row}m`
 *
 * Button codes (before modifier bits): 0 = left, 1 = middle, 2 = right.
 */
export function encodeSgrSequence(
  button: number,
  col: number,
  row: number,
  isRelease: boolean,
): string {
  return `\x1b[<${button};${col};${row}${isRelease ? 'm' : 'M'}`;
}
