// Physical-key definitions for the FloatingKeyBar overlay.
//
// Mobile keyboards lack PC physical keys (arrows, Home/End/PgUp/PgDn,
// Tab/Esc/Del), so the on-screen key bar sends the corresponding escape
// sequences to the terminal. Kept in a separate module so the component
// file only exports components (react-refresh fast-refresh requirement).

export interface KeyDef {
  /** Label rendered on the button. */
  label: string;
  /** Escape sequence (or control char) sent to the terminal when pressed. */
  command: string;
}

export interface KeyGroup {
  keys: KeyDef[];
}

/** 11 keys in 3 groups (nav / jump / special). */
export const KEY_DEFINITIONS: KeyGroup[] = [
  {
    keys: [
      { label: '←', command: '\x1b[D' },
      { label: '↑', command: '\x1b[A' },
      { label: '↓', command: '\x1b[B' },
      { label: '→', command: '\x1b[C' },
    ],
  },
  {
    keys: [
      { label: 'Home', command: '\x1b[H' },
      { label: 'End', command: '\x1b[F' },
      { label: 'PgUp', command: '\x1b[5~' },
      { label: 'PgDn', command: '\x1b[6~' },
    ],
  },
  {
    keys: [
      { label: 'Tab', command: '\t' },
      { label: 'Esc', command: '\x1b' },
      { label: 'Del', command: '\x1b[3~' },
    ],
  },
];
