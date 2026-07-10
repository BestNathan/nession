import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { InputManager } from '../InputManager';

describe('InputManager', () => {
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal();
  });

  afterEach(() => {
    term.dispose();
  });

  it('forwards keyboard data to onData callback', () => {
    const manager = new InputManager(term);
    const cb = vi.fn();
    manager.onData(cb);
    term.input('a');
    expect(cb).toHaveBeenCalledWith('a');
    manager.dispose();
  });

  it('intercepts Ctrl+D and routes to onCtrlD callback', () => {
    const manager = new InputManager(term);
    const dataCb = vi.fn();
    const ctrlDCb = vi.fn();
    manager.onData(dataCb);
    manager.onCtrlD(ctrlDCb);
    term.input('\x04');
    expect(ctrlDCb).toHaveBeenCalled();
    expect(dataCb).not.toHaveBeenCalledWith('\x04');
    manager.dispose();
  });

  it('identifies mouse tracking sequences (SGR)', () => {
    const manager = new InputManager(term);
    const cb = vi.fn();
    manager.onData(cb);
    term.input('\x1b[<0;10;20M');
    expect(cb).toHaveBeenCalledWith('\x1b[<0;10;20M');
    manager.dispose();
  });

  it('dispose removes the onData listener from xterm', () => {
    const manager = new InputManager(term);
    const cb = vi.fn();
    manager.onData(cb);
    manager.dispose();
    term.input('x');
    expect(cb).not.toHaveBeenCalledWith('x');
  });

  it('multiple onData callbacks can be registered', () => {
    const manager = new InputManager(term);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.onData(cb1);
    manager.onData(cb2);
    term.input('b');
    expect(cb1).toHaveBeenCalledWith('b');
    expect(cb2).toHaveBeenCalledWith('b');
    manager.dispose();
  });
});
