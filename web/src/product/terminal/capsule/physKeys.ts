import type {
  TerminalChordKey,
  TerminalChordModifier,
  TerminalChordSpecialKey,
} from '@/platform/terminal-runtime/interaction/TerminalInteractionController';

/**
 * A directly tappable terminal key in the capsule.
 *
 * **It carries a semantic key and no bytes** (#1096 criterion 4). Encoding a
 * key depends on terminal state this UI cannot see, so the interaction runtime
 * owns it; the row names the key and the runtime turns it into the bytes the
 * current mode asks for. The bare modifiers that used to be `seq: ''` entries
 * are gone with the chain: a modifier is now one-shot state in the panel, not a
 * key that could be "sent" by itself (#2710).
 */
export interface PhysKey {
  label: string;
  /**
   * Narrower than `TerminalSemanticKey`: every key this row draws is also a
   * legal one-shot-chord key, which is what lets a selected modifier combine
   * with any of them without a runtime fallback.
   */
  semanticKey: TerminalChordSpecialKey;
}

/** Direct actions, always visible and tap-to-send (#2710 SC-04). */
export const COMMON_KEYS: readonly PhysKey[] = [
  { label: 'Esc', semanticKey: 'Escape' },
  { label: 'Tab', semanticKey: 'Tab' },
  { label: 'Space', semanticKey: 'Space' },
  { label: 'Enter', semanticKey: 'Enter' },
  { label: 'Del', semanticKey: 'Delete' },
];

export const ARROW_KEYS: readonly PhysKey[] = [
  { label: '↑', semanticKey: 'ArrowUp' },
  { label: '←', semanticKey: 'ArrowLeft' },
  { label: '↓', semanticKey: 'ArrowDown' },
  { label: '→', semanticKey: 'ArrowRight' },
];

/** One first-class chord the row offers in a single tap (#2710 SC-02). */
export interface QuickChord {
  /** Painted keycap, e.g. `⌃C`. */
  label: string;
  /** Accessible name, e.g. `Ctrl+C`. */
  ariaLabel: string;
  modifier: TerminalChordModifier;
  key: TerminalChordKey;
}

/** Default set; the requirement allows tuning it against actual use. */
export const QUICK_CHORDS: readonly QuickChord[] = [
  { label: '⌃C', ariaLabel: 'Ctrl+C', modifier: 'ctrl', key: 'C' },
  { label: '⌃R', ariaLabel: 'Ctrl+R', modifier: 'ctrl', key: 'R' },
  { label: '⌃L', ariaLabel: 'Ctrl+L', modifier: 'ctrl', key: 'L' },
];

export interface ModifierChoice {
  modifier: TerminalChordModifier;
  /** Painted label. */
  label: string;
  /** Accessible name. */
  ariaLabel: string;
}

/** The one-shot modifiers (#2710 SC-03). */
export const MODIFIER_CHOICES: readonly ModifierChoice[] = [
  { modifier: 'ctrl', label: 'Ctrl', ariaLabel: 'Control' },
  { modifier: 'alt', label: 'Alt', ariaLabel: 'Alt' },
  { modifier: 'shift', label: '⇧', ariaLabel: 'Shift' },
];
