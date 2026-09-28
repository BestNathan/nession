import type { Terminal } from '@xterm/xterm';

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
 * Single authority for PTY-bound bytes: keyboard semantics, paste, and committed
 * text. UI adapters call this instead of hand-writing ANSI (#1096).
 */
export class TerminalInteractionController {
  constructor(
    private readonly terminal: Terminal,
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
   * The mode comes from xterm's own proposed `modes` API, and the bytes go back
   * through `input()` so they take the same onData path — and the same
   * `disableStdin` gate — as real typing.
   */
  sendSemanticKey(key: TerminalSemanticKey): void {
    const bytes = isCursorKey(key)
      ? `\x1b${this.terminal.modes.applicationCursorKeysMode ? 'O' : '['}${CURSOR_KEY_FINAL[key]}`
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

  /** Wire xterm onData → PTY once; idempotent per controller instance. */
  bindXtermOnData(): () => void {
    const disposable = this.terminal.onData((data) => {
      this.sendToPty(data);
    });
    return () => disposable.dispose();
  }

}
