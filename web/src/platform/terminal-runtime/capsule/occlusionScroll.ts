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
  private touchStartX: number | null = null;
  private touchStartY: number | null = null;
  private touchLastY: number | null = null;
  private touchAxis: 'pending' | 'horizontal' | 'vertical' = 'pending';
  private touchScrollRemainder = 0;
  private touchEndListener: (() => void) | null = null;
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

      this.touchStartListener = (event) => {
        const touch = event.touches.length === 1 ? event.touches[0] : null;
        this.touchStartX = touch?.clientX ?? null;
        this.touchStartY = touch?.clientY ?? null;
        this.touchLastY = touch?.clientY ?? null;
        this.touchAxis = 'pending';
        this.touchScrollRemainder = 0;
      };
      this.touchMoveListener = (event) => this.handleTouchMove(event);
      this.touchEndListener = () => this.resetTouch();
      element.addEventListener('touchstart', this.touchStartListener, { capture: true, passive: true });
      element.addEventListener('touchmove', this.touchMoveListener, { capture: true, passive: false });
      element.addEventListener('touchend', this.touchEndListener, true);
      element.addEventListener('touchcancel', this.touchEndListener, true);
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
    const element = this.terminal.element;
    this.terminal.attachCustomWheelHandler(() => true);
    if (element && this.touchStartListener) {
      element.removeEventListener('touchstart', this.touchStartListener, true);
    }
    if (element && this.touchMoveListener) {
      element.removeEventListener('touchmove', this.touchMoveListener, true);
    }
    if (element && this.touchEndListener) {
      element.removeEventListener('touchend', this.touchEndListener, true);
      element.removeEventListener('touchcancel', this.touchEndListener, true);
    }
    this.touchStartListener = null;
    this.touchMoveListener = null;
    this.touchEndListener = null;
    this.resetTouch();
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

  private resetTouch(): void {
    this.touchStartX = null;
    this.touchStartY = null;
    this.touchLastY = null;
    this.touchAxis = 'pending';
    this.touchScrollRemainder = 0;
  }

  /**
   * A one-finger vertical drag is a scroll, not a synthetic cursor movement.
   * Local scrollback stays local; mouse-tracking/full-screen TUIs receive the
   * same wheel path as a desktop scroll. In particular, returning early for
   * alternate buffers left mobile users unable to scroll Claude Code/Vim.
   */
  private handleTouchMove(event: TouchEvent): void {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!touch || this.touchStartX === null || this.touchStartY === null || this.touchLastY === null) {
      this.resetTouch();
      return;
    }
    const dx = touch.clientX - this.touchStartX;
    const dy = touch.clientY - this.touchStartY;
    const deltaY = touch.clientY - this.touchLastY;
    this.touchLastY = touch.clientY;

    // Keep taps, horizontal selection and the shell's edge pager untouched.
    if (this.touchAxis === 'pending') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) { return; }
      this.touchAxis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    if (this.touchAxis !== 'vertical' || deltaY === 0) { return; }

    if (this.shouldScrollLocally()) {
      // Accumulate sub-cell deltas. Rounding each touchmove up to one line
      // turned a slow finger drag into a runaway scroll on high-Hz phones.
      const cellHeight = this.getCellHeight() || 16;
      this.touchScrollRemainder -= deltaY;
      const lines = Math.trunc(this.touchScrollRemainder / cellHeight);
      this.touchScrollRemainder -= lines * cellHeight;
      event.preventDefault();
      event.stopPropagation();
      if (lines !== 0) {
        if (lines < 0) { this.enterHistory(); }
        this.terminal.scrollLines(lines);
        this.syncModeFromViewport();
      }
      return;
    }

    // xterm's 5.5 touch path only scrolls its viewport. It cannot deliver the
    // wheel reports that a mouse-aware TUI consumes (or xterm's alternate-
    // buffer wheel-to-arrow fallback). Let xterm encode those modes itself.
    const mode = this.terminal.readModes();
    const buffer = this.terminal.readBuffer();
    if (mode.mouseTrackingMode === 'none' && buffer.type !== 'alternate') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : this.terminal.element;
    target?.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -deltaY,
      deltaMode: 0,
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
