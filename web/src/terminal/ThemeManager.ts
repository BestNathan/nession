import type { Terminal, ITheme } from '@xterm/xterm';

const CATPPUCCIN_MOCHA: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

export class ThemeManager {
  private current: ITheme;

  constructor(private term: Terminal, theme?: ITheme) {
    this.current = { ...CATPPUCCIN_MOCHA, ...theme };
    this.apply();
  }

  setTheme(theme: Partial<ITheme>): void {
    this.current = { ...this.current, ...theme };
    this.apply();
  }

  resetToDefault(): void {
    this.current = { ...CATPPUCCIN_MOCHA };
    this.apply();
  }

  getTheme(): ITheme {
    return { ...this.current };
  }

  private apply(): void {
    this.term.options.theme = this.current;
  }
}
