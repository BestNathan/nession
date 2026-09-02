// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TerminalInstance } from '@/terminal/instance/TerminalInstance';

// Mock matchMedia for xterm.js in jsdom environment
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

describe('TerminalInstance', () => {
  let instance: TerminalInstance;

  beforeEach(() => {
    instance = new TerminalInstance({
      rendererType: 'canvas',
      fontSize: 14,
      scrollback: 1000,
    });
  });

  afterEach(() => {
    instance.dispose();
  });

  it('should create terminal with options', () => {
    expect(instance.terminal).toBeDefined();
    expect(instance.fontSizeManager).toBeDefined();
  });

  it('should have correct initial state', () => {
    expect(instance.terminal.rows).toBeGreaterThan(0);
    expect(instance.terminal.cols).toBeGreaterThan(0);
  });

  it('should preserve scrollback after attach/detach cycle', () => {
    // Create two containers
    const container1 = document.createElement('div');
    const container2 = document.createElement('div');
    document.body.appendChild(container1);
    document.body.appendChild(container2);

    // Attach to first container and write some content
    instance.attach(container1);

    // Write content - use writeSync for synchronous buffer update
    instance.terminal.write('line 1\r\n');
    instance.terminal.write('line 2\r\n');
    instance.terminal.write('line 3\r\n');

    // Get initial buffer state
    const initialBufferLength = instance.terminal.buffer.active.length;
    expect(initialBufferLength).toBeGreaterThan(0);

    // Detach
    instance.detach();

    // Attach to second container
    instance.attach(container2);

    // Reattach must put the existing xterm DOM back into the new viewport.
    expect(instance.terminal.element?.parentElement).toBe(container2);

    // Verify scrollback is preserved - buffer should still have content
    const bufferAfterReattach = instance.terminal.buffer.active;
    expect(bufferAfterReattach.length).toBe(initialBufferLength);

    // Verify the terminal instance is the same (scrollback preserved)
    expect(instance.terminal).toBeDefined();
    expect(instance.terminal.buffer.active.length).toBeGreaterThan(0);

    // Cleanup
    document.body.removeChild(container1);
    document.body.removeChild(container2);
  });
});
