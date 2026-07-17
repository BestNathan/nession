import type { Terminal } from '@xterm/xterm';

/**
 * Default cell dimensions used when xterm's render service is unavailable.
 * Derived from a 14px monospace font at devicePixelRatio=1 (cell width ≈ 8.4px,
 * height ≈ 16.8px, rounded down to integer pixel values). These are only a
 * fallback — normally the real values are read from xterm's internal render
 * service. A debug message is logged when this fallback is hit so mismatches
 * are visible during development.
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
 * Replaces ViewportManager — no longer fits the terminal to the viewport.
 * Instead, responds to tmux resize messages (cols/rows) and updates both
 * the xterm.js terminal size and the container pixel dimensions accordingly.
 *
 * Container pixel dimensions are derived from the current cell size reported
 * by xterm's internal render service, so they stay in sync with font size
 * and zoom changes.
 */
export class TerminalSizeManager {
  private readonly term: Terminal;
  private readonly mountElement: HTMLElement;
  private disposed = false;

  /**
   * @param term - xterm.js Terminal instance to drive resize/fit operations on.
   * @param _scrollContainer - Reserved for Task 10 (scroll-position preservation
   *   when CSS-transform scaling is wired in via ScalingManager). Accepted now
   *   so the constructor signature is stable across the refactor; not yet stored
   *   or used.
   * @param mountElement - DOM element whose pixel dimensions are updated to
   *   match the terminal's computed cell size × (cols, rows).
   */
  constructor(
    term: Terminal,
    _scrollContainer: HTMLElement,
    mountElement: HTMLElement,
  ) {
    this.term = term;
    this.mountElement = mountElement;
  }

  /**
   * Handle a resize event originating from tmux.
   * Updates the xterm terminal dimensions and the mount element's pixel size.
   */
  handleResize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.term.resize(cols, rows);
    this.updateContainerSize(cols, rows);
  }

  private updateContainerSize(cols: number, rows: number): void {
    const { width, height } = getCellDimensions(this.term);
    this.mountElement.style.width = `${cols * width}px`;
    this.mountElement.style.height = `${rows * height}px`;
  }

  dispose(): void {
    this.disposed = true;
  }
}
