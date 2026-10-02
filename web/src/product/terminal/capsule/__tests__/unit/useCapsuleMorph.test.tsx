// @vitest-environment jsdom
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCapsuleMorph } from '@/product/terminal/capsule/useCapsuleMorph';
import { _resetLayoutFlipForTests } from '@/product/terminal/capsule/useCapsuleLayoutFlip';

const VISIBLE_A = new DOMRect(10, 10, 40, 40);
const VISIBLE_B = new DOMRect(100, 10, 40, 40);
const HIDDEN = new DOMRect(0, 0, 0, 0);

/**
 * The morph's two-surface stand-in: two elements sharing one morph id, of
 * which exactly one is visible at a time — the Terminal's capsule and the
 * Workspace's, or vice versa. Visibility is a mocked `getBoundingClientRect`,
 * which is also how the hook itself tells them apart.
 */
function Harness({ surface }: { surface: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useCapsuleMorph(surface, rootRef);
  return (
    <div ref={rootRef}>
      <div data-morph-id="capsule-shell" data-testid="a" />
      <div data-morph-id="capsule-shell" data-testid="b" />
    </div>
  );
}

function mockRects(el: HTMLElement, rect: () => DOMRect) {
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(rect);
}

describe('useCapsuleMorph (#1347 SC-08)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
    );
  });

  afterEach(() => {
    _resetLayoutFlipForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('slides the newly visible element in from the place its reciprocal left', () => {
    const view = render(<Harness surface="terminal" />);
    const a = view.getByTestId('a');
    const b = view.getByTestId('b');
    mockRects(a, () => VISIBLE_A);
    mockRects(b, () => HIDDEN);

    // Let the tracking pass record "a at 10,10" as the resting layout.
    view.rerender(<Harness surface="terminal" />);

    // The switch: a goes hidden, b appears at 100,10.
    mockRects(a, () => HIDDEN);
    mockRects(b, () => VISIBLE_B);
    view.rerender(<Harness surface="workspace" />);

    // runLayoutFlip played on b (transition armed; transform already inverted
    // and released by the synchronous rAF) and left the hidden a alone.
    expect(b.style.transition).toContain('transform');
    expect(a.style.transition).toBe('');
  });

  it('animates the return switch too — the first morph must not poison tracking', () => {
    // Regression: the tracking pass used to run after runLayoutFlip applied
    // its invert transforms, so it stored the animation's *start* as the
    // resting place. The next switch then computed a zero delta and silently
    // did nothing (measured live on the workspace→terminal trip).
    const view = render(<Harness surface="terminal" />);
    const a = view.getByTestId('a');
    const b = view.getByTestId('b');
    mockRects(a, () => VISIBLE_A);
    mockRects(b, () => HIDDEN);
    view.rerender(<Harness surface="terminal" />);

    // There: a hides, b appears and animates in from a's place.
    mockRects(a, () => HIDDEN);
    mockRects(b, () => VISIBLE_B);
    view.rerender(<Harness surface="workspace" />);
    expect(b.style.transition).toContain('transform');

    // …and back again: b's animated-from rect must not have become its
    // recorded resting place, or this leg computes dx=0 and stays still.
    b.style.transition = '';
    mockRects(a, () => VISIBLE_A);
    mockRects(b, () => HIDDEN);
    view.rerender(<Harness surface="terminal" />);
    expect(a.style.transition).toContain('transform');
  });

  it('does nothing while the surface does not change', () => {
    const view = render(<Harness surface="terminal" />);
    const a = view.getByTestId('a');
    mockRects(a, () => VISIBLE_A);

    view.rerender(<Harness surface="terminal" />);

    expect(a.style.transition).toBe('');
  });

  it('defers to prefers-reduced-motion: the switch is instant', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const view = render(<Harness surface="terminal" />);
    const a = view.getByTestId('a');
    const b = view.getByTestId('b');
    mockRects(a, () => VISIBLE_A);
    mockRects(b, () => HIDDEN);
    view.rerender(<Harness surface="terminal" />);

    mockRects(a, () => HIDDEN);
    mockRects(b, () => VISIBLE_B);
    view.rerender(<Harness surface="workspace" />);

    expect(b.style.transition).toBe('');
  });
});
