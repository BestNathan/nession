import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FALLBACK_CELL } from '../../../grid';
import { cellDimensionsOf, measuredCellDimensionsOf } from '../../XtermMetrics';

describe('measuredCellDimensionsOf', () => {
  it('says "not measured" rather than guessing, before the renderer has run', () => {
    // The distinction the fixture needs: a caller that can wait must be able to
    // tell "no measurement yet" from "a measured 8x16", because fitting a grid
    // to the fallback asks for the wrong column count and nothing corrects it
    // afterwards. Measured on CI at 844×390 — 102 columns drawn 864px wide in
    // an 816px well, from exactly this confusion.
    expect(measuredCellDimensionsOf(new Terminal())).toBeNull();
  });

  it('says "not measured" for a zero cell rather than reporting zero', () => {
    const zeroed = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } },
    } as unknown as Terminal;
    expect(measuredCellDimensionsOf(zeroed)).toBeNull();
  });

  it('reports a real measurement verbatim', () => {
    const measured = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 7.5, height: 17.5 } } } } },
    } as unknown as Terminal;
    expect(measuredCellDimensionsOf(measured)).toEqual({ width: 7.5, height: 17.5 });
  });
});

describe('cellDimensionsOf', () => {
  it('reports the fallback before the renderer has measured a cell', () => {
    // A terminal that was never opened has no render service at all, which is
    // the state both callers reach on their first pass.
    expect(cellDimensionsOf(new Terminal())).toEqual(FALLBACK_CELL);
  });

  it('reports the fallback for a terminal whose internals are unreadable', () => {
    // The access is to xterm's private fields and *throws* until the renderer's
    // first layout pass, so the guard is the point of this function: a caller
    // that reached in directly would take the throw.
    const hostile = {
      get _core(): never {
        throw new Error('dimensions getter throws until first layout');
      },
    } as unknown as Terminal;
    expect(cellDimensionsOf(hostile)).toEqual(FALLBACK_CELL);
  });

  it('reports a zero cell as the fallback rather than as zero', () => {
    // A zero would divide into an infinite grid; `gridFor` guards it too, but
    // the reported cell should never be a number nobody can divide by.
    const zeroed = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } },
    } as unknown as Terminal;
    expect(cellDimensionsOf(zeroed)).toEqual(FALLBACK_CELL);
  });
});
