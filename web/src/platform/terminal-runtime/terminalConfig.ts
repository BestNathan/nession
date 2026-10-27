/**
 * Build-time terminal sizing configuration (#2487 SC-07).
 *
 * Two optional, validated inputs decide the client's fixed column count and
 * the Web terminal's maximum CSS font size:
 *
 * - `VITE_NESSION_TERMINAL_COLS` — positive integer, shared by Web and App.
 * - `VITE_NESSION_TERMINAL_WEB_FONT_SIZE` — positive CSS px, may be
 *   fractional; it caps the **Web** font only. The mobile font is always
 *   derived from the available width and the shared cols.
 *
 * The values are inlined into the bundle by Vite, so they are immutable for
 * the life of a built artifact. Omitted inputs fall back to the versioned
 * defaults; invalid inputs are reported as errors (the Vite config refuses to
 * build, and the runtime reader throws) rather than silently adjusted.
 *
 * The defaults are provisional product values pending interactive prototype
 * review; a release changes them only by rebuilding, and never changes the
 * width of an already-running Session (the Agent keeps the Session's
 * authoritative width).
 */

/** The single fixed column count shared by Web and App. */
export const DEFAULT_TERMINAL_COLS = 80;
/** The Web terminal's preferred/maximum CSS font size. */
export const DEFAULT_TERMINAL_WEB_FONT_SIZE = 14;

export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 400;
export const MIN_TERMINAL_WEB_FONT_SIZE = 6;
export const MAX_TERMINAL_WEB_FONT_SIZE = 32;

export const TERMINAL_COLS_ENV = 'VITE_NESSION_TERMINAL_COLS';
export const TERMINAL_WEB_FONT_SIZE_ENV = 'VITE_NESSION_TERMINAL_WEB_FONT_SIZE';

export interface TerminalClientConfig {
  /** Fixed columns. Never derived from a viewport width. */
  cols: number;
  /** The Web terminal's preferred/maximum CSS font size. */
  webMaxFontSize: number;
}

export interface TerminalConfigSource {
  cols: 'env' | 'default';
  webMaxFontSize: 'env' | 'default';
}

export interface ParsedTerminalConfig {
  config: TerminalClientConfig;
  sources: TerminalConfigSource;
  /**
   * One message per invalid input. The config still carries the default for
   * that input so a caller can render diagnostics, but a build must treat a
   * non-empty list as fatal.
   */
  errors: string[];
}

type Env = Record<string, string | undefined>;

function parseInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    return Number.NaN;
  }
  return Number.parseInt(raw, 10);
}

function parseDecimal(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return Number.NaN;
  }
  return Number.parseFloat(raw);
}

/**
 * Parse the two optional build inputs.
 *
 * Empty is the same as omitted: an env var declared with no value cannot be
 * told apart from one that was not set, and the documented default is the
 * answer to "nothing was selected".
 */
export function parseTerminalBuildConfig(env: Env): ParsedTerminalConfig {
  const errors: string[] = [];

  const rawCols = env[TERMINAL_COLS_ENV];
  const parsedCols = parseInteger(rawCols);
  let cols = DEFAULT_TERMINAL_COLS;
  let colsSource: 'env' | 'default' = 'default';
  if (parsedCols !== null) {
    if (!Number.isFinite(parsedCols)
      || parsedCols < MIN_TERMINAL_COLS
      || parsedCols > MAX_TERMINAL_COLS) {
      errors.push(
        `${TERMINAL_COLS_ENV} must be an integer in `
        + `[${MIN_TERMINAL_COLS}, ${MAX_TERMINAL_COLS}]; got ${JSON.stringify(rawCols)}`,
      );
    } else {
      cols = parsedCols;
      colsSource = 'env';
    }
  }

  const rawFont = env[TERMINAL_WEB_FONT_SIZE_ENV];
  const parsedFont = parseDecimal(rawFont);
  let webMaxFontSize = DEFAULT_TERMINAL_WEB_FONT_SIZE;
  let fontSource: 'env' | 'default' = 'default';
  if (parsedFont !== null) {
    if (!Number.isFinite(parsedFont)
      || parsedFont < MIN_TERMINAL_WEB_FONT_SIZE
      || parsedFont > MAX_TERMINAL_WEB_FONT_SIZE) {
      errors.push(
        `${TERMINAL_WEB_FONT_SIZE_ENV} must be a number in `
        + `[${MIN_TERMINAL_WEB_FONT_SIZE}, ${MAX_TERMINAL_WEB_FONT_SIZE}] CSS px; `
        + `got ${JSON.stringify(rawFont)}`,
      );
    } else {
      webMaxFontSize = parsedFont;
      fontSource = 'env';
    }
  }

  return {
    config: { cols, webMaxFontSize },
    sources: { cols: colsSource, webMaxFontSize: fontSource },
    errors,
  };
}

/**
 * The build inputs as Vite inlined them.
 *
 * Throws if either input is invalid. The Vite config already refuses to build
 * such a bundle, so this is the runtime half of the same contract (a dev
 * server started with a bad `.env` fails in the terminal rather than drawing a
 * silently adjusted grid).
 */
export function readTerminalClientConfig(): TerminalClientConfig {
  const parsed = parseTerminalBuildConfig({
    [TERMINAL_COLS_ENV]: import.meta.env.VITE_NESSION_TERMINAL_COLS,
    [TERMINAL_WEB_FONT_SIZE_ENV]: import.meta.env.VITE_NESSION_TERMINAL_WEB_FONT_SIZE,
  });
  if (parsed.errors.length > 0) {
    throw new Error(
      'Invalid terminal build configuration:\n  ' + parsed.errors.join('\n  '),
    );
  }
  return parsed.config;
}
