// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TerminalGeometry, type TerminalGeometryHost } from '../../TerminalGeometry';
import type { TerminalCellSize } from '../../../emulator';
import { DEFAULT_TERMINAL_COLS } from '../../../terminalConfig';
import {
  TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT,
  TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE,
  type TerminalClearancePolicy,
  type TerminalClearanceState,
} from '../../../capsule/clearancePolicy';
import { TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT } from '../../../capsule/occlusionScroll';

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
  setPolicy: (policy: TerminalClearancePolicy) => void;
  setObserver: (observer: boolean) => void;
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
  let policy: TerminalClearancePolicy = 'scroll-clearance';
  let observer = false;
  const host: TerminalGeometryHost = {
    get isObserverReadOnly() { return observer; },
    get clearancePolicy() { return policy; },
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
    setPolicy: (next) => { policy = next; },
    setObserver: (next) => { observer = next; },
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

  it('reserves real rows for a full-screen TUI and ignores the panel for a normal shell', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      const host = document.createElement('div');
      host.setAttribute('data-terminal-capsule-host', '');
      const container = document.createElement('div');
      host.appendChild(container);
      document.body.appendChild(host);
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);
      fire(1024, 600);
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 37]);

      // The normal-buffer scroll policy never spends the panel on rows (#2710).
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '160px');
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT));
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 37]);

      // An alternate/mouse-owning TUI reserves the panel's height.
      h.setPolicy('viewport-reserve');
      geometry.onClearancePolicyChanged();
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 27]);

      // Closing the panel derives rows from the current box again.
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '0px');
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT));
      expect(h.localResizes[h.localResizes.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 37]);
      geometry.dispose();
      host.remove();
    } finally {
      restore();
    }
  });

  it('publishes a compact fallback when the reserve cannot cover the panel', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      h.setPolicy('viewport-reserve');
      h.setObserver(true);
      const host = document.createElement('div');
      host.setAttribute('data-terminal-capsule-host', '');
      const container = document.createElement('div');
      host.appendChild(container);
      document.body.appendChild(host);
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '160px');
      const observed: { state: TerminalClearanceState | null } = { state: null };
      host.addEventListener(TERMINAL_CAPSULE_CLEARANCE_STATE_EVENT, (event) => {
        observed.state = (event as CustomEvent<TerminalClearanceState>).detail;
      });
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);
      fire(1024, 600);

      expect(host.getAttribute(TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE)).toBe('compact');
      expect(observed.state?.fallback).toBe(true);
      expect(observed.state?.policy).toBe('viewport-reserve');
      // An observer publishes the observed grid but never sends a resize.
      expect(h.published[h.published.length - 1]).toEqual([DEFAULT_TERMINAL_COLS, 27]);
      expect(h.sentResizes).toEqual([]);
      geometry.dispose();
      host.remove();
    } finally {
      restore();
    }
  });

  it('latches the compact fallback so its own smaller height cannot oscillate', () => {
    const restore = installObserver();
    try {
      const h = makeHarness();
      h.setPolicy('viewport-reserve');
      const host = document.createElement('div');
      host.setAttribute('data-terminal-capsule-host', '');
      const container = document.createElement('div');
      host.appendChild(container);
      document.body.appendChild(host);
      // Taller than the reserve cap on a 600px box with 16px cells leaves
      // fewer than MIN_RESERVED_ROWS.
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '560px');
      const geometry = new TerminalGeometry(h.host);
      geometry.observe(container, 8, 16);
      fire(1024, 600);
      expect(host.getAttribute(TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE)).toBe('compact');

      // The compact panel now reports a smaller height. The fallback must stay
      // latched; otherwise it would expand, fail the reserve and loop.
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '100px');
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT));
      expect(host.getAttribute(TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE)).toBe('compact');

      // Closing clears it.
      container.style.setProperty('--nession-local-terminal-capsule-panel-clearance', '0px');
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT));
      expect(host.getAttribute(TERMINAL_CAPSULE_FALLBACK_ATTRIBUTE)).toBeNull();
      geometry.dispose();
      host.remove();
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
