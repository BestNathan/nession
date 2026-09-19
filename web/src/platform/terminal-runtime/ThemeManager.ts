import type { Terminal, ITheme } from '@xterm/xterm';
import {
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  TERMINAL_THEME,
} from '../../../../design/generated/terminal';

export { TERMINAL_MINIMUM_CONTRAST_RATIO };

/**
 * Nession's terminal palette, from the token source
 * (`design/tokens/primitive.json` → `design/generated/terminal.ts`).
 *
 * The terminal sits on the same ground as the chrome, so the two must agree
 * or the capsule shows a seam where it overlaps the terminal. Deriving both
 * from one token source is what keeps them in step.
 */
export const NESSION_TERMINAL_THEME: ITheme = TERMINAL_THEME;

export class ThemeManager {
  private current: ITheme;

  constructor(private term: Terminal, theme?: ITheme) {
    this.current = { ...NESSION_TERMINAL_THEME, ...theme };
    this.apply();
  }

  setTheme(theme: Partial<ITheme>): void {
    this.current = { ...this.current, ...theme };
    this.apply();
  }

  resetToDefault(): void {
    this.current = { ...NESSION_TERMINAL_THEME };
    this.apply();
  }

  getTheme(): ITheme {
    return { ...this.current };
  }

  private apply(): void {
    this.term.options.theme = this.current;
  }
}
