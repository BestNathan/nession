import { describe, expect, it, vi } from 'vitest';
import { mapLineLinks } from '../../LineLinks';
import type { LogicalLineCell, LogicalTerminalLine } from '../../XtermMetrics';
import type { TerminalLinkRange } from '../../../emulator';

/** One xterm cell: `chars` may be several code units (a combining sequence). */
interface LineCell {
  chars: string;
  width: number;
  cell: number;
  bufferLine?: number;
}

function logicalLine(cells: LineCell[]): LogicalTerminalLine {
  let text = '';
  const mapped: LogicalLineCell[] = [];
  for (const entry of cells) {
    text += entry.chars;
    for (let unit = 0; unit < entry.chars.length; unit += 1) {
      mapped.push({
        bufferLine: entry.bufferLine ?? 1,
        cell: entry.cell,
        width: entry.width,
      });
    }
  }
  return { text, cells: mapped };
}

/** One width-1 cell per code unit, as a plain string occupies the buffer. */
function asciiCells(text: string, startCell: number, bufferLine = 1): LineCell[] {
  return Array.from(text).map((char, index) => ({
    chars: char,
    width: 1,
    cell: startCell + index,
    bufferLine,
  }));
}

function range(startIndex: number, endIndex: number): TerminalLinkRange {
  return { startIndex, endIndex, activate: vi.fn() };
}

/** The fixture every case below matches in: `src/foo.rs`. */
const PATH = 'src/foo.rs';

describe('mapLineLinks (#2581 SC-05)', () => {
  it('maps ASCII offsets to the cells xterm draws', () => {
    const line = logicalLine([...asciiCells('cd ', 0), ...asciiCells(PATH, 3)]);
    const start = line.text.indexOf(PATH);

    const [link] = mapLineLinks(line, [range(start, start + PATH.length)]);

    expect(link!.text).toBe(PATH);
    expect(link!.start).toEqual({ x: 4, y: 1 });
    // End is exclusive and 1-based: last cell (12) + width (1) + 1.
    expect(link!.end).toEqual({ x: 14, y: 1 });
  });

  it('accounts for a wide character occupying two cells', () => {
    // '中' is one code point but two cells, so the path after it starts one
    // cell later than its UTF-16 index would suggest.
    const line = logicalLine([
      { chars: '中', width: 2, cell: 0 },
      ...asciiCells(' ', 2),
      ...asciiCells(PATH, 3),
    ]);
    const start = line.text.indexOf(PATH);

    const [link] = mapLineLinks(line, [range(start, start + PATH.length)]);

    // cells: 中=0 (width 2), space=2, path starts at cell 3 → 1-based x 4.
    expect(link!.start).toEqual({ x: 4, y: 1 });
    expect(link!.end).toEqual({ x: 14, y: 1 });
  });

  it('keeps a combining sequence on the one cell xterm stores it in', () => {
    // 'e' + U+0301 is two UTF-16 units in one cell; offsets after it must not
    // be shifted by the extra code unit.
    const line = logicalLine([
      { chars: 'é', width: 1, cell: 0 },
      ...asciiCells(' ', 1),
      ...asciiCells(PATH, 2),
    ]);
    const start = line.text.indexOf(PATH);

    const [link] = mapLineLinks(line, [range(start, start + PATH.length)]);

    expect(link!.start).toEqual({ x: 3, y: 1 });
    expect(link!.end).toEqual({ x: 13, y: 1 });
  });

  it('spans a wrapped continuation line for a match crossing the wrap', () => {
    // 10 cells on buffer line 1; the path continues at cell 0 of line 2.
    const line = logicalLine([
      ...asciiCells('abcdefghij', 0, 1),
      ...asciiCells(PATH, 0, 2),
    ]);

    const [link] = mapLineLinks(line, [range(0, line.text.length)]);

    expect(link!.start).toEqual({ x: 1, y: 1 });
    expect(link!.end).toEqual({ x: 11, y: 2 });
  });

  it('drops an out-of-range match instead of clamping it', () => {
    const line = logicalLine(asciiCells(PATH, 0));

    expect(mapLineLinks(line, [range(0, PATH.length + 5)])).toEqual([]);
    expect(mapLineLinks(line, [range(-1, 3)])).toEqual([]);
    expect(mapLineLinks(line, [range(3, 3)])).toEqual([]);
    expect(mapLineLinks(line, [range(1.5, 4)])).toEqual([]);
  });

  it('runs the matcher-owned activation', () => {
    const line = logicalLine(asciiCells(PATH, 0));
    const match = range(0, PATH.length);

    const [link] = mapLineLinks(line, [match]);
    link!.activate();

    expect(match.activate).toHaveBeenCalledTimes(1);
  });
});
