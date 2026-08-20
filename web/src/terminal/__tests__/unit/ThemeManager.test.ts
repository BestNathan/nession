import { describe, it, expect } from 'vitest';
import { Terminal, type ITheme } from '@xterm/xterm';
import { ThemeManager } from '@/terminal/ThemeManager';

const CUSTOM_THEME: ITheme = {
  background: '#000000',
  foreground: '#ffffff',
};

describe('ThemeManager', () => {
  it('applies the default Catppuccin Mocha theme on construction', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term);
    const theme = manager.getTheme();
    expect(theme.background).toBe('#1e1e2e');
    expect(theme.foreground).toBe('#cdd6f4');
    term.dispose();
  });

  it('accepts a custom initial theme', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term, CUSTOM_THEME);
    expect(manager.getTheme().background).toBe('#000000');
    term.dispose();
  });

  it('setTheme merges partial theme properties', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term);
    manager.setTheme({ background: '#111111' });
    const theme = manager.getTheme();
    expect(theme.background).toBe('#111111');
    expect(theme.foreground).toBe('#cdd6f4');
    term.dispose();
  });

  it('resetToDefault restores Catppuccin Mocha', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term, CUSTOM_THEME);
    manager.resetToDefault();
    const theme = manager.getTheme();
    expect(theme.background).toBe('#1e1e2e');
    term.dispose();
  });

  it('getTheme returns a copy, not the internal reference', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term);
    const t1 = manager.getTheme();
    const t2 = manager.getTheme();
    expect(t1).not.toBe(t2);
    expect(t1).toEqual(t2);
    term.dispose();
  });
});
