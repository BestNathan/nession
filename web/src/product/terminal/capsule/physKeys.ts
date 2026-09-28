import type { TerminalSemanticKey } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';

/**
 * A key in the capsule's physical row.
 *
 * **Exactly one of `semanticKey` / `seq`, and the type says which** (#1096
 * criterion 4). A key the runtime can encode from terminal state carries *no*
 * sequence here, so this module — a UI module — cannot own an escape that
 * depends on a mode it cannot see. `seq` remains only for the one key that has
 * no semantic form at all: a bare modifier, which sends no bytes of its own and
 * exists only to start a chord.
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

/**
 * How a key reads in the chain strip: its own label, which is also what the
 * button the user pressed said.
 *
 * A key *name* is the only honest thing to show. It used to render the key's
 * sequence, through a table that mapped escapes back to names — so a semantic
 * key, which has no sequence by construction, had nothing to render, and
 * `Shift`, whose sequence is empty because it sends nothing, came out as
 * `\xNaN`. The table is gone with it: nothing here speaks in escapes any more
 * (#1096 criterion 4).
 */
export function formatKey(key: PhysKey): string {
  return key.label;
}
