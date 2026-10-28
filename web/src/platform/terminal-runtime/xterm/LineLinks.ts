import type { LogicalLineCell, LogicalTerminalLine } from './XtermMetrics';
import type { TerminalLinkRange } from '../emulator';

/** One link resolved to xterm buffer coordinates (1-based, end exclusive). */
export interface MappedTerminalLink {
  readonly text: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
  activate(): void;
}

function positionOf(cell: LogicalLineCell): { x: number; y: number } {
  return { x: cell.cell + 1, y: cell.bufferLine };
}

/**
 * Map a matcher's UTF-16 offsets onto the cells xterm is drawing (#2581 SC-05).
 *
 * `readLogicalLine` records the cell of every code unit, so a wide character
 * (one code point, two cells) and a combining sequence (many code units, one
 * cell) both resolve to the cell xterm actually painted. The end position is
 * `lastCell + width + 1`, matching xterm's own link convention: `x` is 1-based
 * and the end is exclusive.
 *
 * Out-of-range ranges are dropped rather than clamped. A matcher that returns
 * a stale span must not underline cells it did not match.
 */
export function mapLineLinks(
  line: LogicalTerminalLine,
  ranges: readonly TerminalLinkRange[],
): MappedTerminalLink[] {
  const links: MappedTerminalLink[] = [];
  for (const range of ranges) {
    const startIndex = range.startIndex;
    const endIndex = range.endIndex;
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) { continue; }
    if (startIndex < 0 || endIndex <= startIndex || endIndex > line.cells.length) { continue; }
    const startCell = line.cells[startIndex];
    const endCell = line.cells[endIndex - 1];
    if (!startCell || !endCell) { continue; }
    links.push({
      text: line.text.slice(startIndex, endIndex),
      start: positionOf(startCell),
      end: { x: endCell.cell + endCell.width + 1, y: endCell.bufferLine },
      activate: () => range.activate(),
    });
  }
  return links;
}
