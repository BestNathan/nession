import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TerminalView } from '../TerminalView';
import type { TerminalViewOptions } from '../types';
import type { P2PConnection } from '../../hooks/useP2PConnection';

// Mock ResizeObserver and matchMedia for jsdom.
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = MockResizeObserver;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false, media: '', onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function makeMockP2P(): P2PConnection {
  return {
    connectionState: 'connected',
    reconnectAttempt: 0,
    sendMessage: () => {},
    onMessage: () => () => {},
    close: () => {},
    waitForConnection: () => Promise.resolve(),
  };
}

describe('TerminalView', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1024, writable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true });
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  const baseOptions: TerminalViewOptions = {
    connection: {
      mode: 'p2p',
      sessionName: 'test',
      sessionId: 'agent1:test',
      p2pConnection: makeMockP2P(),
    },
  };

  it('creates a TerminalView and opens xterm in the container', () => {
    const view = new TerminalView(container, baseOptions);
    expect(view.terminal).toBeDefined();
    expect(view.terminal.element).toBeDefined();
    expect(container.contains(view.terminal.element!)).toBe(true);
    view.dispose();
  });

  it('sendText does not throw', () => {
    const view = new TerminalView(container, baseOptions);
    expect(() => view.sendText('test')).not.toThrow();
    view.dispose();
  });

  it('refit does not throw', () => {
    const view = new TerminalView(container, baseOptions);
    expect(() => view.refit()).not.toThrow();
    view.dispose();
  });

  it('dispose cleans up', () => {
    const view = new TerminalView(container, baseOptions);
    view.dispose();
    expect(() => view.sendText('test')).not.toThrow();
  });

  it('onStateChange callback is set', () => {
    const view = new TerminalView(container, baseOptions);
    expect(view.onStateChange).toBeDefined();
    view.dispose();
  });
});
