// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XtermEmulator } from '../../XtermEmulator';
import type { TerminalLinkMatcher } from '../../../emulator';

// Mock matchMedia for xterm.js in jsdom environment
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

describe('XtermEmulator', () => {
  let instance: XtermEmulator;

  beforeEach(() => {
    instance = new XtermEmulator({
      rendererType: 'canvas',
      fontSize: 14,
      scrollback: 1000,
    });
  });

  afterEach(() => {
    instance.dispose();
  });

  it('should create terminal with options', () => {
    expect(instance.terminal).toBeDefined();
    expect(instance.fontSizeManager).toBeDefined();
  });

  it('should have correct initial state', () => {
    expect(instance.terminal.rows).toBeGreaterThan(0);
    expect(instance.terminal.cols).toBeGreaterThan(0);
  });

  it('should preserve scrollback after attach/detach cycle', () => {
    // Create two containers
    const container1 = document.createElement('div');
    const container2 = document.createElement('div');
    document.body.appendChild(container1);
    document.body.appendChild(container2);

    // Attach to first container and write some content
    instance.mount(container1);

    // Write content - use writeSync for synchronous buffer update
    instance.terminal.write('line 1\r\n');
    instance.terminal.write('line 2\r\n');
    instance.terminal.write('line 3\r\n');

    // Get initial buffer state
    const initialBufferLength = instance.terminal.buffer.active.length;
    expect(initialBufferLength).toBeGreaterThan(0);

    // Detach
    instance.unmount();

    // Attach to second container
    instance.mount(container2);

    // Reattach must put the existing xterm DOM back into the new viewport.
    expect(instance.terminal.element?.parentElement).toBe(container2);

    // Verify scrollback is preserved - buffer should still have content
    const bufferAfterReattach = instance.terminal.buffer.active;
    expect(bufferAfterReattach.length).toBe(initialBufferLength);

    // Verify the terminal instance is the same (scrollback preserved)
    expect(instance.terminal).toBeDefined();
    expect(instance.terminal.buffer.active.length).toBeGreaterThan(0);

    // Cleanup
    document.body.removeChild(container1);
    document.body.removeChild(container2);
  });

  // #2879 SC-02: the host's debug/E2E reference is an ownership claim, not a
  // convenience assignment. Detach/reparent/dispose must release it, and must
  // never delete a reference that already names a newer Terminal.
  describe('host debug reference ownership', () => {
    type MountHost = HTMLElement & { xtermInstance?: unknown };

    function mountHost(): MountHost {
      const host = document.createElement('div');
      document.body.appendChild(host);
      return host;
    }

    afterEach(() => {
      for (const host of document.querySelectorAll('div')) {
        host.remove();
      }
    });

    it('sets and clears the reference on the mounted host by identity', () => {
      const host = mountHost();
      instance.mount(host);
      expect((host as MountHost).xtermInstance).toBe(instance.terminal);

      instance.unmount();
      expect((host as MountHost).xtermInstance).toBeUndefined();
      expect(instance.terminal.element?.parentElement).toBeNull();
    });

    it('clears the previous host when the terminal is reparented', () => {
      const first = mountHost();
      const second = mountHost();
      instance.mount(first);
      instance.mount(second);

      expect((first as MountHost).xtermInstance).toBeUndefined();
      expect((second as MountHost).xtermInstance).toBe(instance.terminal);
      expect(instance.terminal.element?.parentElement).toBe(second);
    });

    it('does not delete a reference that now names a newer Terminal', () => {
      const host = mountHost();
      instance.mount(host);
      const newer = { terminal: 'newer' };
      (host as MountHost).xtermInstance = newer;

      instance.unmount();

      expect((host as MountHost).xtermInstance).toBe(newer);
    });

    it('clears the reference on disposal', () => {
      const host = mountHost();
      instance.mount(host);
      expect((host as MountHost).xtermInstance).toBe(instance.terminal);

      instance.dispose();

      expect((host as MountHost).xtermInstance).toBeUndefined();
      expect(instance.isDisposed).toBe(true);
    });

    it('clears a reference left on a detached host when disposed without unmount', () => {
      const host = mountHost();
      instance.mount(host);
      // Simulate an owner that disposed without a preceding detach; the
      // element's parent is still how disposal finds the host.
      instance.dispose();

      expect((host as MountHost).xtermInstance).toBeUndefined();
    });
  });

  // #3187: xterm's linkifier only listens to mouse events, so a touch tap has
  // to reach the Product matcher through the engine's own tap handler.
  describe('touch link activation', () => {
    interface Point {
      identifier: number;
      clientX: number;
      clientY: number;
    }

    function touchEvent(type: string, touches: Point[], changed: Point[]): Event {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      Object.defineProperty(event, 'changedTouches', { value: changed });
      return event;
    }

    function mountForTouch(): HTMLElement {
      const host = document.createElement('div');
      document.body.appendChild(host);
      instance.mount(host);
      return host;
    }

    function stubPoint(x: number, y: number): void {
      (instance.terminal as unknown as {
        _core: { _mouseService: { getCoords: () => [number, number] } };
      })._core._mouseService.getCoords = () => [x, y];
    }

    function matcherFor(needle: string, activate: () => void): TerminalLinkMatcher {
      return (line) => {
        const start = line.text.indexOf(needle);
        return start < 0
          ? []
          : [{ startIndex: start, endIndex: start + needle.length, activate }];
      };
    }

    async function writeLine(text: string): Promise<void> {
      await new Promise<void>((resolve) => instance.terminal.write(text, () => resolve()));
    }

    afterEach(() => {
      for (const host of document.querySelectorAll('div')) {
        host.remove();
      }
    });

    it('activates the matcher link under a short, stationary tap', async () => {
      mountForTouch();
      await writeLine('  src/foo.rs:12');
      stubPoint(3, 1);
      const activate = vi.fn();
      const registration = instance.registerLinkMatcher(matcherFor('src/foo.rs', activate));
      const element = instance.terminal.element as HTMLElement;
      const touch = { identifier: 1, clientX: 0, clientY: 0 };

      element.dispatchEvent(touchEvent('touchstart', [touch], []));
      element.dispatchEvent(touchEvent('touchend', [], [touch]));

      expect(activate).toHaveBeenCalledTimes(1);
      registration.dispose();
    });

    it('does not activate when the finger moved beyond the tap slop', async () => {
      mountForTouch();
      await writeLine('  src/foo.rs:12');
      stubPoint(3, 1);
      const activate = vi.fn();
      const registration = instance.registerLinkMatcher(matcherFor('src/foo.rs', activate));
      const element = instance.terminal.element as HTMLElement;
      const touch = { identifier: 1, clientX: 0, clientY: 0 };

      element.dispatchEvent(touchEvent('touchstart', [touch], []));
      element.dispatchEvent(touchEvent('touchmove', [
        { identifier: 1, clientX: 30, clientY: 0 },
      ], []));
      element.dispatchEvent(touchEvent('touchend', [], [touch]));

      expect(activate).not.toHaveBeenCalled();
      registration.dispose();
    });

    it('does not activate a tap on empty cells', async () => {
      mountForTouch();
      await writeLine('a');
      stubPoint(20, 1);
      const activate = vi.fn();
      const registration = instance.registerLinkMatcher(matcherFor('a', activate));
      const element = instance.terminal.element as HTMLElement;
      const touch = { identifier: 1, clientX: 0, clientY: 0 };

      element.dispatchEvent(touchEvent('touchstart', [touch], []));
      element.dispatchEvent(touchEvent('touchend', [], [touch]));

      expect(activate).not.toHaveBeenCalled();
      registration.dispose();
    });
  });
});
