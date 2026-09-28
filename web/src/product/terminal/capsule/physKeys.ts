import type { TerminalSemanticKey } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';

/**
 * A key in the capsule's physical row.
 *
 * **Exactly one of `semanticKey` / `seq`, and the type says which** (#1096
 * criterion 4). A key the runtime can encode from terminal state carries *no*
 * sequence here, so this module — a UI module — cannot own an escape that
 * depends on a mode it cannot see. `seq` remains only for the two keys that
 * have no semantic form at all: a bare modifier, which sends nothing, and
 * Ctrl+C, which is a control byte rather than a named key.
 *
 * The `?: undefined` members are what make the union assignable to the
 * structural `{ seq?: string; semanticKey?: … }` the runtime accepts, without
 * widening either arm into a shape where both could be set.
 */
export type PhysKey =
  | { label: string; semanticKey: TerminalSemanticKey; seq?: undefined }
  | { label: string; seq: string; semanticKey?: undefined };

export const CHAIN_LONG_PRESS_MS = 400;

/** Left-area quick keys for full KeyRow layout. */
export const LEFT_KEYS: PhysKey[] = [
  { label: 'Esc', semanticKey: 'Escape' },
  { label: 'Tab', semanticKey: 'Tab' },
  // A modifier sends no bytes of its own; it exists to start a chord.
  { label: 'Shift', seq: '' },
  { label: 'Space', semanticKey: 'Space' },
  { label: 'Enter', semanticKey: 'Enter' },
  { label: 'Del', semanticKey: 'Delete' },
  { label: 'Home', semanticKey: 'Home' },
  { label: 'PgUp', semanticKey: 'PageUp' },
  { label: 'PgDn', semanticKey: 'PageDown' },
  { label: 'End', semanticKey: 'End' },
];

export const ARROW_KEYS: PhysKey[] = [
  { label: '↑', semanticKey: 'ArrowUp' },
  { label: '←', semanticKey: 'ArrowLeft' },
  { label: '↓', semanticKey: 'ArrowDown' },
  { label: '→', semanticKey: 'ArrowRight' },
];

/** Mobile capsule single-row quick keys. */
export const QUICK_MOBILE_KEYS: PhysKey[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Space', seq: ' ' },
  { label: 'Enter', seq: '\r' },
  { label: 'Ctrl+C', seq: '\x03' },
];

export const SEQ_LABELS: Record<string, string> = {
  '\x1b': 'Esc',
  '\t': 'Tab',
  '\r': 'Enter',
  ' ': 'Space',
  '\x03': 'Ctrl-C',
};

export function formatSeq(seq: string): string {
  return SEQ_LABELS[seq] ?? (seq.length === 1 ? seq : `\\x${seq.charCodeAt(0).toString(16)}`);
}

/**
 * How a key reads in the chain strip.
 *
 * A semantic key has no sequence to render — that is the point of it — so it
 * shows its own label, which is also what the button the user pressed said.
 */
export function formatKey(key: PhysKey): string {
  return key.semanticKey ? key.label : formatSeq(key.seq);
}
