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
    if (this.disposed) {
      return;
    }
    this.term.resize(cols, rows);
    this.setMountPixels(cols, rows);
  }

  /**
   * Refresh mount element pixel size using current term cols/rows and current
   * cell dimensions. Call this after fontSize changes.
   */
  recompute(): void {
    if (this.disposed) {
      return;
    }
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
