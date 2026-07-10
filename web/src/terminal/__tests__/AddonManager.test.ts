import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { AddonManager } from '../AddonManager';

describe('AddonManager', () => {
  it('registers an addon and returns it', () => {
    const term = new Terminal();
    const manager = new AddonManager(term);
    const fit = new FitAddon();
    const result = manager.register(fit);
    expect(result).toBe(fit);
    term.dispose();
  });

  it('get retrieves a previously registered addon by constructor', () => {
    const term = new Terminal();
    const manager = new AddonManager(term);
    const fit = new FitAddon();
    manager.register(fit);
    expect(manager.get(FitAddon)).toBe(fit);
    term.dispose();
  });

  it('get returns undefined for an unknown addon type', () => {
    const term = new Terminal();
    const manager = new AddonManager(term);
    expect(manager.get(FitAddon)).toBeUndefined();
    term.dispose();
  });

  it('registers multiple addons of different types', () => {
    const term = new Terminal();
    const manager = new AddonManager(term);
    const fit = new FitAddon();
    const canvas = new CanvasAddon();
    manager.register(fit);
    manager.register(canvas);
    expect(manager.get(FitAddon)).toBe(fit);
    expect(manager.get(CanvasAddon)).toBe(canvas);
    term.dispose();
  });

  it('loadAddon is called on the terminal when registering', () => {
    const term = new Terminal();
    const loadSpy = vi.spyOn(term, 'loadAddon');
    const manager = new AddonManager(term);
    const fit = new FitAddon();
    manager.register(fit);
    expect(loadSpy).toHaveBeenCalledWith(fit);
    term.dispose();
  });
});
