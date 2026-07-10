import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ViewportManager } from '../ViewportManager';
import { PROFILES } from '../DeviceProfile';

// Mock ResizeObserver for jsdom.
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as Record<string, unknown>).ResizeObserver = MockResizeObserver;

// Mock window.matchMedia for xterm.js.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

describe('ViewportManager', () => {
  let container: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;

  beforeEach(() => {
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1024, writable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true });
    document.body.appendChild(container);

    term = new Terminal({ cols: 80, rows: 24 });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    document.body.removeChild(container);
  });

  it('fits the terminal on construction (deferred via rAF)', async () => {
    const manager = new ViewportManager(term, fitAddon, container);
    await new Promise((r) => requestAnimationFrame(r));
    expect(term.cols).toBeGreaterThan(0);
    expect(term.rows).toBeGreaterThan(0);
    manager.dispose();
  });

  it('uses desktop profile for container width >= 1024', () => {
    const manager = new ViewportManager(term, fitAddon, container);
    expect(term.options.fontSize).toBeGreaterThanOrEqual(14);
    manager.dispose();
  });

  it('uses tablet profile for container width 640-1023', () => {
    Object.defineProperty(container, 'clientWidth', { value: 800, writable: true });
    const manager = new ViewportManager(term, fitAddon, container);
    expect(term.options.fontSize).toBeGreaterThanOrEqual(13);
    manager.dispose();
  });

  it('uses phone profile for container width < 640', () => {
    Object.defineProperty(container, 'clientWidth', { value: 375, writable: true });
    const manager = new ViewportManager(term, fitAddon, container);
    expect(term.options.fontSize).toBeGreaterThanOrEqual(11);
    manager.dispose();
  });

  it('updateProfile changes device profile', () => {
    const manager = new ViewportManager(term, fitAddon, container);
    manager.updateProfile(PROFILES.phone);
    expect(term.options.fontSize).toBe(11);
    manager.dispose();
  });

  it('dispose cleans up without error', () => {
    const manager = new ViewportManager(term, fitAddon, container);
    expect(() => manager.dispose()).not.toThrow();
  });
});
