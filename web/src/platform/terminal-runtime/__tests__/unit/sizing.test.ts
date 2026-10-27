import { describe, expect, it } from 'vitest';
import { fitFontToColumns, rowsForHeight } from '@/platform/terminal-runtime/sizing';

/**
 * Cell metrics for a mono font, measured at the probe size. The width is
 * deliberately nonlinear (a per-size offset) so a fitter cannot pass by
 * assuming `fontSize × constant`.
 */
function measureAt(sizes: Record<string, number>) {
  return (fontSize: number) => {
    const width = sizes[fontSize.toFixed(1)];
    return width === undefined ? null : { width, height: fontSize * 1.4 };
  };
}

describe('fixed-column font fitting (#2487)', () => {
  it('keeps the configured maximum when the columns fit', () => {
    const fit = fitFontToColumns({
      cols: 88,
      availableWidth: 2000,
      minFontSize: 8,
      maxFontSize: 14,
      measureCell: measureAt({ '14.0': 8.4 }),
    });
    expect(fit).not.toBeNull();
    expect(fit?.fontSize).toBe(14);
    expect(fit?.fits).toBe(true);
    expect(fit?.contentWidth).toBeCloseTo(88 * 8.4);
  });

  it('shrinks the font to fit a narrower viewport, never the columns', () => {
    // The font scales linearly here: 14px -> 8.4px cell, 10px -> 6.0px cell.
    const measure = (fontSize: number) => ({ width: fontSize * 0.6, height: fontSize * 1.4 });
    const fit = fitFontToColumns({
      cols: 88,
      availableWidth: 88 * 6.0,
      minFontSize: 8,
      maxFontSize: 14,
      measureCell: measure,
    });
    expect(fit).not.toBeNull();
    expect(fit?.fits).toBe(true);
    expect(fit?.fontSize).toBeLessThanOrEqual(10.01);
    expect(fit?.contentWidth).toBeLessThanOrEqual(88 * 6.0 + 0.01);
  });

  it('reports the minimum font with fits=false when even that is too wide', () => {
    const measure = (fontSize: number) => ({ width: fontSize * 0.6, height: fontSize * 1.4 });
    const fit = fitFontToColumns({
      cols: 100,
      availableWidth: 300,
      minFontSize: 8,
      maxFontSize: 14,
      measureCell: measure,
    });
    expect(fit).not.toBeNull();
    expect(fit?.fontSize).toBe(8);
    expect(fit?.fits).toBe(false);
    expect(fit?.contentWidth).toBeCloseTo(100 * 4.8);
  });

  it('waits while the renderer cannot measure a cell', () => {
    expect(fitFontToColumns({
      cols: 88,
      availableWidth: 1200,
      minFontSize: 8,
      maxFontSize: 14,
      measureCell: () => null,
    })).toBeNull();
  });

  it('rejects degenerate inputs', () => {
    const measure = (fontSize: number) => ({ width: fontSize * 0.6, height: fontSize * 1.4 });
    expect(fitFontToColumns({
      cols: 1, availableWidth: 100, minFontSize: 8, maxFontSize: 14, measureCell: measure,
    })).toBeNull();
    expect(fitFontToColumns({
      cols: 88, availableWidth: 0, minFontSize: 8, maxFontSize: 14, measureCell: measure,
    })).toBeNull();
    expect(fitFontToColumns({
      cols: 88, availableWidth: 100, minFontSize: 14, maxFontSize: 8, measureCell: measure,
    })).toBeNull();
  });
});

describe('rows from usable height', () => {
  it('floors the height by the measured cell and enforces a usable floor', () => {
    expect(rowsForHeight(800, 20)).toBe(40);
    expect(rowsForHeight(819, 20)).toBe(40);
    expect(rowsForHeight(39, 20)).toBeNull();
    expect(rowsForHeight(0, 20)).toBeNull();
    expect(rowsForHeight(100, 0)).toBeNull();
  });
});
