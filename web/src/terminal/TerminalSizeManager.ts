import type { Terminal } from '@xterm/xterm';

/** Default cell dimensions used when xterm's render service is unavailable. */
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
  const width = renderService?.dimensions?.css?.cell?.width ?? DEFAULT_CELL_WIDTH;
  const height = renderService?.dimensions?.css?.cell?.height ?? DEFAULT_CELL_HEIGHT;
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
  private readonly mountElement: HTMLElement;
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    _scrollContainer: HTMLElement,
    mountElement: HTMLElement,
  ) {
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
