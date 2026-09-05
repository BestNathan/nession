/**
 * Shared base64 helpers for the terminal capability's wire encoding.
 *
 * Two decode policies exist on purpose — one per connection type (agent vs
 * server):
 *
 * - The agent (P2P) connection (`agent.ts`) decodes strictly: a frame that is
 *   not valid base64 is a protocol violation. Mirrors ConnectionManager.
 * - The server (relay) connection (`server.ts`) decodes tolerantly: empty
 *   frames yield zero bytes and invalid base64 degrades to UTF-8 encoding of
 *   the raw string, so one malformed frame never kills the write stream.
 *   Mirrors EventPlugin.
 *
 * The wire carries no mode discriminator; the relay side decides per frame
 * from the payload shape — `session_name` present and `session_id` absent
 * means relay, hence base64 (see `isRelay` in server.ts).
 */
export function encodeBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 frame to raw bytes (strict — throws on invalid base64,
 * matching ConnectionManager). Returns Uint8Array, NOT a decoded string:
 * terminal output is a raw byte stream (ANSI + UTF-8 + arbitrary octets) and
 * TextDecoder would corrupt invalid UTF-8 before xterm.js can interpret it.
 */
export function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode base64-encoded terminal data to raw bytes (tolerant — matching
 * EventPlugin, the relay-side twin of {@link decodeBase64Bytes}): an empty
 * frame decodes to zero bytes and invalid base64 falls back to encoding the
 * raw string as UTF-8 bytes.
 */
export function decodeTerminalData(rawData: string): Uint8Array {
  if (!rawData) {
    return new Uint8Array(0);
  }
  try {
    return decodeBase64Bytes(rawData);
  } catch {
    // Invalid base64 — fall back to encoding the raw string as UTF-8 bytes.
    return new TextEncoder().encode(rawData);
  }
}
