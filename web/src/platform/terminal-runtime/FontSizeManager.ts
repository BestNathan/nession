import type { Terminal } from '@xterm/xterm';

const MIN_FONT = 8;
const MAX_FONT = 40;
const STEP = 1;

/**
 * Manages font-size zoom for the terminal.
 *
 * Zoom in/out mutates xterm's `options.fontSize`, which changes the cell
 * width/height. After the change, `term.refresh(0, rows-1)` forces xterm to
 * re-measure cells immediately (otherwise it happens on next repaint).
 * The `onCellSizeChange` callback lets `TerminalSizeManager` refresh the
 * mount element's pixel dimensions so the DOM stays consistent.
 *
 * Zoom is NEVER implemented via CSS transform. Transform breaks the
 * mouse-coordinate mapping xterm expects (clicks land at wrong cells).
 */
export class FontSizeManager {
  constructor(
    private readonly term: Terminal,
    private readonly onCellSizeChange: () => void,
    private readonly defaultSize: number,
  ) {}

  getSize(): number {
    return this.term.options.fontSize ?? this.defaultSize;
  }

  zoomIn(): void {
    this.setSize(this.getSize() + STEP);
  }

  zoomOut(): void {
    this.setSize(this.getSize() - STEP);
  }

  reset(): void {
    this.setSize(this.defaultSize);
  }

  private setSize(next: number): void {
    const clamped = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
    if (clamped === this.getSize()) {
      return;
    }
    this.term.options.fontSize = clamped;
    // Force xterm to re-measure cells now rather than on next repaint,
    // so getCellDimensions() called from onCellSizeChange sees fresh values.
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
    this.onCellSizeChange();
  }
}
