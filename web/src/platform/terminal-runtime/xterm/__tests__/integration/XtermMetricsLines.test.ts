// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { readLogicalLine } from '../../XtermMetrics';

/** xterm.open() needs matchMedia in jsdom, the same stub the other suites use. */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function makeTerminal(cols = 40, rows = 8): Terminal {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  term.open(host);
  return term;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => { term.write(data, () => resolve()); });
}

describe('readLogicalLine (#2581 SC-05)', () => {
  it('trims trailing empty cells like translateToString(true)', async () => {
    const term = makeTerminal();
    await write(term, 'abc   ');

    expect(readLogicalLine(term, 1).text).toBe('abc');
    term.dispose();
  });

  it('records the cell of each code unit, including wide characters', async () => {
    const term = makeTerminal();
    const text = 'ab 中文 src/foo.rs:12';
    await write(term, text);

    const line = readLogicalLine(term, 1);
    const start = line.text.indexOf('src/foo.rs:12');

    expect(line.text).toBe(text);
    // cells: a=0 b=1 space=2 中=3(width 2) 文=5(width 2) space=7 → path at 8.
    expect(line.cells[start]).toEqual({ bufferLine: 1, cell: 8, width: 1 });
    expect(line.cells[start + 4]!.cell).toBe(12);
    term.dispose();
  });

  it('keeps a combining sequence on the cell xterm stored it in', async () => {
    const term = makeTerminal();
    const text = 'éx src/foo.rs';
    await write(term, text);

    const line = readLogicalLine(term, 1);
    const start = line.text.indexOf('src/foo.rs');

    expect(line.text).toBe(text);
    // 'e' + combining mark = one cell, 'x' = one, space = one → path at cell 3.
    expect(line.cells[start]).toEqual({ bufferLine: 1, cell: 3, width: 1 });
    term.dispose();
  });

  it('joins a wrapped continuation into one logical line', async () => {
    const term = makeTerminal(10, 4);
    await write(term, '0123456789src/foo.rs');

    const first = readLogicalLine(term, 1);
    expect(first.text).toBe('0123456789src/foo.rs');
    // The path continues on buffer line 2, starting at cell 0.
    expect(first.cells[10]).toEqual({ bufferLine: 2, cell: 0, width: 1 });

    // A continuation is not the start of a logical line; answering there would
    // duplicate every match once per visual row.
    expect(readLogicalLine(term, 2).text).toBe('');
    term.dispose();
  });
});
