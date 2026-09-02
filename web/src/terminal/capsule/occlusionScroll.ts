import type { Terminal } from '@xterm/xterm';

export const TERMINAL_CAPSULE_OCCLUSION_EVENT = 'terminal-capsule-occlusion';

export type ScrollMode = 'following' | 'history';

/** Read published occlusion height from the capsule host (inline style wins). */
export function readOcclusionPx(host: HTMLElement): number {
  const inline = host.style.getPropertyValue('--terminal-capsule-occlusion');
  const raw = inline || getComputedStyle(host).getPropertyValue('--terminal-capsule-occlusion');
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
  private readonly terminal: Terminal;
  private readonly host: HTMLElement;
  private readonly getCellHeight: () => number;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private scrollDisposable: { dispose(): void } | null = null;
  private resizeDisposable: { dispose(): void } | null = null;
  private occlusionListener: (() => void) | null = null;
  private touchStartListener: ((event: TouchEvent) => void) | null = null;
  private touchMoveListener: ((event: TouchEvent) => void) | null = null;
  private touchLastY: number | null = null;
  private wasFollowing = true;
  private currentMode: ScrollMode = 'following';
  private observedDock: HTMLElement | null = null;

  constructor(
    terminal: Terminal,
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
      this.terminal.attachCustomWheelEventHandler((event) => this.handleWheel(event));

      this.touchStartListener = (event) => {
        this.touchLastY = event.touches[0]?.clientY ?? null;
      };
      this.touchMoveListener = (event) => this.handleTouchMove(event);
      element.addEventListener('touchstart', this.touchStartListener, { capture: true, passive: true });
      element.addEventListener('touchmove', this.touchMoveListener, { capture: true, passive: false });
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
    this.terminal.attachCustomWheelEventHandler(() => true);
    if (element && this.touchStartListener) {
      element.removeEventListener('touchstart', this.touchStartListener, true);
    }
    if (element && this.touchMoveListener) {
      element.removeEventListener('touchmove', this.touchMoveListener, true);
    }
    this.touchStartListener = null;
    this.touchMoveListener = null;
    this.touchLastY = null;
    this.host.style.removeProperty('--terminal-content-bottom-inset');
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
    if (!this.hasLocalScrollback()) {
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
    const buffer = this.terminal.buffer.active;
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
      ? 'var(--terminal-capsule-occlusion, 0px)'
      : '0px';
    this.host.style.setProperty('--terminal-content-bottom-inset', inset);
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

  private handleTouchMove(event: TouchEvent): void {
    if (!this.hasLocalScrollback()) {
      return;
    }
    const currentY = event.touches[0]?.clientY;
    if (currentY === undefined || this.touchLastY === null) {
      this.touchLastY = currentY ?? null;
      return;
    }
    const deltaY = currentY - this.touchLastY;
    this.touchLastY = currentY;
    const lines = this.wheelLines(-deltaY, 0);
    if (lines === 0) {
      return;
    }
    if (lines < 0) {
      this.enterHistory();
    }
    event.preventDefault();
    event.stopPropagation();
    this.terminal.scrollLines(lines);
    this.syncModeFromViewport();
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

  private hasLocalScrollback(): boolean {
    const buffer = this.terminal.buffer.active;
    return buffer.type === 'normal' && buffer.length > this.terminal.rows;
  }
}
