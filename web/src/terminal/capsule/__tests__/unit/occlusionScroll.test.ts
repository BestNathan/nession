import { describe, it, expect, vi } from 'vitest';
import {
  CapsuleOcclusionScroll,
  isFollowingMarginBottom,
  marginLinesFromOcclusion,
  targetViewportY,
} from '@/terminal/capsule/occlusionScroll';

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

  it('returns to the real xterm bottom when layout already reserves capsule space', () => {
    const terminal = {
      buffer: { active: { viewportY: 16, length: 40 } },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: {
        getPropertyValue: () => '48px',
        setProperty: vi.fn(),
      },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;

    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);
    occlusion.scrollToMarginBottom();

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(terminal.scrollLines).not.toHaveBeenCalled();
  });

  it('switches the local terminal between following and history layout modes', () => {
    const styleValues = new Map<string, string>();
    const terminal = {
      buffer: { active: { viewportY: 16, length: 40 } },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: {
        getPropertyValue: (name: string) => styleValues.get(name) ?? '48px',
        setProperty: (name: string, value: string) => styleValues.set(name, value),
      },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;

    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);

    expect(occlusion.mode()).toBe('following');
    occlusion.enterHistory();
    expect(occlusion.mode()).toBe('history');
    expect(styleValues.get('--terminal-content-bottom-inset')).toBe('0px');
    expect(host.dataset.terminalScrollMode).toBe('history');

    occlusion.scrollToMarginBottom();
    expect(occlusion.mode()).toBe('following');
    expect(styleValues.get('--terminal-content-bottom-inset'))
      .toBe('var(--terminal-capsule-occlusion, 0px)');
    expect(host.dataset.terminalScrollMode).toBe('following');
  });

  it('handles vertical wheel input with xterm local scrollback', () => {
    const activeBuffer = { type: 'normal' as const, viewportY: 16, length: 40 };
    const terminal = {
      buffer: { active: activeBuffer },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn((lines: number) => {
        activeBuffer.viewportY = Math.max(0, activeBuffer.viewportY + lines);
      }),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: { setProperty: vi.fn(), getPropertyValue: () => '48px' },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;
    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    occlusion.handleWheel(event);

    expect(terminal.scrollLines).toHaveBeenCalledWith(-2);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(occlusion.mode()).toBe('history');
  });

  it('does not swallow wheel input when the active buffer has no local scrollback', () => {
    const terminal = {
      buffer: { active: { type: 'alternate', viewportY: 0, length: 24 } },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: { setProperty: vi.fn(), getPropertyValue: () => '48px' },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;
    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);
    const event = {
      deltaY: -32,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as WheelEvent;

    expect(occlusion.handleWheel(event)).toBe(true);
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('routes page scrolling through the same local history state machine', () => {
    const activeBuffer = { viewportY: 16, length: 40 };
    const terminal = {
      buffer: { active: activeBuffer },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
      scrollPages: vi.fn((pages: number) => {
        activeBuffer.viewportY = Math.max(0, activeBuffer.viewportY + pages * 24);
      }),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: { setProperty: vi.fn(), getPropertyValue: () => '48px' },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;
    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);

    occlusion.scrollPages(-1);

    expect(terminal.scrollPages).toHaveBeenCalledWith(-1);
    expect(occlusion.mode()).toBe('history');
  });

  it('does not snapshot history as a live-following output stream', () => {
    const terminal = {
      buffer: { active: { viewportY: 16, length: 40 } },
      rows: 24,
      scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
    } as unknown as import('@xterm/xterm').Terminal;
    const host = {
      style: { setProperty: vi.fn(), getPropertyValue: () => '48px' },
      dataset: {} as DOMStringMap,
    } as unknown as HTMLElement;
    const occlusion = new CapsuleOcclusionScroll(terminal, host, () => 16);
    occlusion.enterHistory();

    expect(occlusion.snapshotFollowing()).toBe(false);
  });
});
