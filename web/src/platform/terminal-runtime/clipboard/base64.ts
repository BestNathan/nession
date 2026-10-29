/**
 * Strict RFC 4648 §4 base64 for the terminal clipboard protocols (#2598).
 *
 * The wire contract is tighter than `atob`/`btoa`: the Kitty clipboard spec
 * requires the standard alphabet, mandatory padding, and rejection of any
 * character outside the alphabet — including whitespace and line breaks — and
 * of incorrectly padded data. `atob` silently tolerates whitespace gaps, so the
 * protocol owns its own decoder instead of normalizing a malformed request.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  VALUES[ALPHABET.charCodeAt(index)] = index;
}

/** The strict decode failure cause, for truthful protocol error mapping. */
export type Base64Error = 'alphabet' | 'length' | 'pad-bits';

/**
 * Decode one complete, padded base64 value. Returns the failure cause instead
 * of throwing so protocol handlers can map it to `EINVAL` without exceptions
 * in the parser path.
 */
export function decodeBase64(value: string): Uint8Array | Base64Error {
  if (value.length === 0) {
    return new Uint8Array(0);
  }
  if (value.length % 4 !== 0) {
    return 'length';
  }
  let padding = 0;
  if (value.endsWith('==')) {
    padding = 2;
  } else if (value.endsWith('=')) {
    padding = 1;
  }
  const dataChars = value.length - padding;
  for (let index = 0; index < dataChars; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 128 || VALUES[code] < 0) {
      return 'alphabet';
    }
  }
  if (padding === 2) {
    // One data byte in the final quantum: the last 4 data bits are unused.
    const last = VALUES[value.charCodeAt(dataChars - 1)];
    if ((last & 0x0f) !== 0) {
      return 'pad-bits';
    }
  } else if (padding === 1) {
    const last = VALUES[value.charCodeAt(dataChars - 1)];
    if ((last & 0x03) !== 0) {
      return 'pad-bits';
    }
  }
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = VALUES[value.charCodeAt(index)];
    const b = VALUES[value.charCodeAt(index + 1)];
    const c = value.charCodeAt(index + 2) === 0x3d ? 0 : VALUES[value.charCodeAt(index + 2)];
    const d = value.charCodeAt(index + 3) === 0x3d ? 0 : VALUES[value.charCodeAt(index + 3)];
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < bytes.length) {
      bytes[offset++] = (triple >> 16) & 0xff;
    }
    if (offset < bytes.length) {
      bytes[offset++] = (triple >> 8) & 0xff;
    }
    if (offset < bytes.length) {
      bytes[offset++] = triple & 0xff;
    }
  }
  return bytes;
}

/** Encode bytes with the standard alphabet and mandatory padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 0x3f];
    out += ALPHABET[(triple >> 12) & 0x3f];
    out += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += index + 2 < bytes.length ? ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 decode that refuses malformed text rather than replacing it. */
export function decodeBase64Text(value: string): string | null {
  const bytes = decodeBase64(value);
  if (typeof bytes === 'string') {
    return null;
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeBase64Text(value: string): string {
  return encodeBase64(new TextEncoder().encode(value));
}
