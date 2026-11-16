import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppKeyboardAvoidanceScrollport } from '@/app/experiences/app/AppKeyboardAvoidanceScrollport';
import {
  computeAppViewportSnapshot,
  publishAppViewportSnapshot,
} from '@/platform/viewport/appViewport';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout, so each element states the box the browser would have
 * measured. The scrollport's own scroll metrics are derived from the ephemeral
 * extent, exactly like a real scroll container's.
 */
function stubBox(element: HTMLElement, box: DOMRect): void {
  element.getBoundingClientRect = () => box;
}

function mountScrollport({ active = true }: { active?: boolean } = {}) {
  function Harness() {
    return (
      <div data-app-viewport-environment="" data-testid="env">
        <AppKeyboardAvoidanceScrollport active={active}>
          <div data-terminal-viewport data-testid="terminal-viewport">
            <textarea data-testid="target" />
          </div>
        </AppKeyboardAvoidanceScrollport>
      </div>
    );
  }
  const view = render(<Harness />);
  const env = screen.getByTestId('env');
  const scrollport = screen.getByTestId('app-keyboard-avoidance-scrollport');
  const content = screen.getByTestId('app-keyboard-avoidance-content');
  const extent = screen.getByTestId('app-keyboard-avoidance-extent');
  const target = screen.getByTestId('target') as HTMLTextAreaElement;
  const terminalViewport = screen.getByTestId('terminal-viewport');
  stubBox(env, rect(0, 0, 390, 844));
  stubBox(scrollport, rect(0, 56, 390, 788));
  stubBox(content, rect(0, 56, 390, 788));
  stubBox(terminalViewport, rect(0, 56, 390, 788));
  stubBox(target, rect(0, 700, 340, 40));
  Object.defineProperty(scrollport, 'clientHeight', { configurable: true, get: () => 788 });
  Object.defineProperty(scrollport, 'scrollHeight', {
    configurable: true,
    get: () => 788 + (Number.parseFloat(extent.style.height) || 0),
  });
  return { ...view, env, scrollport, extent, target, terminalViewport };
}

function publishKeyboard(env: HTMLElement, height = 544, editableFocus = true): void {
  publishAppViewportSnapshot(env, computeAppViewportSnapshot({
    layoutBounds: { left: 0, top: 0, width: 390, height: 844 },
    visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height, scale: 1 },
    editableFocus,
    revision: 1,
  }));
}

function touchEvent(
  type: 'touchstart' | 'touchmove',
  point: { x: number; y: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: [{ clientX: point.x, clientY: point.y, identifier: 7 }],
  });
  return event;
}

describe('AppKeyboardAvoidanceScrollport', () => {
  it('reveals the focused composer with a real bounded outer scroll and no geometry writes', async () => {
    const { env, scrollport, extent, target, terminalViewport } = mountScrollport();
    publishKeyboard(env);
    target.focus();
    await waitFor(() => {
      expect(extent.style.height).toBe('212px');
    });
    expect(scrollport.getAttribute('data-keyboard-avoidance-scrollable')).toBe('true');
    expect(scrollport.style.overflowY).toBe('auto');
    expect(scrollport.scrollTop).toBe(212);
    expect(scrollport.dataset.keyboardAvoidanceExtent).toBe('212');
    expect(scrollport.dataset.keyboardAvoidanceScrollTop).toBe('212');
    expect(terminalViewport.style.height, 'the work surface is scaled, not resized').toBe('');
  });

  it('only scrolls enough for the control plus the touch-safe margin', async () => {
    const { env, scrollport, extent, target } = mountScrollport();
    // The control is already above the visible bottom (keyboard is short).
    target.getBoundingClientRect = () => rect(0, 420, 340, 40);
    publishKeyboard(env, 600);
    target.focus();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(extent.style.height).toBe('0px');
    expect(scrollport.hasAttribute('data-keyboard-avoidance-scrollable')).toBe(false);
    expect(scrollport.style.overflowY).toBe('hidden');
  });

  it('releases the range on blur and clamps the scroll position', async () => {
    const { env, scrollport, extent, target } = mountScrollport();
    publishKeyboard(env);
    target.focus();
    await waitFor(() => { expect(scrollport.style.overflowY).toBe('auto'); });
    target.blur();
    await waitFor(() => {
      expect(extent.style.height).toBe('0px');
    });
    expect(scrollport.hasAttribute('data-keyboard-avoidance-scrollable')).toBe(false);
    expect(scrollport.scrollTop).toBe(0);
  });

  it('does not create an avoidance range when the viewport shrink has no editable focus', async () => {
    const { env, scrollport, extent } = mountScrollport();
    publishKeyboard(env, 544, false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(extent.style.height).toBe('0px');
    expect(scrollport.hasAttribute('data-keyboard-avoidance-scrollable')).toBe(false);
  });

  it('gives vertical terminal drags to the outer owner while a range exists', async () => {
    const { env, scrollport, target, terminalViewport } = mountScrollport();
    publishKeyboard(env);
    target.focus();
    await waitFor(() => { expect(scrollport.scrollTop).toBe(212); });

    const start = touchEvent('touchstart', { x: 200, y: 300 });
    terminalViewport.dispatchEvent(start);
    const first = touchEvent('touchmove', { x: 200, y: 360 });
    terminalViewport.dispatchEvent(first);
    expect(first.defaultPrevented, 'the outer owner pre-empts xterm').toBe(true);
    expect(scrollport.scrollTop).toBe(152);

    const second = touchEvent('touchmove', { x: 200, y: 420 });
    terminalViewport.dispatchEvent(second);
    expect(scrollport.scrollTop).toBe(92);

    // A drag toward a direction with no remaining outer range stays with the
    // terminal for the rest of that contact.
    scrollport.scrollTop = 212;
    terminalViewport.dispatchEvent(touchEvent('touchstart', { x: 200, y: 500 }));
    const up = touchEvent('touchmove', { x: 200, y: 440 });
    terminalViewport.dispatchEvent(up);
    expect(up.defaultPrevented, 'exhausted outer range is not claimed').toBe(false);
    expect(scrollport.scrollTop).toBe(212);
  });

  it('does not claim a horizontal gesture or a tap', async () => {
    const { env, scrollport, target, terminalViewport } = mountScrollport();
    publishKeyboard(env);
    target.focus();
    await waitFor(() => { expect(scrollport.scrollTop).toBe(212); });

    terminalViewport.dispatchEvent(touchEvent('touchstart', { x: 200, y: 300 }));
    const horizontal = touchEvent('touchmove', { x: 260, y: 302 });
    terminalViewport.dispatchEvent(horizontal);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop, 'the pager keeps its gesture').toBe(212);

    terminalViewport.dispatchEvent(touchEvent('touchstart', { x: 200, y: 300 }));
    expect(scrollport.scrollTop).toBe(212);
  });

  it('releases and blurs a focused control when the layer becomes inactive', async () => {
    function Harness({ active }: { active: boolean }) {
      return (
        <div data-app-viewport-environment="">
          <AppKeyboardAvoidanceScrollport active={active}>
            <div data-terminal-viewport>
              <textarea data-testid="target" />
            </div>
          </AppKeyboardAvoidanceScrollport>
        </div>
      );
    }
    const view = render(<Harness active />);
    const scrollport = screen.getByTestId('app-keyboard-avoidance-scrollport');
    const target = screen.getByTestId('target') as HTMLTextAreaElement;
    publishKeyboard(view.container.firstElementChild as HTMLElement);
    target.focus();
    expect(document.activeElement).toBe(target);
    view.rerender(<Harness active={false} />);
    expect(document.activeElement, 'a hidden layer must not own the keyboard').not.toBe(target);
    expect(scrollport.hasAttribute('data-keyboard-avoidance-scrollable')).toBe(false);
  });
});
