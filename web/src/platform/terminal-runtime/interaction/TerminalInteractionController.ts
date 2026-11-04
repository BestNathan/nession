import type { TerminalDisposable } from '../emulator';

/** Semantic key intents — presentation must not own escape sequences (#1096). */
export type TerminalSemanticKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Escape'
  | 'Tab'
  | 'Enter'
  | 'Backspace'
  | 'Delete'
  | 'Space';

const SEMANTIC_KEYS: ReadonlySet<string> = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Space',
]);

/** A one-shot modifier a capsule chord may select. */
export type TerminalChordModifier = 'ctrl' | 'alt' | 'shift';

/**
 * The letters the capsule's one-shot selector offers.
 *
 * Uppercase because the selector's painted keycaps are uppercase and a chord is
 * named the way the user reads it; the encoding below decides the case each
 * modifier actually sends.
 */
export type TerminalChordLetter =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

export const TERMINAL_CHORD_LETTERS: readonly TerminalChordLetter[] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

/** Non-printing keys a one-shot modifier may combine with. */
export const TERMINAL_CHORD_SPECIAL_KEYS = [
  'Escape',
  'Tab',
  'Space',
  'Enter',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;

export type TerminalChordSpecialKey = typeof TERMINAL_CHORD_SPECIAL_KEYS[number];

export type TerminalChordKey = TerminalChordLetter | TerminalChordSpecialKey;

const CHORD_ARROW_FINAL: Record<
  Extract<TerminalChordSpecialKey, `Arrow${string}`>,
  string
> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowLeft: 'D',
  ArrowRight: 'C',
};

/** xterm's modifier bitfield, +1, for `CSI 1;<modifier>` key encodings. */
const CHORD_MODIFIER_PARAM: Record<TerminalChordModifier, number> = {
  shift: 2,
  alt: 3,
  ctrl: 5,
};

function isChordLetter(key: TerminalChordKey): key is TerminalChordLetter {
  return key.length === 1;
}

/**
 * Encode one one-shot chord, atomically, the way xterm encodes the same
 * physical modifier + key (#2710 SC-02/SC-03).
 *
 * The UI never spells these bytes. A capsule chord must be the *same* terminal
 * input a physical keyboard would produce, so this mirrors `xterm`'s keyboard
 * evaluator for the keys the capsule exposes:
 *
 * - Ctrl + letter is the C0 control byte (`Ctrl+C` → `0x03`);
 * - Alt + letter is the ESC-prefixed meta form;
 * - Shift + letter is the uppercase character;
 * - modified cursor/Home/End/Delete keys use the `CSI 1;<modifier>` form, which
 *   is mode-independent — a modified arrow does not switch to the DECCKM
 *   `SS3` spelling;
 * - Tab and Enter keep the combinations xterm itself sends (`Shift+Tab` is
 *   `CSI Z`; Alt+Tab still sends HT; Ctrl/Alt+Enter still send CR).
 *
 * Returns one string so a chord is one `input()` call, never a sequence of
 * writes. It is a pure function because the caller that owns the terminal —
 * {@link TerminalInteractionController.sendChord} — should not be the only
 * place the mapping can be tested.
 */
export function encodeTerminalChord(
  modifier: TerminalChordModifier,
  key: TerminalChordKey,
): string {
  if (isChordLetter(key)) {
    switch (modifier) {
      case 'ctrl':
        return String.fromCharCode(key.charCodeAt(0) - 64);
      case 'alt':
        return `\x1b${key.toLowerCase()}`;
      case 'shift':
        return key.toUpperCase();
    }
  }

  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      return `\x1b[1;${CHORD_MODIFIER_PARAM[modifier]}${CHORD_ARROW_FINAL[key]}`;
    case 'Escape':
      return modifier === 'alt' ? '\x1b\x1b' : '\x1b';
    case 'Tab':
      return modifier === 'shift' ? '\x1b[Z' : '\t';
    case 'Enter':
      return modifier === 'alt' ? '\x1b\r' : '\r';
    case 'Space':
      return modifier === 'ctrl' ? '\x00' : modifier === 'alt' ? '\x1b ' : ' ';
    case 'Delete':
      return `\x1b[3;${CHORD_MODIFIER_PARAM[modifier]}~`;
  }
}

function isSemanticKey(key: string): key is TerminalSemanticKey {
  return SEMANTIC_KEYS.has(key);
}

/** Cursor keys whose final byte is the same in both cursor modes. */
type CursorKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

const CURSOR_KEY_FINAL: Record<CursorKey, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowLeft: 'D',
  ArrowRight: 'C',
  Home: 'H',
  End: 'F',
};

function isCursorKey(key: TerminalSemanticKey): key is CursorKey {
  return key in CURSOR_KEY_FINAL;
}

/**
 * Keys whose encoding does not vary with the cursor mode. Exhaustive by type,
 * so adding a TerminalSemanticKey without deciding its sequence is a compile
 * error rather than a key that silently sends nothing.
 */
const FIXED_KEY_SEQUENCES: Record<Exclude<TerminalSemanticKey, CursorKey>, string> = {
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
  Escape: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Backspace: '\x7f',
  Space: ' ',
};

/**
 * The terminal surface this encoder may use: committed input, paste, the one
 * mode that changes a key's bytes, and the disposable `onData` stream. It is a
 * structural subset of {@link TerminalEmulator}, so the interaction owner never
 * imports xterm (#2581).
 */
export interface TerminalInteractionPort {
  input(data: string, wasUserInput?: boolean): void;
  paste(text: string): void;
  readModes(): { readonly applicationCursorKeysMode: boolean };
  onData(listener: (data: string) => void): TerminalDisposable;
}

/**
 * Single authority for PTY-bound bytes: keyboard semantics, paste, and committed
 * text. UI adapters call this instead of hand-writing ANSI (#1096).
 */
export class TerminalInteractionController {
  constructor(
    private readonly terminal: TerminalInteractionPort,
    private readonly sendToPty: (data: string) => void,
  ) {}

  /** Raw bytes already encoded for the PTY (includes Ctrl+D / EOT). */
  sendPtyBytes(data: string): void {
    if (data.length === 0) { return; }
    this.sendToPty(data);
  }

  /** Committed user text (IME, insertText, programmatic). */
  sendText(text: string): void {
    if (text.length === 0) { return; }
    this.terminal.input(text, true);
  }

  /**
   * Clipboard paste — xterm applies bracketed-paste encoding from current mode.
   * The resulting bytes are delivered through the same onData path as keyboard.
   */
  paste(text: string): void {
    if (text.length === 0) { return; }
    this.terminal.paste(text);
  }

  /**
   * Encode a semantic key for the terminal's *current* mode, so App/mobile
   * controls produce the bytes a physical keyboard would (#1096).
   *
   * This cannot be delegated by dispatching a synthetic KeyboardEvent: an event
   * built from KeyboardEventInit carries `keyCode` 0, xterm's key evaluator is
   * keyCode-driven, so it matched nothing and emitted nothing — silently, since
   * an unrecognised key is indistinguishable from a key that was never pressed.
   * The mode comes from the terminal's own proposed `modes` API, and the bytes
   * go back through `input()` so they take the same onData path — and the same
   * `disableStdin` gate — as real typing.
   */
  sendSemanticKey(key: TerminalSemanticKey): void {
    const bytes = isCursorKey(key)
      ? `\x1b${this.terminal.readModes().applicationCursorKeysMode ? 'O' : '['}${CURSOR_KEY_FINAL[key]}`
      : FIXED_KEY_SEQUENCES[key];
    this.terminal.input(bytes, true);
  }

  trySendSemanticKey(key: string): boolean {
    if (!isSemanticKey(key)) {
      return false;
    }
    this.sendSemanticKey(key);
    return true;
  }

  /**
   * Send one one-shot modifier chord as a single atomic `input()`.
   *
   * The bytes come from {@link encodeTerminalChord}; this method exists so the
   * UI never composes an escape and so a chord takes the same `disableStdin`
   * gate and `onData` path as a physical keypress (#2710 SC-02/SC-03).
   */
  sendChord(modifier: TerminalChordModifier, key: TerminalChordKey): void {
    this.terminal.input(encodeTerminalChord(modifier, key), true);
  }

  /** Wire terminal onData → PTY once; idempotent per controller instance. */
  bindXtermOnData(): () => void {
    const disposable = this.terminal.onData((data) => {
      this.sendToPty(data);
    });
    return () => disposable.dispose();
  }

}
