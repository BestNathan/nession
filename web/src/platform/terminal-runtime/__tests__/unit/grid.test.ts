import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FALLBACK_CELL, cellDimensionsOf, gridFor } from '../../grid';

/** The App fixture's real numbers at 390×844, measured in a browser. */
const CONTENT_BOX = { width: 362, height: 792 };
const CELL = { width: 7.5, height: 17.5 };

describe('gridFor', () => {
  it('floors the grid to what fits', () => {
    expect(gridFor(CONTENT_BOX, CELL)).toEqual({
      cols: Math.floor(362 / 7.5),
      rows: Math.floor(792 / 17.5),
    });
  });

  it('never asks for a grid wider than the box it was given', () => {
    // The invariant the whole fix rests on (#1092): xterm sizes its screen to
    // `cols * cell.width`, so a grid that fits inside the box cannot draw
    // outside it. Every other property here is a detail of this one.
    for (let width = 10; width <= 2000; width += 7) {
      const grid = gridFor({ width, height: 600 }, CELL);
      if (grid === null) {
        continue;
      }
      expect(grid.cols * CELL.width).toBeLessThanOrEqual(width);
      expect(grid.rows * CELL.height).toBeLessThanOrEqual(600);
    }
  });

  it('measures the *content* box, so a padded box over-fills', () => {
    // The fixture's mistake, pinned as arithmetic rather than as prose. Its
    // shell is 390 wide with 14px of inset, so the content box is 362 — and
    // anything fitted against the padded 390 asks for a grid 28px too wide.
    const content = gridFor(CONTENT_BOX, CELL);
    const padded = gridFor({ width: 390, height: 792 }, CELL);
    expect(content).not.toBeNull();
    expect(padded).not.toBeNull();
    expect(padded!.cols * CELL.width).toBeGreaterThan(CONTENT_BOX.width);
    expect(content!.cols * CELL.width).toBeLessThanOrEqual(CONTENT_BOX.width);
  });

  it('refuses a degenerate grid rather than clamping to one', () => {
    // xterm renders nothing useful below 2x2, and a clamped 1x1 would be a
    // layout the caller never asked for. Both callers skip instead.
    expect(gridFor({ width: 10, height: 10 }, CELL)).toBeNull();
    expect(gridFor({ width: 362, height: 10 }, CELL)).toBeNull();
    expect(gridFor({ width: 0, height: 0 }, CELL)).toBeNull();
  });

  it('refuses a cell it cannot divide by', () => {
    expect(gridFor(CONTENT_BOX, { width: 0, height: 17.5 })).toBeNull();
    expect(gridFor(CONTENT_BOX, { width: 7.5, height: 0 })).toBeNull();
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
