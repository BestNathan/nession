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
    expect(dims.width).toBeGreaterThanOrEqual(8);
    expect(dims.height).toBeGreaterThanOrEqual(16);
    rt.dispose();
  });

  it('delegates scroll methods to xterm', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    const spyBottom = vi.spyOn(rt.terminal, 'scrollToBottom').mockImplementation(() => {});
    const spyPages = vi.spyOn(rt.terminal, 'scrollPages').mockImplementation(() => {});
    rt.scrollToBottom();
    rt.scrollPages(-1);
    expect(spyBottom).toHaveBeenCalled();
    expect(spyPages).toHaveBeenCalledWith(-1);
    rt.dispose();
  });

  it('exposes a fontSizeManager', () => {
    const rt = new TerminalRuntime({ rendererType: 'canvas' });
    expect(rt.fontSizeManager).toBeDefined();
    expect(typeof rt.fontSizeManager.zoomIn).toBe('function');
    rt.dispose();
  });
});
