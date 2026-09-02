import type { Terminal } from '@xterm/xterm';

export const TERMINAL_CAPSULE_OCCLUSION_EVENT = 'terminal-capsule-occlusion';

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
  private wasFollowing = true;
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
      this.wasFollowing = this.isFollowingMarginBottom();
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
  }

  marginLines(): number {
    return marginLinesFromOcclusion(readOcclusionPx(this.host), this.getCellHeight());
  }

  isFollowingMarginBottom(): boolean {
    const buffer = this.terminal.buffer.active;
    return isFollowingMarginBottom(
      buffer.viewportY,
      buffer.length,
      this.terminal.rows,
      this.marginLines(),
    );
  }

  /** Pin to live bottom — content stops above the fake-terminal band. */
  scrollToMarginBottom(): void {
    const margin = this.marginLines();
    this.terminal.scrollToBottom();
    if (margin > 0) {
      this.terminal.scrollLines(-margin);
    }
    this.wasFollowing = true;
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
    this.wasFollowing = this.isFollowingMarginBottom();
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
}
