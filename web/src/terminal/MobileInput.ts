/**
 * MobileInput — a visible textarea that replaces xterm's hidden one on
 * touch devices.  xterm.js is designed for physical keyboards and hides
 * its textarea off-screen (left:-9999em; opacity:0).  On mobile this
 * prevents the virtual keyboard and IME from working reliably because
 * browsers need a visible, in-viewport editable element.
 *
 * MobileInput creates its own textarea positioned at the bottom of the
 * terminal viewport.  All keyboard, IME composition, and paste events
 * flow through it naturally — the browser handles IME composition just
 * like any other textarea.  Committed text is sent directly to the PTY
 * via the onSend callback (ConnectionManager.send), bypassing xterm's
 * input pipeline entirely.
 *
 * xterm continues to render output (terminal.write) and handle mouse/
 * touch selection — it just doesn't participate in keyboard input.
 */

export interface MobileInputCallbacks {
  /** Send committed text directly to the PTY. */
  onSend: (text: string) => void;
  /** Called when the textarea receives or loses focus. */
  onFocusChange?: (focused: boolean) => void;
}

export class MobileInput {
  readonly element: HTMLTextAreaElement;
  private disposed = false;
  private callbacks: MobileInputCallbacks;
  private isComposing = false;

  /**
   * @param terminalElement  The `.xterm` div (returned by terminal.open).
   * @param parent           Container to append our textarea into.
   */
  constructor(
    terminalElement: HTMLElement,
    parent: HTMLElement,
    callbacks: MobileInputCallbacks,
  ) {
    this.callbacks = callbacks;

    // ── find xterm's hidden textarea ──
    const xta = terminalElement.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;

    // ── create our textarea ──
    const ta = document.createElement('textarea');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    // Prevent iOS auto-zoom on focus.
    ta.style.fontSize = '16px';
    // Positioned at the bottom of the terminal viewport.
    ta.style.cssText =
      'position:absolute; bottom:0; left:0; right:0;' +
      'z-index:10;' +
      // Semi-transparent — visible enough for the browser to anchor IME
      // but not visually distracting.
      'background:rgba(30,30,46,0.95);' +
      'color:#cdd6f4;' +
      'border:none; border-top:1px solid rgba(255,255,255,0.08);' +
      'padding:6px 8px;' +
      'font-family:monospace;' +
      'line-height:1.3;' +
      'resize:none; overflow:hidden;' +
      'outline:none;';
    ta.rows = 1;
    ta.placeholder = 'Tap to type…';

    // ── input: committed text (IME and non-IME) ──
    ta.addEventListener('input', (ev: Event) => {
      if (this.disposed) { return; }
      const ie = ev as InputEvent;
      if (ie.inputType === 'insertText' && ie.data && !ie.isComposing) {
        this.callbacks.onSend(ie.data);
        ta.value = '';
      }
    });

    // ── keydown: special keys that don't produce insertText ──
    ta.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (this.disposed) { return; }
      // During IME composition, let the browser handle everything.
      if (this.isComposing || ev.isComposing || ev.keyCode === 229) { return; }

      switch (ev.key) {
        case 'Enter':
          ev.preventDefault();
          this.callbacks.onSend('\r');
          ta.value = '';
          break;
        case 'Backspace':
          ev.preventDefault();
          this.callbacks.onSend('\x7f');
          break;
        case 'Escape':
          ev.preventDefault();
          this.callbacks.onSend('\x1b');
          break;
        case 'Tab':
          ev.preventDefault();
          this.callbacks.onSend('\t');
          break;
        case 'ArrowUp':
          ev.preventDefault();
          this.callbacks.onSend('\x1b[A');
          break;
        case 'ArrowDown':
          ev.preventDefault();
          this.callbacks.onSend('\x1b[B');
          break;
        case 'ArrowLeft':
          ev.preventDefault();
          this.callbacks.onSend('\x1b[D');
          break;
        case 'ArrowRight':
          ev.preventDefault();
          this.callbacks.onSend('\x1b[C');
          break;
        default:
          // Regular character keys are handled by the input event above.
          // Do nothing here — the character will come through as insertText.
          break;
      }
    });

    // ── track composition state ──
    ta.addEventListener('compositionstart', () => { this.isComposing = true; });
    ta.addEventListener('compositionend', () => {
      this.isComposing = false;
      // After composition, the committed text arrives via the input
      // event (insertText, isComposing=false), which we handle above.
      // Clear any leftover composing text from the textarea.
      setTimeout(() => { ta.value = ''; }, 0);
    });

    // ── paste ──
    ta.addEventListener('paste', (ev: ClipboardEvent) => {
      if (this.disposed) { return; }
      const text = ev.clipboardData?.getData('text/plain');
      if (text) {
        ev.preventDefault();
        this.callbacks.onSend(text);
      }
    });

    // ── focus / blur ──
    ta.addEventListener('focus', () => this.callbacks.onFocusChange?.(true));
    ta.addEventListener('blur', () => this.callbacks.onFocusChange?.(false));

    // ── redirect focus from xterm's hidden textarea to ours ──
    if (xta) {
      // xterm's mousedown handler calls this.textarea.focus().
      // On mobile, the soft keyboard needs a visible textarea — if
      // focus lands on xterm's hidden one, steal it back.
      xta.addEventListener('focus', () => {
        if (this.disposed || document.activeElement === ta) { return; }
        setTimeout(() => ta.focus(), 0);
      });
    }

    parent.appendChild(ta);
    this.element = ta;
  }

  /** Programmatically focus our textarea (call on terminal tap). */
  focus(): void {
    if (this.disposed) { return; }
    this.element.focus();
  }

  /** Send text programmatically (e.g. from quick-command buttons). */
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
