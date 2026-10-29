// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TerminalGeometry, type TerminalGeometryHost } from '../../TerminalGeometry';
import type { TerminalCellSize } from '../../../emulator';
import { DEFAULT_TERMINAL_COLS } from '../../../terminalConfig';

let captured: ResizeObserverCallback | null = null;

class CapturingResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    captured = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function installObserver(): () => void {
  const original = globalThis.ResizeObserver;
  captured = null;
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  return () => { globalThis.ResizeObserver = original; };
}

function fire(width: number, height: number): void {
  captured!([{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
    {} as ResizeObserver);
}

interface Harness {
  host: TerminalGeometryHost;
  measureCount: () => number;
  measuredSizes: number[];
  localResizes: Array<[number, number]>;
  sentResizes: Array<[number, number]>;
  published: Array<[number, number]>;
  contentWidths: Array<{ contentWidth: number; fits: boolean }>;
  setCell: (cell: TerminalCellSize) => void;
}

function makeHarness(
  fontCell: (fontSize: number) => TerminalCellSize = () => ({ width: 8, height: 16 }),
): Harness {
  let cell: TerminalCellSize = { width: 8, height: 16 };
  let measured = 0;
  const measuredSizes: number[] = [];
  const localResizes: Array<[number, number]> = [];
  const sentResizes: Array<[number, number]> = [];
  const published: Array<[number, number]> = [];
  const contentWidths: Array<{ contentWidth: number; fits: boolean }> = [];
  const host: TerminalGeometryHost = {
    isObserverReadOnly: false,
    statedTerminalCols: null,
    get cellDimensions() { return cell; },
    measureFont: (fontSize) => {
      measured += 1;
      measuredSizes.push(fontSize);
      return fontCell(fontSize);
    },
    resizeLocal: (cols, rows) => { localResizes.push([cols, rows]); },
    resizeLocalOrdered: (cols, rows) => { localResizes.push([cols, rows]); },
    publishViewportResize: (cols, rows) => { published.push([cols, rows]); },
    sendResize: (cols, rows) => { sentResizes.push([cols, rows]); },
    applyContentWidth: (_container, contentWidth, fits) => {
      contentWidths.push({ contentWidth, fits });
    },
  };
  return {
    host,
    measureCount: () => measured,
    measuredSizes,
    localResizes,
    sentResizes,
    published,
    contentWidths,
    setCell: (next) => { cell = next; },
  };
}

describe('TerminalGeometry fixed-column sizing (#2581 SC-06)', () => {
  it('fits the font once for a width, then only recomputes rows on height changes', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      const container = document.createElement('div');
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);

      fire(1024, 600);
      const afterFirstFit = h.measureCount();
      expect(afterFirstFit).toBeGreaterThan(0);
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 37]);

      // Height-only: rows follow the cell already measured, and the width fit
      // is not walked again.
      fire(1024, 640);
      expect(h.measureCount()).toBe(afterFirstFit);
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 40]);

      // Width moved: the font is fitted again for the new content box.
      fire(1200, 640);
      expect(h.measureCount()).toBeGreaterThan(afterFirstFit);
      geometry.dispose();
    } finally {
      restore();
    }
  });

  it('a user zoom keeps the chosen font and recomputes rows only', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      const container = document.createElement('div');
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);
      fire(1024, 600);
      const measured = h.measureCount();

      // The zoom path: the emulator reports a new cell and calls remeasure
      // with fitFont false.
      h.setCell({ width: 10, height: 20 });
      geometry.remeasure({ fitFont: false });

      expect(h.measureCount()).toBe(measured);
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 30]);
      geometry.dispose();
    } finally {
      restore();
    }
  });

  it('fits an App-width box below 6px without a device-profile ceiling', () => {
    const restore = installObserver();
    try {
      // 96 columns at 0.5 × font: a 280 px content box needs about 5.83 px.
      const h = makeHarness((fontSize) => ({
        width: fontSize * 0.5,
        height: fontSize * 1.4,
      }));
      const container = document.createElement('div');
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);
      fire(280, 700);

      expect(h.measuredSizes[0]).toBe(14);
      const chosen = h.measuredSizes[h.measuredSizes.length - 1];
      expect(chosen).toBeGreaterThan(5.7);
      expect(chosen).toBeLessThan(5.9);
      expect(chosen).toBeLessThan(6);
      expect(h.localResizes[h.localResizes.length - 1]?.[0]).toBe(DEFAULT_TERMINAL_COLS);
      const content = h.contentWidths[h.contentWidths.length - 1];
      expect(content?.fits).toBe(true);
      expect(content?.contentWidth).toBeLessThanOrEqual(280);
      geometry.dispose();
    } finally {
      restore();
    }
  });

  it('does not report an unchanged grid twice to the transport', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      const container = document.createElement('div');
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);

      fire(1024, 600);
      expect(h.sentResizes).toEqual([[DEFAULT_TERMINAL_COLS, 37]]);

      // Same box again — the debounced drag path must not restate the size.
      fire(1024, 600);
      expect(h.sentResizes).toEqual([[DEFAULT_TERMINAL_COLS, 37]]);
      geometry.dispose();
    } finally {
      restore();
    }
  });
});
