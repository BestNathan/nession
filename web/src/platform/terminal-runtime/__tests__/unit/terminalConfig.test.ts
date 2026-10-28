import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_WEB_FONT_SIZE,
  TERMINAL_COLS_ENV,
  TERMINAL_WEB_FONT_SIZE_ENV,
  parseTerminalBuildConfig,
} from '@/platform/terminal-runtime/terminalConfig';

describe('terminal build configuration (#2487 SC-07)', () => {
  it('uses the versioned defaults when neither input is set', () => {
    expect(DEFAULT_TERMINAL_COLS).toBe(96);
    const parsed = parseTerminalBuildConfig({});
    expect(parsed.errors).toEqual([]);
    expect(parsed.config).toEqual({
      cols: DEFAULT_TERMINAL_COLS,
      webMaxFontSize: DEFAULT_TERMINAL_WEB_FONT_SIZE,
    });
    expect(parsed.sources).toEqual({ cols: 'default', webMaxFontSize: 'default' });
  });

  it('treats an empty value as omitted', () => {
    const parsed = parseTerminalBuildConfig({
      [TERMINAL_COLS_ENV]: '',
      [TERMINAL_WEB_FONT_SIZE_ENV]: '',
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.cols).toBe(DEFAULT_TERMINAL_COLS);
    expect(parsed.config.webMaxFontSize).toBe(DEFAULT_TERMINAL_WEB_FONT_SIZE);
  });

  it('accepts the two prototype configurations independently', () => {
    const small = parseTerminalBuildConfig({
      [TERMINAL_COLS_ENV]: '80',
      [TERMINAL_WEB_FONT_SIZE_ENV]: '13',
    });
    expect(small.errors).toEqual([]);
    expect(small.config).toEqual({ cols: 80, webMaxFontSize: 13 });
    expect(small.sources).toEqual({ cols: 'env', webMaxFontSize: 'env' });

    const large = parseTerminalBuildConfig({
      [TERMINAL_COLS_ENV]: '96',
      [TERMINAL_WEB_FONT_SIZE_ENV]: '14.5',
    });
    expect(large.errors).toEqual([]);
    expect(large.config).toEqual({ cols: 96, webMaxFontSize: 14.5 });
  });

  it('changing only the Web font input never changes the column count', () => {
    const base = parseTerminalBuildConfig({ [TERMINAL_COLS_ENV]: '96' });
    const fontOnly = parseTerminalBuildConfig({
      [TERMINAL_COLS_ENV]: '96',
      [TERMINAL_WEB_FONT_SIZE_ENV]: '18',
    });
    expect(fontOnly.config.cols).toBe(base.config.cols);
    expect(fontOnly.config.cols).toBe(96);
    expect(fontOnly.config.webMaxFontSize).toBe(18);
  });

  it('fails visibly for a non-integer or out-of-range column count', () => {
    for (const value of ['0', '19', '401', '88.5', 'eighty', '-1']) {
      const parsed = parseTerminalBuildConfig({ [TERMINAL_COLS_ENV]: value });
      expect(parsed.errors, value).toHaveLength(1);
      expect(parsed.errors[0]).toContain(TERMINAL_COLS_ENV);
      // The fallback is still the documented default, never a silent adjust.
      expect(parsed.config.cols).toBe(DEFAULT_TERMINAL_COLS);
      expect(parsed.sources.cols).toBe('default');
    }
  });

  it('fails visibly for an invalid Web font size', () => {
    for (const value of ['0', '5.9', '32.1', '14px', 'fourteen']) {
      const parsed = parseTerminalBuildConfig({ [TERMINAL_WEB_FONT_SIZE_ENV]: value });
      expect(parsed.errors, value).toHaveLength(1);
      expect(parsed.errors[0]).toContain(TERMINAL_WEB_FONT_SIZE_ENV);
      expect(parsed.config.webMaxFontSize).toBe(DEFAULT_TERMINAL_WEB_FONT_SIZE);
    }
  });

  it('reports both invalid inputs together rather than stopping at the first', () => {
    const parsed = parseTerminalBuildConfig({
      [TERMINAL_COLS_ENV]: 'nope',
      [TERMINAL_WEB_FONT_SIZE_ENV]: 'huge',
    });
    expect(parsed.errors).toHaveLength(2);
  });
});
