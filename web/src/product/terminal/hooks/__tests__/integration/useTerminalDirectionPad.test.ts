import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { isTouchOwned } from '@/shared/lib/touchOwnership';
import { useTerminalDirectionPad } from '../../useTerminalDirectionPad';

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function makeTouch(point: TouchPoint): Touch {
  return {
    identifier: point.identifier,
    clientX: point.clientX,
    clientY: point.clientY,
    pageX: point.clientX,
    pageY: point.clientY,
    screenX: point.clientX,
    screenY: point.clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    target: document.body,
  } as unknown as Touch;
}

function touchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: TouchPoint[],
  changed: TouchPoint[] = points,
  { cancelable = true }: { cancelable?: boolean } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : points.map(makeTouch),
  });
  Object.defineProperty(event, 'targetTouches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : points.map(makeTouch),
  });
  Object.defineProperty(event, 'changedTouches', { value: changed.map(makeTouch) });
  return event;
}

function dispatch(target: EventTarget, event: Event): Event {
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  });
}

function makeController(): TerminalController & {
  sendPhysKey: ReturnType<typeof vi.fn>;
  isObserverReadOnly: boolean;
} {
  return {
    sendPhysKey: vi.fn(),
    isObserverReadOnly: false,
  } as unknown as TerminalController & {
    sendPhysKey: ReturnType<typeof vi.fn>;
    isObserverReadOnly: boolean;
  };
}

describe('useTerminalDirectionPad', () => {
  let container: HTMLDivElement;
  let containerRef: { current: HTMLDivElement | null };
  let controller: ReturnType<typeof makeController>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    setRect(container, { left: 0, top: 0, width: 400, height: 800 });
    containerRef = { current: container };
    controller = makeController();
  });

  afterEach(() => {
    cleanup();
    container.remove();
    vi.useRealTimers();
  });

  function renderPad(options: {
    inputDisabled?: boolean;
    touchEdgeReservation?: (target: EventTarget | null, clientX: number) => boolean;
  } = {}) {
    return renderHook(
      ({ inputDisabled = false }: { inputDisabled?: boolean }) => useTerminalDirectionPad({
        containerRef,
        controller,
        inputDisabled,
        touchEdgeReservation: options.touchEdgeReservation,
      }),
      { initialProps: { inputDisabled: options.inputDisabled ?? false } },
    );
  }

  it('arms on a stationary hold and shows the dial without sending a key', () => {
    const { result } = renderPad();

    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    expect(result.current).toBeNull();

    advance(379);
    expect(result.current).toBeNull();

    advance(1);
    expect(result.current).toMatchObject({
      phase: 'armed',
      direction: null,
      rate: 0,
      count: 0,
      anchorX: 102,
      anchorY: 300,
    });
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
    expect(isTouchOwned(1)).toBe(true);
  });

  it('sends one semantic arrow per direction entry and repeats on its own clock', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);

    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 100, clientY: 260 }]));
    expect(controller.sendPhysKey).toHaveBeenLastCalledWith({ semanticKey: 'ArrowUp' });
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ phase: 'moving', direction: 'up', rate: 1 });

    advance(1_000);
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(2);

    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 140, clientY: 300 }]));
    expect(controller.sendPhysKey).toHaveBeenLastCalledWith({ semanticKey: 'ArrowRight' });
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(3);
  });

  it('owns touchmove only after arming; a pending swipe stays native', () => {
    const downstream = vi.fn();
    document.addEventListener('touchmove', downstream);
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));

    const pending = dispatch(
      container,
      touchEvent('touchmove', [{ identifier: 1, clientX: 106, clientY: 300 }]),
    ) as TouchEvent;
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(pending.defaultPrevented).toBe(false);

    advance(380);
    expect(result.current?.phase).toBe('armed');
    const owned = dispatch(
      container,
      touchEvent('touchmove', [{ identifier: 1, clientX: 140, clientY: 300 }]),
    ) as TouchEvent;
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(owned.defaultPrevented).toBe(true);

    document.removeEventListener('touchmove', downstream);
  });

  it('surrenders a pending drag beyond the pre-arm slop and never arms afterwards', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));

    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 100, clientY: 320 }]));
    advance(1_000);

    expect(result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
    expect(isTouchOwned(1)).toBe(false);
  });

  it('consumes the owned touchend and suppresses the compatibility click', () => {
    const downstreamEnd = vi.fn();
    document.addEventListener('touchend', downstreamEnd);
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 140, clientY: 300 }]));

    dispatch(container, touchEvent('touchend', [], [{ identifier: 1, clientX: 140, clientY: 300 }]));
    expect(downstreamEnd).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    const clickTarget = document.createElement('div');
    container.appendChild(clickTarget);
    act(() => {
      clickTarget.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);

    document.removeEventListener('touchend', downstreamEnd);
  });

  it('cancels when a second finger interrupts the gesture', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    dispatch(container, touchEvent('touchstart', [
      { identifier: 1, clientX: 100, clientY: 300 },
      { identifier: 2, clientX: 180, clientY: 320 },
    ]));

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
  });

  it('cancels on pagehide and drops ownership', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
  });

  it('cancels when the initiating element leaves the document', () => {
    const target = document.createElement('div');
    container.appendChild(target);
    setRect(target, { left: 0, top: 0, width: 400, height: 800 });
    const { result } = renderPad();

    dispatch(target, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    act(() => {
      target.remove();
      expect(target.isConnected).toBe(false);
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
  });

  it('never starts for an observer or a read-only input surface', () => {
    const { result } = renderPad({ inputDisabled: true });
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(1_000);
    expect(result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();

    controller.isObserverReadOnly = true;
    cleanup();
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    setRect(container, { left: 0, top: 0, width: 400, height: 800 });
    containerRef.current = container;

    const readOnly = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(1_000);
    expect(readOnly.result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
  });

  it('stops immediately when the input lease is lost mid-gesture', () => {
    const { result, rerender } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 140, clientY: 300 }]));
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(1);

    rerender({ inputDisabled: true });

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
    advance(2_000);
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(1);
  });

  it('does not start outside the viewport or inside the shell edge band', () => {
    const { result } = renderPad({
      touchEdgeReservation: (_target, clientX) => clientX < 28,
    });

    dispatch(document.body, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(1_000);
    expect(result.current).toBeNull();

    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 10, clientY: 300 }]));
    advance(1_000);
    expect(result.current).toBeNull();
  });

  it('clamps the dial inside the viewport and reports the true finger origin', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 6, clientY: 4 }]));
    advance(380);

    expect(result.current).toMatchObject({
      phase: 'armed',
      originX: 6,
      originY: 4,
      anchorX: 102,
      anchorY: 102,
      showOrigin: true,
    });
  });

  it('pins the xterm scroll offset while armed and releases the lock on end', () => {    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    viewport.scrollTop = 40;
    container.appendChild(viewport);
    const { result } = renderPad();

    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    viewport.scrollTop = 120;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(viewport.scrollTop).toBe(40);

    dispatch(container, touchEvent('touchend', [], [{ identifier: 1, clientX: 100, clientY: 300 }]));
    expect(result.current).toBeNull();

    viewport.scrollTop = 120;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(viewport.scrollTop).toBe(120);
  });

  it('stands down when the browser has already committed the touch to scrolling', () => {
    const pending = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    dispatch(
      container,
      touchEvent('touchmove', [{ identifier: 1, clientX: 104, clientY: 300 }], undefined, { cancelable: false }),
    );
    advance(1_000);
    expect(pending.result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
    pending.unmount();

    const armed = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 2, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(armed.result.current).not.toBeNull();
    dispatch(
      container,
      touchEvent('touchmove', [{ identifier: 2, clientX: 140, clientY: 300 }], undefined, { cancelable: false }),
    );
    expect(armed.result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
  });

  it('suppresses the OS context menu only while the pad owns the touch', () => {
    const { result } = renderPad();
    const beforeOwnership = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      container.dispatchEvent(beforeOwnership);
    });
    expect(beforeOwnership.defaultPrevented).toBe(false);

    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    const owned = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      container.dispatchEvent(owned);
    });
    expect(owned.defaultPrevented).toBe(true);
  });

  it('cancels on window blur', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    expect(result.current).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
  });

  it('does not start over an active selection inside the terminal', () => {
    const line = document.createElement('span');
    line.textContent = 'selectable terminal line';
    container.appendChild(line);
    const selection = document.getSelection();
    selection?.selectAllChildren(line);

    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(1_000);

    expect(result.current).toBeNull();
    expect(controller.sendPhysKey).not.toHaveBeenCalled();
    selection?.removeAllRanges();
  });

  it('stops the clock when the input lease moves away mid-gesture', () => {
    const { result } = renderPad();
    dispatch(container, touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]));
    advance(380);
    // Far enough for the 8/s band, so the next repeat lands before the
    // liveness watchdog would notice the observer flag. This exercises the
    // arrow path's own lease check, not just the periodic guard.
    dispatch(container, touchEvent('touchmove', [{ identifier: 1, clientX: 300, clientY: 300 }]));
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(1);

    controller.isObserverReadOnly = true;
    advance(125);

    expect(result.current).toBeNull();
    expect(isTouchOwned(1)).toBe(false);
    expect(controller.sendPhysKey).toHaveBeenCalledTimes(1);
  });
});
