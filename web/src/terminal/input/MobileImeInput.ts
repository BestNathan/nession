import type { Terminal } from '@xterm/xterm';

/** Max finger movement (px) still counted as a tap rather than a scroll. */
const TAP_MOVE_THRESHOLD = 10;
/** Fallback cell size when xterm's render service has not measured yet. */
const FALLBACK_CELL = { width: 8, height: 16 };

export interface MobileImeInputCallbacks {
  onSend: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
}

/** Special keys that mobile soft keyboards emit as real keydown events. */
const KEY_MAP: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Escape: '\x1b',
  Tab: '\t',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowLeft: '\x1b[D',
  ArrowRight: '\x1b[C',
};

/**
 * MobileImeInput — a real, focusable textarea that replaces xterm's hidden one
 * on touch devices.
 *
 * xterm.js is built for physical keyboards: it parks `.xterm-helper-textarea`
 * out of the way and drives composition through its own CompositionHelper.
 * Mobile IMEs (especially Chinese/Japanese) need a genuine, in-viewport,
 * cursor-anchored editable element or they commit text to nowhere — which is
 * why IME input "sometimes works, sometimes doesn't" without this class.
 *
 * This textarea is anchored at xterm's cursor cell and kept there as the cursor
 * moves, so the IME candidate window follows the caret. All keyboard, IME
 * composition, and paste events are handled natively here; committed text is
 * sent straight to the PTY via `onSend`. xterm is left to render only.
 *
 * Only instantiated for the mobile device profile — a touch-capable laptop
 * keeps the desktop path, because this textarea deliberately does not
 * translate Ctrl/Alt chords (xterm does that far better).
 */
export class MobileImeInput {
  readonly element: HTMLTextAreaElement;

  private disposed = false;
  private isComposing = false;
  private tapStart = { x: 0, y: 0 };
  private cleanups: Array<() => void> = [];

  constructor(
    private terminal: Terminal,
    parent: HTMLElement,
    private callbacks: MobileImeInputCallbacks,
  ) {
    this.element = this.createTextarea();
    parent.appendChild(this.element);
    this.cleanups.push(() => this.element.remove());

    this.bindInputEvents();
    this.bindCursorTracking();
    this.bindFocusRedirect();
    this.bindTapToFocus(parent);
    this.syncPosition();
  }

  /**
   * Nearly-invisible but genuinely rendered: `opacity: 0.01` keeps it a valid
   * IME anchor (a `display:none` / `visibility:hidden` element is skipped by
   * IMEs), while `font-size: 16px` stops iOS Safari from auto-zooming on focus.
   */
  private createTextarea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', 'Terminal input');
    ta.className = 'nession-mobile-ime-input';
    ta.style.cssText = [
      'position:absolute',
      'z-index:10',
      'opacity:0.01',
      'background:transparent',
      'color:transparent',
      'caret-color:transparent',
      'border:none',
      'padding:0',
      'margin:0',
      'font-family:monospace',
      'font-size:16px',
      'line-height:1',
      'resize:none',
      'overflow:hidden',
      'outline:none',
      'width:1px',
      'height:1px',
      'left:0',
      'top:0',
    ].join(';');
    return ta;
  }

  /** Committed text, special keys, IME composition and paste. */
  private bindInputEvents(): void {
    const ta = this.element;

    this.on(ta, 'input', (ev) => {
      const ie = ev as InputEvent;
      // Composition commits arrive via compositionend → a following input
      // event with isComposing already false, so guard on both.
      if (ie.inputType === 'insertText' && ie.data && !ie.isComposing) {
        this.callbacks.onSend(ie.data);
        ta.value = '';
      }
    });

    this.on(ta, 'keydown', (ev) => {
      const ke = ev as KeyboardEvent;
      // keyCode 229 is the Android "processing key" placeholder emitted while
      // an IME is mid-composition; treating it as a real key would double-send.
      if (this.isComposing || ke.isComposing || ke.keyCode === 229) { return; }
      const data = KEY_MAP[ke.key];
      if (!data) { return; }
      ke.preventDefault();
      this.callbacks.onSend(data);
      if (ke.key === 'Enter') { ta.value = ''; }
    });

    this.on(ta, 'compositionstart', () => { this.isComposing = true; });
    this.on(ta, 'compositionend', () => {
      this.isComposing = false;
      // Clear after the browser has dispatched the trailing input event that
      // carries the committed text, otherwise that text is lost.
      setTimeout(() => { if (!this.disposed) { ta.value = ''; } }, 0);
    });

    this.on(ta, 'paste', (ev) => {
      const text = (ev as ClipboardEvent).clipboardData?.getData('text/plain');
      if (text) {
        ev.preventDefault();
        this.callbacks.onSend(text);
      }
    });

    this.on(ta, 'focus', () => this.callbacks.onFocusChange?.(true));
    this.on(ta, 'blur', () => this.callbacks.onFocusChange?.(false));
  }

  /** Follow the caret so the IME candidate window renders at the right cell. */
  private bindCursorTracking(): void {
    const onCursorMove = this.terminal.onCursorMove(() => this.syncPosition());
    const onRender = this.terminal.onRender(() => this.syncPosition());
    this.cleanups.push(() => { onCursorMove.dispose(); onRender.dispose(); });
  }

  /**
   * xterm still focuses its own helper textarea on click/programmatic focus().
   * Bounce that to ours so the IME always talks to the element we control.
   */
  private bindFocusRedirect(): void {
    const helper = this.terminal.element?.querySelector<HTMLTextAreaElement>(
      '.xterm-helper-textarea',
    );
    if (!helper) { return; }
    this.on(helper, 'focus', () => {
      if (document.activeElement === this.element) { return; }
      // Deferred: focusing synchronously inside a focus handler is ignored by
      // some browsers.
      setTimeout(() => { if (!this.disposed) { this.element.focus(); } }, 0);
    });
  }

  /**
   * Tap the terminal → open the soft keyboard. Discriminates taps from scrolls
   * and swipes by movement distance so the keyboard does not pop up mid-scroll.
   */
  private bindTapToFocus(parent: HTMLElement): void {
    this.on(parent, 'touchstart', (ev) => {
      const touch = (ev as TouchEvent).touches[0];
      if (touch) { this.tapStart = { x: touch.clientX, y: touch.clientY }; }
    }, { passive: true });

    this.on(parent, 'touchend', (ev) => {
      const touch = (ev as TouchEvent).changedTouches[0];
      if (!touch) { return; }
      const movedX = Math.abs(touch.clientX - this.tapStart.x);
      const movedY = Math.abs(touch.clientY - this.tapStart.y);
      if (movedX >= TAP_MOVE_THRESHOLD || movedY >= TAP_MOVE_THRESHOLD) { return; }
      // Never steal focus from a real form field (input panel, file rename…).
      const active = document.activeElement;
      if (active && active !== this.element
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        return;
      }
      this.focus();
    }, { passive: true });
  }

  /** Register a listener and remember how to remove it. */
  private on(
    target: EventTarget,
    type: string,
    handler: (ev: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    const guarded = (ev: Event) => { if (!this.disposed) { handler(ev); } };
    target.addEventListener(type, guarded, options);
    this.cleanups.push(() => target.removeEventListener(type, guarded, options));
  }

  /** Move the textarea onto xterm's current cursor cell. */
  syncPosition(): void {
    if (this.disposed) { return; }
    try {
      const buffer = this.terminal.buffer.active;
      const cursorX = Math.min(buffer.cursorX, Math.max(this.terminal.cols - 1, 0));
      const cursorY = buffer.cursorY;
      const cell = this.cellDimensions;
      if (cell.width < 1 || cell.height < 1) { return; }

      this.element.style.left = `${cursorX * cell.width}px`;
      this.element.style.top = `${cursorY * cell.height}px`;
      this.element.style.width = `${cell.width}px`;
      this.element.style.height = `${cell.height}px`;
    } catch {
      // Terminal not fully initialised yet — the next onRender will retry.
    }
  }

  /** Cell pixel size from xterm's render service, with a sane fallback. */
  private get cellDimensions(): { width: number; height: number } {
    const internals = this.terminal as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width: number; height: number } } };
        };
      };
    };
    const cell = internals._core?._renderService?.dimensions?.css?.cell;
    return {
      width: cell?.width ?? FALLBACK_CELL.width,
      height: cell?.height ?? FALLBACK_CELL.height,
    };
  }

  focus(): void {
    if (this.disposed) { return; }
    this.syncPosition();
    this.element.focus();
  }

  /** Send text as if typed here (toolbar / quick-command path). */
  sendText(text: string): void {
    if (this.disposed) { return; }
    this.callbacks.onSend(text);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* best-effort teardown */ }
    }
    this.cleanups = [];
  }
}
