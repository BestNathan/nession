// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapsuleOcclusionScroll,
  type CapsuleScrollTerminalPort,
} from '@/platform/terminal-runtime/capsule/occlusionScroll';
import type { TerminalMouseTrackingMode } from '@/platform/terminal-runtime/emulator';

const noopDisposable = () => ({ dispose: () => {} });

function touch(element: HTMLElement, type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  });
  element.dispatchEvent(event);
  return event;
}

function fixture({
  type = 'normal',
  mouse = 'none',
  length = 100,
}: {
  type?: 'normal' | 'alternate';
  mouse?: TerminalMouseTrackingMode;
  length?: number;
} = {}) {
  const host = document.createElement('div');
  const element = document.createElement('div');
  host.appendChild(element);
  document.body.appendChild(host);
  const buffer = { type, length, viewportY: type === 'normal' ? length - 24 : 0 };
  const scrollLines = vi.fn((lines: number) => {
    buffer.viewportY = Math.max(0, Math.min(length - 24, buffer.viewportY + lines));
  });
  const wheel = vi.fn<(event: WheelEvent) => void>();
  element.addEventListener('wheel', wheel);
  const port: CapsuleScrollTerminalPort = {
    element,
    rows: 24,
    readBuffer: () => ({ ...buffer, cursorX: 0, cursorY: 0 }),
    readModes: () => ({
      mouseTrackingMode: mouse,
      alternateBuffer: type === 'alternate',
      applicationCursorKeysMode: false,
      bracketedPasteMode: false,
    }),
    onScroll: noopDisposable,
    onResize: noopDisposable,
    attachCustomWheelHandler: vi.fn(),
    scrollLines,
    scrollPages: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  const scroll = new CapsuleOcclusionScroll(port, host, () => 16);
  scroll.bind();
  return { element, host, scroll, scrollLines, wheel };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  // Geometry settling is orthogonal to the finger/scroll ownership path.
  vi.stubGlobal('requestAnimationFrame', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('mobile terminal vertical drag scroll routing', () => {
  it('scrolls ordinary shell history locally and accumulates sub-cell finger motion', () => {
    const f = fixture();
    touch(f.element, 'touchstart', 100, 200);
    const first = touch(f.element, 'touchmove', 101, 190);
    expect(first.defaultPrevented).toBe(true);
    expect(f.scrollLines).not.toHaveBeenCalled();
    touch(f.element, 'touchmove', 101, 182);
    expect(f.scrollLines).toHaveBeenCalledTimes(1);
    expect(f.scrollLines).toHaveBeenCalledWith(1);
    expect(f.wheel).not.toHaveBeenCalled();
    f.scroll.dispose();
  });

  it('converts a drag to wheel only for a mouse-reporting TUI', () => {
    const f = fixture({ mouse: 'vt200' });
    touch(f.element, 'touchstart', 100, 200);
    const event = touch(f.element, 'touchmove', 100, 170);
    expect(event.defaultPrevented).toBe(true);
    expect(f.scrollLines).not.toHaveBeenCalled();
    expect(f.wheel).toHaveBeenCalledTimes(1);
    expect(f.wheel.mock.calls[0][0].deltaY).toBe(30);
    f.scroll.dispose();
  });

  it('routes an alternate-screen drag through xterm wheel semantics', () => {
    const f = fixture({ type: 'alternate', length: 24 });
    touch(f.element, 'touchstart', 100, 200);
    touch(f.element, 'touchmove', 100, 176);
    expect(f.wheel).toHaveBeenCalledTimes(1);
    expect(f.scrollLines).not.toHaveBeenCalled();
    touch(f.element, 'touchend', 100, 176);
    touch(f.element, 'touchmove', 100, 140);
    expect(f.wheel).toHaveBeenCalledTimes(1);
    f.scroll.dispose();
  });

  it('does not steal horizontal selection, ordinary taps or untracked gestures', () => {
    const f = fixture({ mouse: 'vt200' });
    touch(f.element, 'touchstart', 100, 200);
    touch(f.element, 'touchmove', 140, 198);
    touch(f.element, 'touchmove', 145, 140);
    expect(f.wheel).not.toHaveBeenCalled();
    expect(f.scrollLines).not.toHaveBeenCalled();
    touch(f.element, 'touchcancel', 145, 140);
    touch(f.element, 'touchstart', 100, 200);
    touch(f.element, 'touchend', 100, 200);
    expect(f.wheel).not.toHaveBeenCalled();
    f.scroll.dispose();
  });
});
