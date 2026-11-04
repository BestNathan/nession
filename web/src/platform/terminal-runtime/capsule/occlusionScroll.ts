import { isTouchOwned } from '@/shared/lib/touchOwnership';
import type {
  TerminalBufferSnapshot,
  TerminalDisposable,
  TerminalModeSnapshot,
} from '../emulator';

export const TERMINAL_CAPSULE_OCCLUSION_EVENT = 'terminal-capsule-occlusion';

/**
 * The upper panel's top changed (#2710 SC-08).
 *
 * Deliberately a *different* event and variable from the composer occlusion
 * above: that value feeds xterm's viewport fit, so spending the panel's height
 * there would change rows and reflow the PTY. This one is scroll-only.
 */
export const TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT = 'terminal-capsule-panel-clearance';

/**
 * The read/scroll surface the capsule occlusion needs, as a structural subset
 * of {@link import('../emulator').TerminalEmulator} (#2581).
 */
export interface CapsuleScrollTerminalPort {
  readonly element: HTMLElement | null;
  readonly rows: number;
  readBuffer(): TerminalBufferSnapshot;
  readModes(): TerminalModeSnapshot;
  onScroll(listener: () => void): TerminalDisposable;
  onBufferChange(listener: () => void): TerminalDisposable;
  onResize(listener: () => void): TerminalDisposable;
  attachCustomWheelHandler(handler: (event: WheelEvent) => boolean): void;
  scrollLines(lines: number): void;
  scrollPages(pages: number): void;
  scrollToBottom(): void;
}

/** Finger travel (px) before a gesture's axis is decided (#2659). */
const TOUCH_AXIS_SLOP_PX = 8;

export type TouchScrollAxis = 'undecided' | 'vertical' | 'horizontal';

/** One single-finger drag, tracked across its moves (#2659). */
export interface TouchScrollGesture {
  axis: TouchScrollAxis;
  startX: number;
  startY: number;
  lastY: number;
  /** Sub-cell vertical travel carried between moves. */
  accumY: number;
}

export function beginTouchScrollGesture(clientX: number, clientY: number): TouchScrollGesture {
  return { axis: 'undecided', startX: clientX, startY: clientY, lastY: clientY, accumY: 0 };
}

export interface TouchScrollStep {
  /** This move belongs to the terminal's vertical scroll gesture. */
  claimed: boolean;
  axis: TouchScrollAxis;
  /** Whole terminal lines, wheel convention: negative moves toward history. */
  lines: number;
}

/**
 * Advance one drag and decide what it means (#2659).
 *
 * The axis is locked once the finger leaves the slop circle, so a horizontal
 * pager/selection gesture never leaks into terminal scrolling (and vice
 * versa). Vertical travel accumulates *pixels* and only emits whole lines, so a
 * high-frequency touch stream cannot turn each 1px move into a line jump — the
 * remainder carries to the next move.
 */
export function advanceTouchScrollGesture(
  gesture: TouchScrollGesture,
  point: { clientX: number; clientY: number },
  cellHeightPx: number,
): TouchScrollStep {
  if (gesture.axis === 'horizontal') {
    gesture.lastY = point.clientY;
    return { claimed: false, axis: 'horizontal', lines: 0 };
  }
  if (gesture.axis === 'undecided') {
    const dx = Math.abs(point.clientX - gesture.startX);
    const dy = Math.abs(point.clientY - gesture.startY);
    if (Math.max(dx, dy) < TOUCH_AXIS_SLOP_PX) {
      gesture.lastY = point.clientY;
      return { claimed: false, axis: 'undecided', lines: 0 };
    }
    gesture.axis = dy >= dx ? 'vertical' : 'horizontal';
    if (gesture.axis === 'horizontal') {
      gesture.lastY = point.clientY;
      gesture.accumY = 0;
      return { claimed: false, axis: 'horizontal', lines: 0 };
    }
  }
  const cell = cellHeightPx > 0 ? cellHeightPx : 16;
  gesture.accumY += point.clientY - gesture.lastY;
  gesture.lastY = point.clientY;
  const steps = Math.trunc(gesture.accumY / cell);
  if (steps === 0) {
    return { claimed: true, axis: 'vertical', lines: 0 };
  }
  gesture.accumY -= steps * cell;
  // A downward finger drag (positive accumY) pulls older content into view.
  return { claimed: true, axis: 'vertical', lines: -steps };
}

export type ScrollMode = 'following' | 'history';

/** Read published occlusion height from the capsule host (inline style wins). */
export function readOcclusionPx(host: HTMLElement): number {
  const inline = host.style.getPropertyValue('--nession-local-terminal-capsule-occlusion');
  const raw = inline || getComputedStyle(host).getPropertyValue('--nession-local-terminal-capsule-occlusion');
  return Number.parseFloat(raw) || 0;
}

/** Read the upper-panel scroll clearance published by the capsule (#2710). */
export function readPanelClearancePx(host: HTMLElement): number {
  const inline = host.style.getPropertyValue('--nession-local-terminal-capsule-panel-clearance');
  const raw = inline || getComputedStyle(host).getPropertyValue('--nession-local-terminal-capsule-panel-clearance');
  return Number.parseFloat(raw) || 0;
}

/**
 * Clamp the panel clearance to the terminal's own rendered height, keeping at
 * least one row visible.
 *
 * A panel can be taller than a short App viewport's terminal. Shifting by its
 * full height would put the whole grid above the visible area; clamping leaves
 * the last row readable, which is the part the clearance exists to show.
 */
export function clearanceOffsetFor(
  clearancePx: number,
  rows: number,
  cellHeightPx: number,
): number {
  if (clearancePx <= 0 || rows <= 0 || cellHeightPx <= 0) {
    return 0;
  }
  return Math.min(clearancePx, Math.max(0, rows * cellHeightPx - cellHeightPx));
}

/** Occlusion pixels → whole-line scroll margin for xterm. */
export function marginLinesFromOcclusion(occlusionPx: number, cellHeightPx: number): number {
  if (occlusionPx <= 0 || cellHeightPx <= 0) {
    return 0;
  }
  return Math.ceil(occlusionPx / cellHeightPx);
}

/** Viewport Y when the live bottom sits above the fake-terminal occlusion band. */
export function targetViewportY(bufferLength: number, rows: number, marginLines: number): number {
  return Math.max(0, bufferLength - rows - marginLines);
}

/** True when the user is pinned to the live bottom (not browsing history above the band). */
export function isFollowingMarginBottom(
  viewportY: number,
  bufferLength: number,
  rows: number,
  marginLines: number,
): boolean {
  if (marginLines <= 0) {
    return viewportY >= Math.max(0, bufferLength - rows);
  }
  return viewportY >= targetViewportY(bufferLength, rows, marginLines);
}

/**
 * Keeps live output above the capsule occlusion band while still allowing
 * scrollback to pass under the floating dock when the user scrolls up.
 */
export class CapsuleOcclusionScroll {
  private readonly terminal: CapsuleScrollTerminalPort;
  private readonly host: HTMLElement;
  private readonly getCellHeight: () => number;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private scrollDisposable: { dispose(): void } | null = null;
  private bufferChangeDisposable: { dispose(): void } | null = null;
  private resizeDisposable: { dispose(): void } | null = null;
  private occlusionListener: (() => void) | null = null;
  private panelClearanceListener: (() => void) | null = null;
  /** Upper-panel height above the composer, from the capsule's own measure. */
  private panelClearancePx = 0;
  /** Current visual offset applied to the xterm screen (never to the grid). */
  private clearanceOffsetPx = 0;
  private touchStartListener: ((event: TouchEvent) => void) | null = null;
  private touchMoveListener: ((event: TouchEvent) => void) | null = null;
  private touchGesture: TouchScrollGesture | null = null;
  private wasFollowing = true;
  private currentMode: ScrollMode = 'following';
  private observedDock: HTMLElement | null = null;

  constructor(
    terminal: CapsuleScrollTerminalPort,
    host: HTMLElement,
    getCellHeight: () => number,
  ) {
    this.terminal = terminal;
    this.host = host;
    this.getCellHeight = getCellHeight;
    // Read once so a surface that opens before `bind()` already knows the
    // clearance; the event keeps it current afterwards.
    this.panelClearancePx = readPanelClearancePx(host);
  }

  bind(): void {
    const onOcclusionGeometryChange = () => {
      this.ensureDockObserved();
      this.syncPanelClearance();
      if (this.wasFollowing) {
        this.scheduleScrollToMarginBottom();
      }
    };

    const updateFollowingFromScroll = () => {
      this.syncModeFromViewport();
    };

    this.scrollDisposable = this.terminal.onScroll(updateFollowingFromScroll);
    this.bufferChangeDisposable = this.terminal.onBufferChange(() => {
      // An application took (or left) the alternate buffer. Recompute the mode
      // so an offset applied for a normal-buffer screen does not clip a TUI's
      // top rows; no row, PTY or tmux dimension changes either way.
      this.syncModeFromViewport();
    });
    this.resizeDisposable = this.terminal.onResize(() => {
      if (this.wasFollowing) {
        this.scheduleScrollToMarginBottom();
      }
    });

    this.resizeObserver = new ResizeObserver(onOcclusionGeometryChange);
    this.resizeObserver.observe(this.host);

    this.mutationObserver = new MutationObserver(onOcclusionGeometryChange);
    this.mutationObserver.observe(this.host, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    });

    this.occlusionListener = onOcclusionGeometryChange;
    this.host.addEventListener(TERMINAL_CAPSULE_OCCLUSION_EVENT, this.occlusionListener);

    // Separate event, separate value (#2710 SC-08): refresh the cached upper
    // clearance and let the current mode decide whether it is spent.
    this.panelClearanceListener = () => this.syncPanelClearance();
    this.host.addEventListener(
      TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT,
      this.panelClearanceListener,
    );

    const element = this.terminal.element;
    if (element) {
      this.terminal.attachCustomWheelHandler((event) => this.handleWheel(event));

      // Bound on the host in the capture phase, deliberately: xterm also binds
      // touch handlers on its own element, and listeners on the same node run
      // in registration order — so a listener there could only react after
      // xterm had already scrolled `scrollTop`, which is the doubled movement
      // #2659 was reported with. Capturing one level up lets a claimed drag be
      // pre-empted before xterm's native touch scroll instead of fighting it.
      // Touches on the capsule composer live in the same host and are ignored.
      const insideTerminal = (event: Event): boolean => {
        const target = event.target;
        return target instanceof Node && (target === element || element.contains(target));
      };
      this.touchStartListener = (event) => {
        if (!insideTerminal(event)) {
          return;
        }
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        this.touchGesture = touch
          ? beginTouchScrollGesture(touch.clientX, touch.clientY)
          : null;
      };
      this.touchMoveListener = (event) => {
        if (!insideTerminal(event)) {
          return;
        }
        this.handleTouchMove(event);
      };
      this.host.addEventListener('touchstart', this.touchStartListener, { capture: true, passive: true });
      this.host.addEventListener('touchmove', this.touchMoveListener, { capture: true, passive: false });
    }

    updateFollowingFromScroll();
    onOcclusionGeometryChange();
  }

  dispose(): void {
    if (this.occlusionListener) {
      this.host.removeEventListener(TERMINAL_CAPSULE_OCCLUSION_EVENT, this.occlusionListener);
      this.occlusionListener = null;
    }
    if (this.panelClearanceListener) {
      this.host.removeEventListener(
        TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT,
        this.panelClearanceListener,
      );
      this.panelClearanceListener = null;
    }
    this.applyClearanceOffset(0);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.observedDock = null;
    this.scrollDisposable?.dispose();
    this.scrollDisposable = null;
    this.bufferChangeDisposable?.dispose();
    this.bufferChangeDisposable = null;
    this.resizeDisposable?.dispose();
    this.resizeDisposable = null;
    this.terminal.attachCustomWheelHandler(() => true);
    if (this.touchStartListener) {
      this.host.removeEventListener('touchstart', this.touchStartListener, true);
    }
    if (this.touchMoveListener) {
      this.host.removeEventListener('touchmove', this.touchMoveListener, true);
    }
    this.touchStartListener = null;
    this.touchMoveListener = null;
    this.touchGesture = null;
    this.host.style.removeProperty('--nession-local-terminal-content-bottom-inset');
    delete this.host.dataset.terminalScrollMode;
  }

  marginLines(): number {
    return marginLinesFromOcclusion(readOcclusionPx(this.host), this.getCellHeight());
  }

  mode(): ScrollMode {
    return this.currentMode;
  }

  /** The current visual screen offset, in CSS pixels (#2710 SC-08). */
  clearanceOffset(): number {
    return this.clearanceOffsetPx;
  }

  enterHistory(): void {
    this.setMode('history');
  }

  handleWheel(event: WheelEvent): boolean {
    if (!this.shouldScrollLocally()) {
      return true;
    }
    const lines = this.wheelLines(event.deltaY, event.deltaMode);
    if (lines === 0) {
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    this.scrollLines(lines);
    return false;
  }

  scrollPages(pages: number): void {
    // Keep the native page path outside an expanded panel. With one open,
    // a page of movement must account for the visual pan before xterm history.
    if (this.targetClearanceOffset() > 0 || this.clearanceOffsetPx > 0) {
      this.scrollLines(Math.trunc(pages * this.terminal.rows));
      return;
    }
    if (pages < 0) {
      this.enterHistory();
    }
    this.terminal.scrollPages(pages);
    this.syncModeFromViewport();
  }

  /**
   * The expanded panel's extra height is a two-way scrollable range, not a
   * permanent translation of the rendered terminal.
   *
   * Older/negative: first bring the translated screen back down toward its
   * original top (revealing previously clipped rows), then browse xterm
   * scrollback. Newer/positive: first scroll xterm toward its live bottom,
   * then spend remaining motion raising the newest rows above the panel.
   * At buffer viewportY=0 the visual offset is always reachable at zero.
   */
  scrollLines(lines: number): void {
    if (lines === 0) return;
    const target = this.targetClearanceOffset();
    if (target <= 0) {
      if (lines < 0) this.enterHistory();
      this.terminal.scrollLines(lines);
      this.syncModeFromViewport();
      return;
    }

    const cell = this.getCellHeightForTouch();
    if (lines < 0) {
      // Move the visual screen DOWN first. Never throw away the ability to
      // see the top lines merely because the xterm buffer reached viewportY=0.
      this.enterHistory();
      const panSteps = Math.min(-lines, Math.ceil(this.clearanceOffsetPx / cell));
      if (panSteps > 0) {
        this.applyClearanceOffset(Math.max(0, this.clearanceOffsetPx - panSteps * cell));
      }
      const bufferLines = lines + panSteps;
      if (bufferLines < 0) this.terminal.scrollLines(bufferLines);
    } else {
      const buffer = this.terminal.readBuffer();
      const bottom = Math.max(0, buffer.length - this.terminal.rows);
      const remainingBufferLines = Math.max(0, bottom - buffer.viewportY);
      const bufferLines = Math.min(lines, remainingBufferLines);
      if (bufferLines > 0) this.terminal.scrollLines(bufferLines);
      const panSteps = lines - bufferLines;
      if (panSteps > 0) {
        this.applyClearanceOffset(Math.min(target, this.clearanceOffsetPx + panSteps * cell));
      }
    }
    this.syncModeFromViewport();
  }

  isFollowingMarginBottom(): boolean {
    const buffer = this.terminal.readBuffer();
    return isFollowingMarginBottom(
      buffer.viewportY,
      buffer.length,
      this.terminal.rows,
      0,
    );
  }

  /** Pin to the real xterm bottom; the viewport reserves the capsule space. */
  scrollToMarginBottom(): void {
    this.setMode('following');
    this.terminal.scrollToBottom();
    this.wasFollowing = true;
  }

  private setMode(mode: ScrollMode): void {
    this.currentMode = mode;
    this.wasFollowing = mode === 'following';
    const inset = mode === 'following'
      ? 'var(--nession-local-terminal-capsule-occlusion, 0px)'
      : '0px';
    this.host.style.setProperty('--nession-local-terminal-content-bottom-inset', inset);
    this.host.dataset.terminalScrollMode = mode;
    // A user drag from live-following into history must NOT unshift the screen.
    // Doing so moves every rendered row downward by the panel height on the
    // first scroll step, so the gesture appears frozen or jumps underneath the
    // open panel. Retain the existing visual offset while browsing; buffer
    // viewportY remains under xterm's scroll control.
    //
    // If the user was already in history when a panel opened, its existing
    // offset is zero and its reading anchor stays put. Returning to following
    // adopts the latest panel height. Leaving the panel or entering a TUI
    // releases the shift. Neither path changes xterm rows or PTY dimensions.
    const target = this.targetClearanceOffset();
    if (mode === 'following') {
      this.applyClearanceOffset(target);
    } else if (target === 0 || this.clearanceOffsetPx > target) {
      // A smaller/closed panel or a TUI must never leave an obsolete shift.
      this.applyClearanceOffset(Math.min(this.clearanceOffsetPx, target));
    }
  }

  private syncModeFromViewport(): void {
    // At the bottom of the xterm buffer but half-way through the panel pan,
    // the user is *still browsing*. Buffer-only detection would snap the
    // visual screen back to the top of the panel on every scroll notification.
    const atVisualBottom = this.isFollowingMarginBottom()
      && this.clearanceOffsetPx >= this.targetClearanceOffset();
    this.setMode(atVisualBottom ? 'following' : 'history');
  }

  /**
   * Refresh the upper-panel clearance the capsule measured.
   *
   * A change in panel height, a view switch, or closing the panel must update
   * the offset without forcing follow in history. When the panel closes the
   * clearance is zero and the transform is removed, so the composer-only
   * geometry — the fit contract — is all that remains.
   */
  private syncPanelClearance(): void {
    this.panelClearancePx = readPanelClearancePx(this.host);
    this.syncModeFromViewport();
  }

  /**
   * The offset the live bottom needs to clear the upper panel.
   *
   * Only the normal local buffer is eligible. An alternate-screen or
   * mouse-reporting application owns its own screen geometry; shifting it
   * would move the application's rows (and its mouse coordinates) without the
   * application asking, which is the breakage SC-09 forbids. Those views keep
   * the panel overlaid and are not resized.
   */
  private targetClearanceOffset(): number {
    if (!this.canShiftScreen()) {
      return 0;
    }
    return clearanceOffsetFor(
      this.panelClearancePx,
      this.terminal.rows,
      this.getCellHeight(),
    );
  }

  private canShiftScreen(): boolean {
    if (this.terminal.readModes().mouseTrackingMode !== 'none') {
      return false;
    }
    return this.terminal.readBuffer().type === 'normal';
  }

  /**
   * Move the rendered screen up, never the buffer.
   *
   * `.xterm-screen` holds the canvas, the selection layer and the IME helper;
   * translating it keeps xterm's own coordinates (they come from the element's
   * `getBoundingClientRect`) and its scroll position (`ydisp`) untouched. The
   * `overflow: hidden` on `.xterm` clips the top the same number of pixels, so
   * the visible grid is the bottom `rows - offset/cell` rows: the latest
   * output, exactly what the panel made unreachable.
   */
  private applyClearanceOffset(offsetPx: number): void {
    this.clearanceOffsetPx = offsetPx;
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    // Duck-typed rather than `instanceof HTMLElement`: this module runs in the
    // React-free runtime, and its unit suite has no DOM global to test against.
    if (!screen || !('style' in screen)) {
      return;
    }
    const screenStyle = (screen as HTMLElement).style;
    const next = offsetPx > 0 ? `translateY(-${offsetPx}px)` : '';
    // Guard against the MutationObserver seeing this write and re-entering.
    if (screenStyle.transform === next) {
      return;
    }
    screenStyle.transform = next;
  }

  private wheelLines(deltaY: number, deltaMode: number): number {
    if (!Number.isFinite(deltaY) || deltaY === 0) {
      return 0;
    }
    if (deltaMode === 1) {
      return Math.trunc(deltaY);
    }
    if (deltaMode === 2) {
      return Math.trunc(deltaY * this.terminal.rows);
    }
    const cellHeight = this.getCellHeight();
    const pixelsPerLine = cellHeight > 0 ? cellHeight : 16;
    return Math.sign(deltaY) * Math.max(1, Math.round(Math.abs(deltaY) / pixelsPerLine));
  }

  /**
   * One-finger vertical drags scroll *the terminal*, whichever owner that is
   * (#2659).
   *
   * The mode decides the owner, not a guess: Nession's local history scrolls
   * xterm's buffer, while a mouse-reporting or alternate-screen application
   * receives the same drag through xterm's own wheel path — the path a desktop
   * wheel already takes. Before this, the non-local branch returned without
   * doing anything at all, so those TUIs could not be scrolled by touch.
   *
   * A horizontal drag (pager, selection), a second finger, and a tap are not
   * claimed: they never reach `preventDefault`, so their owners keep them.
   */
  private handleTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      // A second finger is a page gesture (pinch/selection): stop xterm's
      // native touch scroll from reading `touches[0]`, but do not prevent the
      // browser's own pinch default.
      this.touchGesture = null;
      event.stopPropagation();
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    // A long-press surface may claim this finger after the drag started (the
    // Terminal direction pad, #2657). Ownership is authoritative even when
    // this capture listener was registered first.
    if (isTouchOwned(touch.identifier)) {
      this.touchGesture = null;
      return;
    }
    if (!this.touchGesture) {
      this.touchGesture = beginTouchScrollGesture(touch.clientX, touch.clientY);
      return;
    }
    const step = advanceTouchScrollGesture(this.touchGesture, touch, this.getCellHeightForTouch());
    if (!step.claimed) {
      // Horizontal or still inside the slop: the pager, selection and tap
      // owners keep the event, so nothing here stops or prevents it.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (step.lines === 0) {
      return;
    }
    if (this.shouldScrollLocally()) {
      // xterm's native touch scroll is pre-empted above, so this handler is
      // the only local scroller — no doubled movement, and the accumulated
      // pixel remainder is what keeps a high-frequency drag from jumping.
      this.scrollLines(step.lines);
      return;
    }
    // Mouse-reporting and alternate-screen applications get the drag through
    // xterm's own wheel path, exactly like a desktop wheel.
    this.dispatchWheelFromTouch(touch, step.lines * this.getCellHeightForTouch());
  }

  private getCellHeightForTouch(): number {
    const cellHeight = this.getCellHeight();
    return cellHeight > 0 ? cellHeight : 16;
  }

  private dispatchWheelFromTouch(touch: Touch, deltaY: number): void {
    const element = this.terminal.element;
    if (!element) {
      return;
    }
    const point = typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(touch.clientX, touch.clientY)
      : null;
    const target = point && element.contains(point) ? point : element;
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
      cancelable: true,
    }));
  }

  scheduleScrollToMarginBottom(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.wasFollowing) {
          this.scrollToMarginBottom();
        }
      });
    });
  }

  /** Call after terminal.write when output arrived while pinned to live bottom. */
  afterOutputWhileFollowing(): void {
    if (this.wasFollowing) {
      this.scheduleScrollToMarginBottom();
    }
  }

  /** Snapshot follow state before write — xterm auto-scroll resets viewport. */
  snapshotFollowing(): boolean {
    this.wasFollowing = this.currentMode === 'following'
      && this.isFollowingMarginBottom()
      && this.clearanceOffsetPx >= this.targetClearanceOffset();
    return this.wasFollowing;
  }

  private ensureDockObserved(): void {
    const dock = this.host.querySelector('[data-testid="terminal-capsule"]');
    if (!(dock instanceof HTMLElement) || dock === this.observedDock) {
      return;
    }
    this.observedDock = dock;
    this.resizeObserver?.observe(dock);
  }

  /**
   * Whether the wheel belongs to Nession's local history or to the application.
   *
   * Two questions, and the second is the one that used to be answered by guess.
   *
   * First: is there local history to scroll? That is `buffer.type === 'normal'`
   * with a scrollback longer than the viewport.
   *
   * Second: is the application asking for mouse input? A TUI that turned mouse
   * tracking on reads the wheel as a gesture *inside itself* — htop, `less`,
   * vim with `set mouse=a`, Claude Code — and taking that event for local
   * history silently breaks it. Buffer type cannot answer this: an application
   * may run in the normal buffer with tracking enabled, which is exactly how a
   * full-screen TUI ends up scrolled by its own terminal (#1096).
   *
   * Reading the mode xterm already tracks is the point of the requirement — the
   * answer comes from the terminal's state, not from a proxy for it.
   */
  private shouldScrollLocally(): boolean {
    if (this.terminal.readModes().mouseTrackingMode !== 'none') {
      return false;
    }
    const buffer = this.terminal.readBuffer();
    // Even without historical buffer lines, the expanded panel introduces a
    // reversible visual pan range. Swipes must be able to spend that range.
    return buffer.type === 'normal' && (
      buffer.length > this.terminal.rows
      || this.clearanceOffsetPx > 0
      || this.targetClearanceOffset() > 0
    );
  }
}
