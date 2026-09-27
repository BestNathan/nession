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
    // TEMPORARY DIAGNOSTIC (#1148) — remove once located, along with the module
    // state and `publishDiag` below. Counts **live** subscriptions rather than
    // bind calls: the first version recorded every bind and never removed one
    // on dispose, so a correctly disposed binding still read as present and
    // "2" could not be told apart from "1 live + 1 already closed". That is the
    // difference the fix turns on, so measuring it wrongly was measuring
    // nothing. The dataset is how the number reaches the CI log, because
    // browser console output never does.
    const el = this.terminal.element;
    const stack = (new Error().stack ?? '').split('\n').slice(1, 4).join(' | ');
    diagBindSeq += 1;
    const token = `${diagBindSeq} ${stack}`;
    trackDiag(el, token, true);
    const disposable = this.terminal.onData((data) => {
      this.sendToPty(data);
    });
    return () => {
      trackDiag(el, token, false);
      disposable.dispose();
    };
  }

  private helperTextarea(): HTMLTextAreaElement | null {
    return this.terminal.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null;
  }
}

// TEMPORARY DIAGNOSTIC (#1148) — remove once located, with the block that uses
// it. Keyed by element, not module-global: the count has to describe the one
// terminal the assertion reads, and a single global set would also count
// bindings belonging to any other xterm on the page. The count survives across
// controller instances for the same element, which is the case being measured —
// two bindings on one element may come from two different
// `TerminalInteractionController`s.
let diagBindSeq = 0;
const diagLive = new Map<HTMLElement, Set<string>>();
function trackDiag(el: HTMLElement | null | undefined, token: string, add: boolean): void {
  if (!el) {
    return;
  }
  let tokens = diagLive.get(el);
  if (!tokens) {
    tokens = new Set<string>();
    diagLive.set(el, tokens);
  }
  if (add) {
    tokens.add(token);
  } else {
    tokens.delete(token);
  }
  el.dataset.nessionOnDataLive = String(tokens.size);
  el.dataset.nessionOnDataBindings = [...tokens].join('\n@@@\n');
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
