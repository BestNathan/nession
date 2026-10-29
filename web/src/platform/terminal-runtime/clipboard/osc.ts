/**
 * OSC 52 / OSC 5522 wire grammar (#2598).
 *
 * xterm's OSC parser hands the handler everything after the identifier, so this
 * module sees payload strings, never escape framing. The Kitty clipboard spec
 * defines `OSC 5522 ; metadata ; payload` with colon-separated `key=value`
 * metadata and base64 values; OSC 52 is `OSC 52 ; selections ; base64`.
 */

/** One parsed OSC 5522 frame; metadata keeps the protocol's own keys. */
export interface Osc5522Frame {
  readonly metadata: ReadonlyMap<string, string>;
  /** The raw (still base64) payload; empty for packets without one. */
  readonly payload: string;
}

const METADATA_KEY = /^[a-z][a-z0-9-]*$/;

/**
 * Parse one OSC 5522 data string. A malformed frame has no defined reply, so
 * it returns null and the protocol ignores it rather than inventing one.
 */
export function parseOsc5522Frame(raw: string): Osc5522Frame | null {
  const separator = raw.indexOf(';');
  const metadataText = separator < 0 ? raw : raw.slice(0, separator);
  const payload = separator < 0 ? '' : raw.slice(separator + 1);
  const metadata = new Map<string, string>();
  if (metadataText.length > 0) {
    for (const segment of metadataText.split(':')) {
      const equals = segment.indexOf('=');
      if (equals <= 0) {
        return null;
      }
      const key = segment.slice(0, equals);
      const value = segment.slice(equals + 1);
      if (!METADATA_KEY.test(key) || metadata.has(key)) {
        return null;
      }
      metadata.set(key, value);
    }
  }
  if (!metadata.has('type')) {
    return null;
  }
  return { metadata, payload };
}

/**
 * Multiplexer correlation ids are retransmitted verbatim; the spec allows
 * `[a-zA-Z0-9-_+.]` and requires stripping anything else.
 */
export function sanitizeClipboardId(value: string | undefined): string {
  return (value ?? '').replace(/[^a-zA-Z0-9\-_+.]/g, '');
}

/** MIME types the clipboard protocol may carry (type/subtype tokens only). */
const MIME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function isValidClipboardMime(value: string): boolean {
  return MIME.test(value);
}

export function isImageClipboardMime(value: string): boolean {
  return value.startsWith('image/') && isValidClipboardMime(value);
}

/**
 * Build one OSC 5522 sequence. Correlation `id` values are raw metadata (never
 * base64); callers pass them already sanitized.
 */
export function formatOsc5522(
  metadata: readonly (readonly [string, string])[],
  payload?: string,
): string {
  const body = metadata.map(([key, value]) => `${key}=${value}`).join(':')
    + (payload === undefined ? '' : `;${payload}`);
  return `\x1b]5522;${body}\x1b\\`;
}

/** Build one OSC 52 sequence: `ESC ] 52 ; <selections> ; <payload> ESC \`. */
export function formatOsc52(selection: string, payload: string): string {
  return `\x1b]52;${selection};${payload}\x1b\\`;
}

/** DECRQM reply for private mode 5522: `CSI ? 5522 ; Ps $ y`. */
export function formatPrivateModeReport(mode: number, status: number): string {
  return `\x1b[?${mode};${status}$y`;
}
