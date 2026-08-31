// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prefersReducedMotion,
  runLayoutFlip,
} from '@/session-first/capsule/useCapsuleLayoutFlip';

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when matchMedia matches reduce', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when matchMedia does not match', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('runLayoutFlip', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('applies invert transform then clears it on play', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const first = new DOMRect(10, 10, 40, 40);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValueOnce(
      new DOMRect(50, 80, 40, 40) as DOMRect,
    );

    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    runLayoutFlip([{ el, first }], { durationMs: 0 });

    expect(el.style.transform).toBe('');
    raf.mockRestore();
    el.remove();
  });

  it('skips transform when reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const el = document.createElement('button');
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'getBoundingClientRect');
    runLayoutFlip([{ el, first: new DOMRect(0, 0, 10, 10) }], { durationMs: 200 });
    expect(spy).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');
    el.remove();
  });
});
