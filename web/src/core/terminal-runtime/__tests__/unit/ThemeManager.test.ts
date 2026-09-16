import { describe, it, expect } from 'vitest';
import { Terminal, type ITheme } from '@xterm/xterm';
import { ThemeManager } from '@/core/terminal-runtime/ThemeManager';

const CUSTOM_THEME: ITheme = {
  background: '#000000',
  foreground: '#ffffff',
};

describe('ThemeManager', () => {
  it('applies the Nession light terminal theme on construction', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term);
    const theme = manager.getTheme();
    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#24292f');
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
    expect(theme.foreground).toBe('#24292f');
    term.dispose();
  });

  it('resetToDefault restores the Nession light terminal theme', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term, CUSTOM_THEME);
    manager.resetToDefault();
    const theme = manager.getTheme();
    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#24292f');
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

  it('carries a full ANSI set so 16-colour output is not half-themed', () => {
    const term = new Terminal();
    const manager = new ThemeManager(term);
    const theme = manager.getTheme();
    const slots = [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const;
    for (const slot of slots) {
      expect(theme[slot], `${slot} must be set`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    term.dispose();
  });
});
