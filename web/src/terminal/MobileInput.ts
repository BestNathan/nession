/**
 * MobileInput — a visible textarea that replaces xterm's hidden one on
 * touch devices.  The textarea is positioned at xterm's cursor position
 * (like xterm's _syncTextArea does on desktop), giving the browser and
 * IME a valid, in-viewport editable element to anchor to.
 *
 * All keyboard, IME composition, and paste events flow through this
 * textarea natively.  Committed text goes directly to the PTY via
 * onSend (ConnectionManager.send).  xterm handles rendering only.
 */

import type { Terminal } from '@xterm/xterm';

export interface MobileInputCallbacks {
  onSend: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
}

export class MobileInput {
  readonly element: HTMLTextAreaElement;
  private disposed = false;
  private callbacks: MobileInputCallbacks;
  private terminal: Terminal;
  private isComposing = false;

  constructor(
    terminal: Terminal,
    parent: HTMLElement,
    callbacks: MobileInputCallbacks,
  ) {
    this.callbacks = callbacks;
    this.terminal = terminal;

    // ── find xterm's hidden textarea ──
    const termEl = terminal.element!;
    const xta = termEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;

    // ── create our textarea ──
    const ta = document.createElement('textarea');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocomplete', 'off');
    ta.style.cssText =
      'position:absolute;' +
      'z-index:10;' +
      // Nearly invisible — just enough to be a valid IME anchor.
      'opacity:0.01;' +
      'background:transparent;' +
      'color:transparent;' +
      'caret-color:transparent;' +
      'border:none;' +
      'padding:0; margin:0;' +
      'font-family:monospace;' +
      'font-size:16px;' +    // prevent iOS auto-zoom
      'line-height:1;' +
      'resize:none;' +
      'overflow:hidden;' +
      'outline:none;' +
      // Start as a 1×1 px dot; syncPosition() sizes it to cursor cell.
      'width:1px; height:1px;' +
      'left:0; top:0;';

    // ── position syncing ──
    // Update textarea position when the cursor moves.
    const onCursorMove = this.terminal.onCursorMove(() => this.syncPosition());
    // Also sync after terminal output (cursor may have moved).
    const onRender = this.terminal.onRender(() => this.syncPosition());

    // ── input: committed text ──
    ta.addEventListener('input', (ev: Event) => {
      if (this.disposed) { return; }
      const ie = ev as InputEvent;
      if (ie.inputType === 'insertText' && ie.data && !ie.isComposing) {
        this.callbacks.onSend(ie.data);
        ta.value = '';
      }
    });

    // ── keydown: special keys ──
    ta.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (this.disposed) { return; }
      if (this.isComposing || ev.isComposing || ev.keyCode === 229) { return; }

      switch (ev.key) {
        case 'Enter':       ev.preventDefault(); this.callbacks.onSend('\r');     ta.value = ''; break;
        case 'Backspace':   ev.preventDefault(); this.callbacks.onSend('\x7f');                 break;
        case 'Escape':      ev.preventDefault(); this.callbacks.onSend('\x1b');                 break;
        case 'Tab':         ev.preventDefault(); this.callbacks.onSend('\t');                   break;
        case 'ArrowUp':     ev.preventDefault(); this.callbacks.onSend('\x1b[A');               break;
        case 'ArrowDown':   ev.preventDefault(); this.callbacks.onSend('\x1b[B');               break;
        case 'ArrowLeft':   ev.preventDefault(); this.callbacks.onSend('\x1b[D');               break;
        case 'ArrowRight':  ev.preventDefault(); this.callbacks.onSend('\x1b[C');               break;
      }
    });

    // ── composition tracking ──
    ta.addEventListener('compositionstart', () => { this.isComposing = true; });
    ta.addEventListener('compositionend', () => {
      this.isComposing = false;
      setTimeout(() => { if (!this.disposed) { ta.value = ''; } }, 0);
    });

    // ── paste ──
    ta.addEventListener('paste', (ev: ClipboardEvent) => {
      if (this.disposed) { return; }
      const text = ev.clipboardData?.getData('text/plain');
      if (text) { ev.preventDefault(); this.callbacks.onSend(text); }
    });

    // ── focus / blur ──
    ta.addEventListener('focus', () => this.callbacks.onFocusChange?.(true));
    ta.addEventListener('blur', () => this.callbacks.onFocusChange?.(false));

    // ── redirect focus from xterm's textarea ──
    if (xta) {
      xta.addEventListener('focus', () => {
        if (this.disposed || document.activeElement === ta) { return; }
        setTimeout(() => ta.focus(), 0);
      });
    }

    parent.appendChild(ta);
    this.element = ta;

    // Clean up xterm subscriptions on dispose.
    const origDispose = this.dispose.bind(this);
    this.dispose = () => {
      onCursorMove.dispose();
      onRender.dispose();
      origDispose();
    };
  }

  /** Position the textarea at xterm's cursor location. */
  syncPosition(): void {
    if (this.disposed) { return; }
    try {
      const buffer = this.terminal.buffer.active;
      const cursorX = Math.min(buffer.cursorX, this.terminal.cols - 1);
      const cursorY = buffer.cursorY; // relative to viewport

      const cell = this.getCellDimensions();
      if (cell.width < 1 || cell.height < 1) { return; }

      this.element.style.left = `${cursorX * cell.width}px`;
      this.element.style.top = `${cursorY * cell.height}px`;
      this.element.style.width = `${Math.max(cell.width, 1)}px`;
      this.element.style.height = `${Math.max(cell.height, 1)}px`;
    } catch {
      // Terminal may not be fully initialised yet.
    }
  }

  /** Read cell pixel dimensions from xterm's render service internals. */
  private getCellDimensions(): { width: number; height: number } {
    const internals = this.terminal as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
    };
    const cell = internals._core?._renderService?.dimensions?.css?.cell;
    return { width: cell?.width ?? 8, height: cell?.height ?? 16 };
  }

  focus(): void {
    if (this.disposed) { return; }
    this.syncPosition();
    this.element.focus();
  }

  sendText(text: string): void {
    this.callbacks.onSend(text);
  }

  dispose(): void {
    this.disposed = true;
    if (this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
