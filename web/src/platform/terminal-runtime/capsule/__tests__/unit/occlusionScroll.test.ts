import { describe, it, expect, vi } from 'vitest';
import {
  CapsuleOcclusionScroll,
  isFollowingMarginBottom,
  marginLinesFromOcclusion,
  targetViewportY,
  type CapsuleScrollTerminalPort,
} from '@/platform/terminal-runtime/capsule/occlusionScroll';
import type { TerminalMouseTrackingMode } from '@/platform/terminal-runtime/emulator';

describe('occlusionScroll helpers', () => {
  it('converts occlusion px to whole-line margin', () => {
    expect(marginLinesFromOcclusion(0, 16)).toBe(0);
    expect(marginLinesFromOcclusion(48, 16)).toBe(3);
    expect(marginLinesFromOcclusion(49, 16)).toBe(4);
  });

  it('computes target viewport Y with margin', () => {
    expect(targetViewportY(40, 24, 0)).toBe(16);
    expect(targetViewportY(40, 24, 3)).toBe(13);
    expect(targetViewportY(10, 24, 3)).toBe(0);
  });

  it('detects follow-bottom vs history scroll', () => {
    const rows = 24;
    const length = 40;
    const margin = 3;
    const target = targetViewportY(length, rows, margin);

    expect(isFollowingMarginBottom(target, length, rows, margin)).toBe(true);
    expect(isFollowingMarginBottom(target - 1, length, rows, margin)).toBe(false);
    expect(isFollowingMarginBottom(16, 40, 24, 0)).toBe(true);
    expect(isFollowingMarginBottom(15, 40, 24, 0)).toBe(false);
  });

  /** The emulator port the occlusion needs (#2581), over a live buffer. */
  function makePort(options: {
    type?: 'normal' | 'alternate';
    viewportY?: number;
    length?: number;
    mouseTrackingMode?: TerminalMouseTrackingMode;
  } = {}): { port: CapsuleScrollTerminalPort; buffer: { viewportY: number } } {
    const buffer = {
      type: options.type ?? 'normal',
      viewportY: options.viewportY ?? 16,
      length: options.length ?? 40,
    };
    const port: CapsuleScrollTerminalPort = {
      element: null,
      rows: 24,
      readBuffer: () => ({ ...buffer, cursorX: 0, cursorY: 0 }),
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
      scrollPages: vi.fn((pages: number) => {
        buffer.viewportY = Math.max(0, buffer.viewportY + pages * 24);
      }),
    };
    return { port, buffer };
  }

  function makeHost(): { host: HTMLElement; styleValues: Map<string, string> } {
    const styleValues = new Map<string, string>();
    const host = {
      style: {
        getPropertyValue: (name: string) => styleValues.get(name) ?? '48px',
        setProperty: (name: string, value: string) => styleValues.set(name, value),
      },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;
    return { host, styleValues };
  }

  it('returns to the real xterm bottom when layout already reserves capsule space', () => {
    const { port } = makePort();
    const { host } = makeHost();

    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    occlusion.scrollToMarginBottom();

    expect(port.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(port.scrollLines).not.toHaveBeenCalled();
  });

  it('switches the local terminal between following and history layout modes', () => {
    const { port } = makePort();
    const { host, styleValues } = makeHost();

    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);

    expect(occlusion.mode()).toBe('following');
    occlusion.enterHistory();
    expect(occlusion.mode()).toBe('history');
    expect(styleValues.get('--nession-local-terminal-content-bottom-inset')).toBe('0px');
    expect(host.dataset.terminalScrollMode).toBe('history');

    occlusion.scrollToMarginBottom();
    expect(occlusion.mode()).toBe('following');
    expect(styleValues.get('--nession-local-terminal-content-bottom-inset'))
      .toBe('var(--nession-local-terminal-capsule-occlusion, 0px)');
    expect(host.dataset.terminalScrollMode).toBe('following');
  });

  it('handles vertical wheel input with xterm local scrollback', () => {
    const { port } = makePort({ viewportY: 16, length: 40 });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    occlusion.handleWheel(event);

    expect(port.scrollLines).toHaveBeenCalledWith(-2);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(occlusion.mode()).toBe('history');
  });

  it('does not swallow wheel input when the active buffer has no local scrollback', () => {
    const { port } = makePort({ type: 'alternate', viewportY: 0, length: 24 });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    expect(occlusion.handleWheel(event)).toBe(true);
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('leaves the wheel to an application that enabled mouse tracking (#1096)', () => {
    // htop, `less`, vim with `set mouse=a` and Claude Code read the wheel
    // themselves. Taking it for local history silently breaks them — and the
    // buffer type cannot say whether they asked for mouse input, which is why
    // this came from the terminal mode rather than from the proxy.
    const { port } = makePort({ viewportY: 16, length: 40, mouseTrackingMode: 'vt200' });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    // `true` is "not handled" — the event continues to xterm, which reports it
    // to the application.
    expect(occlusion.handleWheel(event)).toBe(true);
    expect(port.scrollLines).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('still takes the wheel when a normal-buffer app has not asked for the mouse (#1096)', () => {
    // The same buffer shape as the test above, only the mouse mode differs —
    // which is the whole point: buffer type alone would treat these two
    // identically.
    const { port } = makePort({ viewportY: 16, length: 40, mouseTrackingMode: 'none' });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    expect(occlusion.handleWheel(event)).toBe(false);
    expect(port.scrollLines).toHaveBeenCalled();
  });

  it('routes page scrolling through the same local history state machine', () => {
    const { port } = makePort({ viewportY: 16, length: 40 });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);

    occlusion.scrollPages(-1);

    expect(port.scrollPages).toHaveBeenCalledWith(-1);
    expect(occlusion.mode()).toBe('history');
  });

  it('does not snapshot history as a live-following output stream', () => {
    const { port } = makePort({ viewportY: 16, length: 40 });
    const { host } = makeHost();
    const occlusion = new CapsuleOcclusionScroll(port, host, () => 16);
    occlusion.enterHistory();

    expect(occlusion.snapshotFollowing()).toBe(false);
  });
});
