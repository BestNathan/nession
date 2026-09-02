import type { Terminal } from '@xterm/xterm';

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
  private observer: ResizeObserver | null = null;
  private scrollDisposable: { dispose(): void } | null = null;
  private resizeDisposable: { dispose(): void } | null = null;
  private wasFollowing = true;

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
    const updateFollowingFromScroll = () => {
      this.wasFollowing = this.isFollowingMarginBottom();
    };

    this.scrollDisposable = this.terminal.onScroll(updateFollowingFromScroll);
    this.resizeDisposable = this.terminal.onResize(() => {
      if (this.wasFollowing) {
        this.scrollToMarginBottom();
      }
    });
    this.observer = new ResizeObserver(() => {
      if (this.wasFollowing) {
        this.scrollToMarginBottom();
      }
    });
    this.observer.observe(this.host);
    updateFollowingFromScroll();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
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

  /** Call after terminal.write when output arrived while pinned to live bottom. */
  afterOutputWhileFollowing(): void {
    if (this.wasFollowing) {
      this.scrollToMarginBottom();
    }
  }

  /** Snapshot follow state before write — xterm auto-scroll resets viewport. */
  snapshotFollowing(): boolean {
    this.wasFollowing = this.isFollowingMarginBottom();
    return this.wasFollowing;
  }
}
