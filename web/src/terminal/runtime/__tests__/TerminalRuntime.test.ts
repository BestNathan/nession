import { describe, it, expect, vi } from 'vitest';
import { TerminalRuntime } from '../TerminalRuntime';

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

describe('TerminalRuntime', () => {
  it('creates an xterm Terminal with default options', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(rt.terminal).toBeDefined();
    expect(rt.terminal.options.fontSize).toBe(14);
    expect(rt.terminal.options.scrollback).toBe(10000);
    rt.dispose();
  });

  it('exposes cell dimensions with an 8×16 fallback', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const dims = rt.cellDimensions;
    expect(dims.width).toBe(8);
    expect(dims.height).toBe(16);
    rt.dispose();
  });

  it('reads real cell dimensions from the render service', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    (rt.terminal as unknown as { _core?: unknown })._core = {
      _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } },
    };
    expect(rt.cellDimensions).toEqual({ width: 10, height: 20 });
    rt.dispose();
  });

  it('fires the onCellSizeChange callback on font-size zoom', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const cb = vi.fn();
    rt.onCellSizeChange = cb;
    rt.fontSizeManager.zoomIn();
    expect(cb).toHaveBeenCalledTimes(1);
    rt.dispose();
  });

  it('installs a single mobile input textarea on touch devices', () => {
    const originalOntouchstart = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
    Object.defineProperty(window, 'ontouchstart', { writable: true, configurable: true, value: null });
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const rt = new TerminalRuntime({ rendererType: 'canvas' });
      rt.open(host);
      const onSend = vi.fn();
      rt.installMobileInput(host, onSend);
      rt.installMobileInput(host, onSend);
      // MobileInput appends its textarea as a direct child of `host`; xterm's
      // own helper textarea is nested inside the terminal element, not `host`.
      const direct = Array.from(host.querySelectorAll('textarea')).filter(
        (el) => el.parentElement === host,
      );
      expect(direct).toHaveLength(1);
      rt.dispose();
    } finally {
      document.body.removeChild(host);
      if (originalOntouchstart) {
        Object.defineProperty(window, 'ontouchstart', originalOntouchstart);
      } else {
        delete (window as unknown as Record<string, unknown>).ontouchstart;
      }
    }
  });

  it('delegates scroll methods to xterm', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const spyBottom = vi.spyOn(rt.terminal, 'scrollToBottom').mockImplementation(() => {});
    const spyPages = vi.spyOn(rt.terminal, 'scrollPages').mockImplementation(() => {});
    const spyLines = vi.spyOn(rt.terminal, 'scrollLines').mockImplementation(() => {});
    rt.scrollToBottom();
    rt.scrollPages(-1);
    rt.scrollLines(3);
    expect(spyBottom).toHaveBeenCalled();
    expect(spyPages).toHaveBeenCalledWith(-1);
    expect(spyLines).toHaveBeenCalledWith(3);
    rt.dispose();
  });

  it('exposes a fontSizeManager', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(rt.fontSizeManager).toBeDefined();
    expect(typeof rt.fontSizeManager.zoomIn).toBe('function');
    rt.dispose();
  });

  it('dispose is idempotent and does not throw', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(() => { rt.dispose(); rt.dispose(); }).not.toThrow();
  });
});
