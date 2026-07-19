import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TerminalSizeManager } from '../TerminalSizeManager';

/** Attach a fake _renderService with given cell dimensions. */
function mockRenderService(term: Terminal, cellWidth: number, cellHeight: number): void {
  // Reach into xterm's private state so tests can control the cell dimensions
  // getCellDimensions reads via `_core._renderService`. Kept in a narrow type
  // so it doesn't leak `any` and TypeScript still verifies the assignment.
  interface XtermInternals {
    _core?: {
      _renderService?: {
        dimensions: { css: { cell: { width: number; height: number } } };
      };
    };
  }
  const t = term as unknown as XtermInternals;
  t._core = t._core ?? {};
  t._core._renderService = {
    dimensions: { css: { cell: { width: cellWidth, height: cellHeight } } },
  };
}

describe('TerminalSizeManager', () => {
  let term: Terminal;
  let mountElement: HTMLElement;

  beforeEach(() => {
    term = new Terminal();
    mountElement = document.createElement('div');
  });

  afterEach(() => { term.dispose(); });

  it('calls term.resize when handleResize is invoked', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(120, 40);

    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
    manager.dispose();
  });

  it('sets mountElement pixel dimensions from cell size × cols/rows', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(80, 24);

    expect(mountElement.style.width).toBe('800px');   // 80 * 10
    expect(mountElement.style.height).toBe('480px');  // 24 * 20
    manager.dispose();
  });

  it('falls back to 8x16 when render service is unavailable', () => {
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(80, 24);

    expect(mountElement.style.width).toBe('640px');   // 80 * 8
    expect(mountElement.style.height).toBe('384px');  // 24 * 16
    manager.dispose();
  });

  it('recompute() uses current term cols/rows and current cell size', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);

    manager.handleResize(200, 60);
    expect(mountElement.style.width).toBe('2000px');
    expect(mountElement.style.height).toBe('1200px');

    // Simulate a font-size increase: cells become 12×24.
    mockRenderService(term, 12, 24);
    manager.recompute();

    // term cols/rows still 200×60 (not changed by fontSize).
    expect(mountElement.style.width).toBe('2400px');   // 200 * 12
    expect(mountElement.style.height).toBe('1440px');  // 60 * 24
    manager.dispose();
  });

  it('handleResize is a no-op after dispose', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, mountElement);
    manager.dispose();

    manager.handleResize(80, 24);

    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('recompute is a no-op after dispose', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, mountElement);
    manager.handleResize(80, 24);
    manager.dispose();
    // Use a valid but distinctive CSS length that recompute could never
    // produce (cols=80, rows=24, cell=10x20 would give 800px x 480px).
    mountElement.style.width = '4321px';
    mountElement.style.height = '4321px';

    manager.recompute();

    expect(mountElement.style.width).toBe('4321px');
    expect(mountElement.style.height).toBe('4321px');
  });
});
