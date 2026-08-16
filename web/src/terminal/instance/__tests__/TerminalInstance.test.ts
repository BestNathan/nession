import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TerminalInstance } from '../TerminalInstance';

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
});
