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
   * Route a semantic key through xterm's keyboard handler so application cursor
   * mode and keypad mode match a physical keyboard.
   */
  sendSemanticKey(key: TerminalSemanticKey): void {
    const helper = this.helperTextarea();
    if (!helper) {
      return;
    }
    const init: KeyboardEventInit = {
      key,
      code: semanticKeyToCode(key),
      bubbles: true,
      cancelable: true,
    };
    helper.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Enter' || key === 'Tab' || key === 'Backspace' || key === 'Delete') {
      helper.dispatchEvent(new KeyboardEvent('keypress', init));
    }
    helper.dispatchEvent(new KeyboardEvent('keyup', init));
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

  private helperTextarea(): HTMLTextAreaElement | null {
    return this.terminal.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null;
  }
}

function semanticKeyToCode(key: TerminalSemanticKey): string {
  switch (key) {
    case 'ArrowUp':
      return 'ArrowUp';
    case 'ArrowDown':
      return 'ArrowDown';
    case 'ArrowLeft':
      return 'ArrowLeft';
    case 'ArrowRight':
      return 'ArrowRight';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    case 'PageUp':
      return 'PageUp';
    case 'PageDown':
      return 'PageDown';
    case 'Escape':
      return 'Escape';
    case 'Tab':
      return 'Tab';
    case 'Enter':
      return 'Enter';
    case 'Backspace':
      return 'Backspace';
    case 'Delete':
      return 'Delete';
    case 'Space':
      return 'Space';
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
