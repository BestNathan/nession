import { describe, expect, it } from 'vitest';
import { fitFontToColumns, rowsForHeight } from '@/platform/terminal-runtime/sizing';

/** A font whose cell is linear in the font size (a stable mono face). */
function linear(fontSize: number) {
  return { width: fontSize * 0.5, height: fontSize * 1.4 };
}

describe('fixed-column font fitting (#2487, #2592)', () => {
  it('keeps the configured maximum when the columns fit', () => {
    const fit = fitFontToColumns({
      cols: 88,
      availableWidth: 2000,
      maxFontSize: 14,
      measureCell: () => ({ width: 8.4, height: 19.6 }),
    });
    expect(fit).not.toBeNull();
    expect(fit?.fontSize).toBe(14);
    expect(fit?.fits).toBe(true);
    expect(fit?.contentWidth).toBeCloseTo(88 * 8.4);
  });

  it('shrinks the font to fit a narrower viewport, never the columns', () => {
    // 96 columns at 0.5 × font: 250 px allows exactly 5.2 px.
    const fit = fitFontToColumns({
      cols: 96,
      availableWidth: 250,
      maxFontSize: 14,
      measureCell: linear,
    });
    expect(fit).not.toBeNull();
    expect(fit?.fits).toBe(true);
    expect(fit?.fontSize).toBeGreaterThan(5.1);
    expect(fit?.fontSize).toBeLessThanOrEqual(5.21);
    expect(fit?.contentWidth).toBeLessThanOrEqual(250);
  });

  it('chooses a font below 6 px when the fixed columns require it', () => {
    const fit = fitFontToColumns({
      cols: 96,
      availableWidth: 250,
      maxFontSize: 14,
      measureCell: linear,
    });
    expect(fit?.fontSize).toBeLessThan(6);
    expect(fit?.fontSize).toBeGreaterThan(0);
    expect(fit?.fits).toBe(true);
  });

  it('finds the largest fit across device-pixel quantization steps', () => {
    // Integer-pixel cells: the fit must measure, not scale linearly.
    const measure = (fontSize: number) => ({
      width: Math.floor(fontSize * 0.6),
      height: fontSize * 1.4,
    });
    const fit = fitFontToColumns({
      cols: 96,
      availableWidth: 300,
      maxFontSize: 14,
      measureCell: measure,
    });
    expect(fit).not.toBeNull();
    expect(fit?.fits).toBe(true);
    expect(fit?.cell.width).toBe(3);
    expect(96 * (fit?.cell.width ?? 0)).toBeLessThanOrEqual(300);
    // The next whole-pixel step would overflow; the chosen size sits just
    // below it rather than at a floor.
    expect(fit?.fontSize).toBeGreaterThan(6);
    expect(fit?.fontSize).toBeLessThan(6.7);
  });

  it('leaves the renderer at the returned size', () => {
    const sizes: number[] = [];
    const fit = fitFontToColumns({
      cols: 96,
      availableWidth: 250,
      maxFontSize: 14,
      measureCell: (fontSize) => {
        sizes.push(fontSize);
        return linear(fontSize);
      },
    });
    expect(fit).not.toBeNull();
    expect(sizes[sizes.length - 1]).toBe(fit?.fontSize);
    // The first probe is the release maximum, not a device-profile ceiling.
    expect(sizes[0]).toBe(14);
  });

  it('reports the smallest measured cell with fits=false when nothing fits', () => {
    const fit = fitFontToColumns({
      cols: 100,
      availableWidth: 50,
      maxFontSize: 14,
      measureCell: () => ({ width: 1, height: 1.4 }),
    });
    expect(fit).not.toBeNull();
    expect(fit?.fits).toBe(false);
    expect(fit?.fontSize).toBeLessThan(1);
    expect(fit?.contentWidth).toBeGreaterThan(50);
    expect(fit?.cell.width).toBeGreaterThan(0);
  });

  it('never counts a nonpositive cell as a fit', () => {
    // Below 4 px the renderer cannot measure a positive cell.
    const fit = fitFontToColumns({
      cols: 96,
      availableWidth: 100,
      maxFontSize: 14,
      measureCell: (fontSize) => (fontSize < 4
        ? { width: 0, height: 0 }
        : linear(fontSize)),
    });
    if (fit !== null) {
      expect(fit.cell.width).toBeGreaterThan(0);
      expect(fit.cell.height).toBeGreaterThan(0);
      if (fit.fits) {
        expect(fit.contentWidth).toBeLessThanOrEqual(100);
      }
    }
  });

  it('waits while the renderer cannot measure a cell', () => {
    expect(fitFontToColumns({
      cols: 88,
      availableWidth: 1200,
      maxFontSize: 14,
      measureCell: () => null,
    })).toBeNull();
  });

  it('rejects degenerate inputs', () => {
    expect(fitFontToColumns({
      cols: 1, availableWidth: 100, maxFontSize: 14, measureCell: linear,
    })).toBeNull();
    expect(fitFontToColumns({
      cols: 88, availableWidth: 0, maxFontSize: 14, measureCell: linear,
    })).toBeNull();
    expect(fitFontToColumns({
      cols: 88, availableWidth: 100, maxFontSize: 0, measureCell: linear,
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
