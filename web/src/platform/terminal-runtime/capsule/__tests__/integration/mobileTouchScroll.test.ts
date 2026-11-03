// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapsuleOcclusionScroll,
  type CapsuleScrollTerminalPort,
} from '@/platform/terminal-runtime/capsule/occlusionScroll';
import type { TerminalMouseTrackingMode } from '@/platform/terminal-runtime/emulator';

/**
 * #2659 — a single-finger vertical drag must scroll *the terminal*, and which
 * terminal answer that is comes from the mode xterm already tracks:
 *
 * - normal buffer, no mouse tracking → Nession's local history (xterm buffer);
 * - mouse-reporting TUI → xterm's wheel path reports it to the application;
 * - alternate screen → xterm's wheel path again (no local history to take).
 *
 * Horizontal drags, second fingers and taps belong to their own owners and are
 * never `preventDefault`ed here.
 */

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface HarnessOptions {
  type?: 'normal' | 'alternate';
  mouseTrackingMode?: TerminalMouseTrackingMode;
}

function makeHarness(options: HarnessOptions = {}) {
  const element = document.createElement('div');
  const host = document.createElement('div');
  // The terminal lives inside the capsule host, exactly like the product; the
  // handler binds on the host in the capture phase (#2659).
  host.appendChild(element);
  document.body.append(host);
  const buffer = {
    type: options.type ?? 'normal',
    viewportY: 16,
    length: 40,
    cursorX: 0,
    cursorY: 0,
  };
  const port: CapsuleScrollTerminalPort = {
    element,
    rows: 24,
    readBuffer: () => ({ ...buffer }),
    readModes: () => ({
      applicationCursorKeysMode: false,
      bracketedPasteMode: false,
      mouseTrackingMode: options.mouseTrackingMode ?? 'none',
      alternateBuffer: buffer.type === 'alternate',
    }),
    onScroll: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
    attachCustomWheelHandler: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollLines: vi.fn((lines: number) => {
      buffer.viewportY = Math.max(0, buffer.viewportY + lines);
    }),
    scrollPages: vi.fn(),
  };
  const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
  occlusion.bind();
  const wheels: WheelEvent[] = [];
  element.addEventListener('wheel', (event) => { wheels.push(event as WheelEvent); });
  return { occlusion, port, element, wheels };
}

function touchEvent(type: 'touchstart' | 'touchmove', points: [number, number][]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  return event;
}

let harnesses: { dispose(): void }[] = [];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0));
  harnesses = [];
});

afterEach(() => {
  for (const harness of harnesses) {
    harness.dispose();
  }
  harnesses = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('mobile touch scroll ownership (#2659)', () => {
  it('scrolls local history with a single-finger vertical drag, without PTY input', () => {
    const harness = makeHarness();
    harnesses.push(harness.occlusion);
    const { element, port } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    const first = touchEvent('touchmove', [[100, 306]]);
    element.dispatchEvent(first);
    // Inside the axis slop: not claimed, so the page/tap owners keep it.
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(false);

    const second = touchEvent('touchmove', [[100, 312]]);
    element.dispatchEvent(second);
    // Claimed as vertical, but less than one cell of travel: no line yet.
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(second.defaultPrevented).toBe(true);

    const third = touchEvent('touchmove', [[100, 324]]);
    element.dispatchEvent(third);
    expect(port.scrollLines).toHaveBeenCalledTimes(1);
    expect(port.scrollLines).toHaveBeenCalledWith(-1);
    expect(harness.occlusion.mode()).toBe('history');
  });

  it('never turns high-frequency tiny moves into one line each', () => {
    const harness = makeHarness();
    harnesses.push(harness.occlusion);
    const { element, port } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    for (let y = 304; y <= 332; y += 4) {
      element.dispatchEvent(touchEvent('touchmove', [[100, y]]));
    }
    // Eight 4px moves: the first chunk decides the axis and is slop, then the
    // remaining 24px of travel is one whole line (16px) with 8px carried —
    // not eight lines for eight moves.
    expect(port.scrollLines).toHaveBeenCalledTimes(1);
    expect(port.scrollLines).toHaveBeenCalledWith(-1);
  });

  it('hands a mouse-reporting TUI drag to xterm’s wheel path', () => {
    const harness = makeHarness({ mouseTrackingMode: 'vt200' });
    harnesses.push(harness.occlusion);
    const { element, port, wheels } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    element.dispatchEvent(touchEvent('touchmove', [[100, 332]]));

    // Local history must not swallow it; the application owns the wheel, and a
    // 32px drag is two lines of wheel travel in one event.
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(wheels.length).toBe(1);
    expect(wheels[0].deltaY).toBe(-32);
    expect(wheels[0].deltaMode).toBe(WheelEvent.DOM_DELTA_PIXEL);
  });

  it('hands an alternate-screen TUI drag to xterm’s wheel path', () => {
    const harness = makeHarness({ type: 'alternate' });
    harnesses.push(harness.occlusion);
    const { element, port, wheels } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    element.dispatchEvent(touchEvent('touchmove', [[100, 332]]));

    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(wheels.length).toBe(1);
    expect(wheels[0].deltaY).toBe(-32);
  });

  it('does not claim a horizontal drag for scrolling', () => {
    const harness = makeHarness();
    harnesses.push(harness.occlusion);
    const { element, port, wheels } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    const move = touchEvent('touchmove', [[140, 302]]);
    element.dispatchEvent(move);
    // A later vertical move cannot steal the locked horizontal gesture.
    const later = touchEvent('touchmove', [[140, 360]]);
    element.dispatchEvent(later);

    expect(move.defaultPrevented).toBe(false);
    expect(later.defaultPrevented).toBe(false);
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(wheels).toEqual([]);
  });

  it('ignores a second finger and a quick tap', () => {
    const harness = makeHarness();
    harnesses.push(harness.occlusion);
    const { element, port, wheels } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300], [200, 300]]));
    const multi = touchEvent('touchmove', [[100, 340], [200, 340]]);
    element.dispatchEvent(multi);
    // A tap is a touchstart with no move; nothing below claims it.
    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));

    expect(multi.defaultPrevented).toBe(false);
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(wheels).toEqual([]);
  });

  it('scrolls forward on an upward drag', () => {
    const harness = makeHarness();
    harnesses.push(harness.occlusion);
    const { element, port } = harness;

    element.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
    element.dispatchEvent(touchEvent('touchmove', [[100, 268]]));
    expect(port.scrollLines).toHaveBeenCalledWith(2);
  });
});
