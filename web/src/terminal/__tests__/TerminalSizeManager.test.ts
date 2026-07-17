import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TerminalSizeManager } from '../TerminalSizeManager';

/** Helper: attach a fake _renderService with given cell dimensions.
 *  Preserves any existing _core properties (e.g. resize) so term.resize() still works. */
function mockRenderService(term: Terminal, cellWidth: number, cellHeight: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = term as any;
  t._core = t._core ?? {};
  t._core._renderService = {
    dimensions: {
      css: {
        cell: { width: cellWidth, height: cellHeight },
      },
    },
  };
}

describe('TerminalSizeManager', () => {
  let term: Terminal;
  let mountElement: HTMLElement;
  let scrollContainer: HTMLElement;

  beforeEach(() => {
    term = new Terminal();
    mountElement = document.createElement('div');
    scrollContainer = document.createElement('div');
  });

  afterEach(() => {
    term.dispose();
  });

  it('calls term.resize when handleResize is invoked', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(120, 40);

    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
    manager.dispose();
  });

  it('sets mountElement pixel dimensions using fallback cell size (8x16)', () => {
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(80, 24);

    // 80 cols * 8px = 640px, 24 rows * 16px = 384px
    expect(mountElement.style.width).toBe('640px');
    expect(mountElement.style.height).toBe('384px');
    manager.dispose();
  });

  it('uses actual cell dimensions from _renderService when available', () => {
    mockRenderService(term, 10, 20);
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(100, 50);

    // 100 cols * 10px = 1000px, 50 rows * 20px = 1000px
    expect(mountElement.style.width).toBe('1000px');
    expect(mountElement.style.height).toBe('1000px');
    manager.dispose();
  });

  it('falls back when _renderService is missing', () => {
    // _core exists (created by Terminal constructor) but has no _renderService.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (term as any)._core._renderService;
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(80, 24);

    expect(mountElement.style.width).toBe('640px');
    expect(mountElement.style.height).toBe('384px');
    manager.dispose();
  });

  it('falls back when _renderService has partial dimensions', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (term as any)._core._renderService = { dimensions: {} };
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(40, 10);

    // 40 * 8 = 320, 10 * 16 = 160
    expect(mountElement.style.width).toBe('320px');
    expect(mountElement.style.height).toBe('160px');
    manager.dispose();
  });

  it('does nothing after dispose', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.dispose();
    manager.handleResize(80, 24);

    expect(resizeSpy).not.toHaveBeenCalled();
    expect(mountElement.style.width).toBe('');
    expect(mountElement.style.height).toBe('');
  });

  it('updates dimensions on successive handleResize calls', () => {
    mockRenderService(term, 9, 18);
    const manager = new TerminalSizeManager(term, scrollContainer, mountElement);

    manager.handleResize(80, 24);
    expect(mountElement.style.width).toBe('720px');
    expect(mountElement.style.height).toBe('432px');

    manager.handleResize(120, 40);
    expect(mountElement.style.width).toBe('1080px');
    expect(mountElement.style.height).toBe('720px');

    manager.dispose();
  });

  it('can be constructed with scrollContainer and mountElement references', () => {
    // Verify constructor accepts the expected parameters without throwing
    expect(() => new TerminalSizeManager(term, scrollContainer, mountElement)).not.toThrow();
  });
});
