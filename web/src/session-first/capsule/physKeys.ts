export interface PhysKey {
  label: string;
  seq: string;
}

export const CHAIN_LONG_PRESS_MS = 400;

/** Left-area quick keys for full KeyRow layout. */
export const LEFT_KEYS: PhysKey[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Shift', seq: '' },
  { label: 'Space', seq: ' ' },
  { label: 'Enter', seq: '\r' },
  { label: 'Del', seq: '\x1b[3~' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: 'End', seq: '\x1b[F' },
];

export const ARROW_KEYS: PhysKey[] = [
  { label: '↑', seq: '\x1b[A' },
  { label: '←', seq: '\x1b[D' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
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
