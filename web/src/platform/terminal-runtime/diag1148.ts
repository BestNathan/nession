// TEMPORARY DIAGNOSTIC (#1148) — delete this file and its three importers once
// the doubled output is located.
//
// Why this exists: hashing every `terminal.write` proved the attach burst is
// written into xterm twice, hash-identical, with the query-bearing chunk among
// them — but a hash alone cannot say whether that is ONE stream event delivered
// twice or TWO events carrying the same bytes. Those need opposite fixes: the
// first is a client/transport re-delivery, the second is the agent emitting the
// bytes twice (a scrollback pre-fill overlapping the live stream does exactly
// that).
//
// So a sequence number is recorded beside the hash, on both sides of the
// client's stream handling, and correlated in the probe output:
//
//   out seq=17 h=1311ae10     ← what ConnectionManager decided to deliver
//   write h=1311ae10          ← what xterm was asked to render
//
// The same seq twice means a re-delivery. Equal hashes on different seqs means
// the agent recorded the same bytes as two events.
//
// Hashes are over BYTES, never over decoded text: the live path carries a
// Uint8Array and the replay path carries base64, and hashing the decoded string
// in one and the byte array in the other would make equal payloads hash
// differently for any non-ASCII byte.
//
// Entries live on `window` rather than on the element because ConnectionManager
// holds no element reference, and because the Playwright probe can read a
// global without threading a DOM node through the stream code.

export interface Diag1148Entry {
  kind: 'out' | 'write';
  hash: string;
  streamSeq?: number;
  streamEpoch?: number;
}

interface Diag1148Window {
  nessionDiag1148?: Diag1148Entry[];
}

const MAX_ENTRIES = 80;

function hashBytes(bytes: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Hash of raw payload bytes, for the live `onOutput` path. */
export function diagHashBytes(bytes: Uint8Array): string {
  return hashBytes(bytes);
}

/** Hash of the bytes a base64 payload decodes to, for the replay path. */
export function diagHashBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return hashBytes(bytes);
}

export function diagHashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

/** The correlated log, for the probe to copy onto the element. */
export function diagSnapshot(): Diag1148Entry[] {
  if (typeof window === 'undefined') {
    return [];
  }
  return (window as unknown as Diag1148Window).nessionDiag1148 ?? [];
}

export function diagPush(entry: Diag1148Entry): void {
  if (typeof window === 'undefined') {
    return;
  }
  const w = window as unknown as Diag1148Window;
  const entries = w.nessionDiag1148 ?? [];
  if (entries.length < MAX_ENTRIES) {
    entries.push(entry);
  }
  w.nessionDiag1148 = entries;
}
