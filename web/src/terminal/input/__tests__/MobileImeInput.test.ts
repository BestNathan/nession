// web/src/terminal/input/__tests__/MobileImeInput.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { MobileImeInput } from '../MobileImeInput';

interface FakeTerminal {
  terminal: Terminal;
  fireCursorMove: () => void;
  fireRender: () => void;
  cursorMoveDisposed: () => boolean;
  renderDisposed: () => boolean;
  setCursor: (x: number, y: number) => void;
}

/**
 * Minimal xterm stand-in: the real Terminal needs a live renderer, so the class
 * is exercised against the exact surface it touches (buffer cursor, cols, the
 * two event emitters, element, and the private render-service cell size).
 */
function makeTerminal(host: HTMLElement, cell?: { width: number; height: number }): FakeTerminal {
  const cursor = { x: 0, y: 0 };
  const cursorMoveCbs: Array<() => void> = [];
  const renderCbs: Array<() => void> = [];
  let cursorMoveDisposed = false;
  let renderDisposed = false;

  const helper = document.createElement('textarea');
  helper.className = 'xterm-helper-textarea';
  host.appendChild(helper);

  const terminal = {
    cols: 80,
    element: host,
    get buffer() {
      return { active: { get cursorX() { return cursor.x; }, get cursorY() { return cursor.y; } } };
    },
    onCursorMove(cb: () => void) {
      cursorMoveCbs.push(cb);
      return { dispose: () => { cursorMoveDisposed = true; } };
    },
    onRender(cb: () => void) {
      renderCbs.push(cb);
      return { dispose: () => { renderDisposed = true; } };
    },
    _core: { _renderService: { dimensions: { css: { cell } } } },
  } as unknown as Terminal;

  return {
    terminal,
    fireCursorMove: () => cursorMoveCbs.forEach((cb) => cb()),
    fireRender: () => renderCbs.forEach((cb) => cb()),
    cursorMoveDisposed: () => cursorMoveDisposed,
    renderDisposed: () => renderDisposed,
    setCursor: (x, y) => { cursor.x = x; cursor.y = y; },
  };
}

function touch(x: number, y: number): Touch {
  return { clientX: x, clientY: y } as Touch;
}

function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number): Event {
  const ev = new Event(type, { bubbles: true });
  const list = [touch(x, y)];
  Object.defineProperty(ev, type === 'touchstart' ? 'touches' : 'changedTouches', { value: list });
  return ev;
}

describe('MobileImeInput', () => {
  let host: HTMLElement;
  let onSend: ReturnType<typeof vi.fn<(text: string) => void>>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    onSend = vi.fn<(text: string) => void>();
  });

  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  function mount(cell = { width: 10, height: 20 }) {
    const fake = makeTerminal(host, cell);
    const ime = new MobileImeInput(fake.terminal, host, { onSend });
    return { fake, ime };
  }

  it('appends a focusable textarea to the parent', () => {
    const { ime } = mount();
    expect(ime.element.tagName).toBe('TEXTAREA');
    expect(ime.element.parentElement).toBe(host);
    // Must stay renderable — IMEs skip display:none / visibility:hidden hosts.
    expect(ime.element.style.opacity).toBe('0.01');
    // 16px avoids iOS Safari's focus auto-zoom.
    expect(ime.element.style.fontSize).toBe('16px');
  });

  it('sends committed insertText and clears the textarea', () => {
    const { ime } = mount();
    ime.element.value = 'a';
    const ev = new Event('input') as InputEvent;
    Object.defineProperty(ev, 'inputType', { value: 'insertText' });
    Object.defineProperty(ev, 'data', { value: 'a' });
    Object.defineProperty(ev, 'isComposing', { value: false });
    ime.element.dispatchEvent(ev);

    expect(onSend).toHaveBeenCalledWith('a');
    expect(ime.element.value).toBe('');
  });

  it('ignores input events fired mid-composition', () => {
    const { ime } = mount();
    const ev = new Event('input') as InputEvent;
    Object.defineProperty(ev, 'inputType', { value: 'insertText' });
    Object.defineProperty(ev, 'data', { value: '你' });
    Object.defineProperty(ev, 'isComposing', { value: true });
    ime.element.dispatchEvent(ev);

    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ['Enter', '\r'],
    ['Backspace', '\x7f'],
    ['Escape', '\x1b'],
    ['Tab', '\t'],
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['ArrowLeft', '\x1b[D'],
    ['ArrowRight', '\x1b[C'],
  ])('maps %s to its control sequence', (key, expected) => {
    const { ime } = mount();
    ime.element.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(onSend).toHaveBeenCalledWith(expected);
  });

  it('leaves printable keys to the input event', () => {
    const { ime } = mount();
    ime.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('drops keydown while composing and for the Android 229 placeholder', () => {
    const { ime } = mount();

    ime.element.dispatchEvent(new Event('compositionstart'));
    ime.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(onSend).not.toHaveBeenCalled();

    ime.element.dispatchEvent(new Event('compositionend'));
    ime.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'keyCode229', keyCode: 229, cancelable: true }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears the textarea after compositionend on the next tick', () => {
    vi.useFakeTimers();
    const { ime } = mount();
    ime.element.value = '你好';
    ime.element.dispatchEvent(new Event('compositionend'));

    // Not cleared synchronously — the trailing input event still needs the text.
    expect(ime.element.value).toBe('你好');
    vi.runAllTimers();
    expect(ime.element.value).toBe('');
  });

  it('sends pasted text and prevents the default paste', () => {
    const { ime } = mount();
    const ev = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: { getData: () => 'pasted' },
    });
    ime.element.dispatchEvent(ev);

    expect(onSend).toHaveBeenCalledWith('pasted');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('reports focus and blur through onFocusChange', () => {
    const onFocusChange = vi.fn<(focused: boolean) => void>();
    const fake = makeTerminal(host, { width: 10, height: 20 });
    const ime = new MobileImeInput(fake.terminal, host, { onSend, onFocusChange });

    ime.element.dispatchEvent(new Event('focus'));
    expect(onFocusChange).toHaveBeenCalledWith(true);
    ime.element.dispatchEvent(new Event('blur'));
    expect(onFocusChange).toHaveBeenCalledWith(false);
  });

  describe('cursor tracking', () => {
    it('positions the textarea on the cursor cell', () => {
      const { fake, ime } = mount({ width: 10, height: 20 });
      fake.setCursor(3, 5);
      fake.fireCursorMove();

      expect(ime.element.style.left).toBe('30px');
      expect(ime.element.style.top).toBe('100px');
      expect(ime.element.style.width).toBe('10px');
      expect(ime.element.style.height).toBe('20px');
    });

    it('re-syncs on render', () => {
      const { fake, ime } = mount({ width: 8, height: 16 });
      fake.setCursor(2, 1);
      fake.fireRender();
      expect(ime.element.style.left).toBe('16px');
      expect(ime.element.style.top).toBe('16px');
    });

    it('clamps the cursor to the last column', () => {
      const { fake, ime } = mount({ width: 10, height: 20 });
      fake.setCursor(999, 0);
      fake.fireCursorMove();
      // cols is 80 → clamped to column 79.
      expect(ime.element.style.left).toBe('790px');
    });

    it('falls back to 8x16 when the render service has not measured', () => {
      const fake = makeTerminal(host, undefined);
      const ime = new MobileImeInput(fake.terminal, host, { onSend });
      fake.setCursor(1, 1);
      fake.fireRender();
      expect(ime.element.style.left).toBe('8px');
      expect(ime.element.style.top).toBe('16px');
    });
  });

  describe('tap to focus', () => {
    it('focuses on a stationary tap', () => {
      const { ime } = mount();
      const spy = vi.spyOn(ime.element, 'focus');
      host.dispatchEvent(touchEvent('touchstart', 100, 100));
      host.dispatchEvent(touchEvent('touchend', 102, 103));
      expect(spy).toHaveBeenCalled();
    });

    it('does not focus when the finger moved (scroll or swipe)', () => {
      const { ime } = mount();
      const spy = vi.spyOn(ime.element, 'focus');
      host.dispatchEvent(touchEvent('touchstart', 100, 100));
      host.dispatchEvent(touchEvent('touchend', 100, 160));
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not steal focus from another form field', () => {
      const { ime } = mount();
      const other = document.createElement('input');
      document.body.appendChild(other);
      other.focus();

      const spy = vi.spyOn(ime.element, 'focus');
      host.dispatchEvent(touchEvent('touchstart', 10, 10));
      host.dispatchEvent(touchEvent('touchend', 10, 10));
      expect(spy).not.toHaveBeenCalled();

      other.remove();
    });
  });

  it('redirects focus from xterm helper textarea to its own', () => {
    vi.useFakeTimers();
    const { ime } = mount();
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const spy = vi.spyOn(ime.element, 'focus');

    helper?.dispatchEvent(new Event('focus'));
    vi.runAllTimers();

    expect(spy).toHaveBeenCalled();
  });

  it('sendText forwards straight to onSend', () => {
    const { ime } = mount();
    ime.sendText('ls\r');
    expect(onSend).toHaveBeenCalledWith('ls\r');
  });

  describe('dispose', () => {
    it('removes the textarea and disposes xterm subscriptions', () => {
      const { fake, ime } = mount();
      ime.dispose();

      expect(ime.element.parentElement).toBeNull();
      expect(fake.cursorMoveDisposed()).toBe(true);
      expect(fake.renderDisposed()).toBe(true);
    });

    it('stops handling events after dispose', () => {
      const { ime } = mount();
      ime.dispose();

      ime.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      ime.sendText('x');
      expect(onSend).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const { ime } = mount();
      ime.dispose();
      expect(() => ime.dispose()).not.toThrow();
    });

    it('focus and syncPosition are no-ops after dispose', () => {
      const { ime } = mount();
      const spy = vi.spyOn(ime.element, 'focus');
      ime.dispose();
      ime.focus();
      ime.syncPosition();
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
