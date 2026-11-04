import { isTouchOwned } from '@/shared/lib/touchOwnership';
import type {
  TerminalBufferSnapshot,
  TerminalDisposable,
  TerminalModeSnapshot,
} from '../emulator';

export const TERMINAL_CAPSULE_OCCLUSION_EVENT = 'terminal-capsule-occlusion';

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
  private resizeDisposable: { dispose(): void } | null = null;
  private occlusionListener: (() => void) | null = null;
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
  }

  bind(): void {
    const onOcclusionGeometryChange = () => {
      this.ensureDockObserved();
      if (this.wasFollowing) {
        this.scheduleScrollToMarginBottom();
      }
    };

    const updateFollowingFromScroll = () => {
      const following = this.isFollowingMarginBottom();
      this.setMode(following ? 'following' : 'history');
    };

    this.scrollDisposable = this.terminal.onScroll(updateFollowingFromScroll);
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.observedDock = null;
    this.scrollDisposable?.dispose();
    this.scrollDisposable = null;
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
    if (lines < 0) {
      this.enterHistory();
    }
    event.preventDefault();
    event.stopPropagation();
    this.terminal.scrollLines(lines);
    this.syncModeFromViewport();
    return false;
  }

  scrollPages(pages: number): void {
    if (pages < 0) {
      this.enterHistory();
    }
    this.terminal.scrollPages(pages);
    this.syncModeFromViewport();
  }

  scrollLines(lines: number): void {
    if (lines < 0) {
      this.enterHistory();
    }
    this.terminal.scrollLines(lines);
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
  }

  private syncModeFromViewport(): void {
    this.setMode(this.isFollowingMarginBottom() ? 'following' : 'history');
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
      if (step.lines < 0) {
        this.enterHistory();
      }
      this.terminal.scrollLines(step.lines);
      this.syncModeFromViewport();
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
    this.wasFollowing = this.currentMode === 'following' && this.isFollowingMarginBottom();
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
    return buffer.type === 'normal' && buffer.length > this.terminal.rows;
  }
}
