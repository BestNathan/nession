import { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimTouchOwnership } from '@/shared/lib/touchOwnership';
import type { ShellBounds } from '../../edgeBand';
import { useSwipePager } from '../../useSwipePager';

const SHELL: ShellBounds = { left: 0, right: 400 };

interface HarnessProps {
  index?: number;
  pageCount?: number;
  shellMayPage?: boolean;
  onIndexChange?: (index: number) => void;
}

/**
 * The hook binds native listeners to its own root. The surface and the chrome
 * are siblings so a test can choose which one owned the start: the work-surface
 * gate walks up from the dispatched target.
 */
function Harness({
  index = 1,
  pageCount = 3,
  shellMayPage = true,
  onIndexChange = vi.fn(),
}: HarnessProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pager = useSwipePager({
    pageCount,
    index,
    onIndexChange,
    getShellBounds: () => SHELL,
    shellMayPage,
    rootRef,
  });

  return (
    <div
      ref={rootRef}
      data-testid="pager-root"
      data-phase={pager.phase}
      data-reason={pager.lastReason ?? ''}
      data-destination={pager.destinationIndex ?? ''}
    >
      <div data-testid="chrome" style={{ height: 600 }} />
      <div data-testid="surface" data-terminal-viewport style={{ height: 600 }} />
      <output data-testid="offset">{pager.dragOffset}</output>
    </div>
  );
}

function point(clientX: number, clientY = 300, identifier = 1) {
  return { identifier, clientX, clientY };
}

interface TouchOptions {
  clientY?: number;
  identifier?: number;
  cancelable?: boolean;
}

function touchStart(target: HTMLElement, clientX: number, options: TouchOptions = {}) {
  const { clientY = 300, identifier = 1, cancelable = true } = options;
  fireEvent.touchStart(target, {
    touches: [point(clientX, clientY, identifier)],
    changedTouches: [point(clientX, clientY, identifier)],
    cancelable,
  });
}

function touchMove(target: HTMLElement, clientX: number, options: TouchOptions = {}) {
  const { clientY = 300, identifier = 1, cancelable = true } = options;
  fireEvent.touchMove(target, {
    touches: [point(clientX, clientY, identifier)],
    changedTouches: [point(clientX, clientY, identifier)],
    cancelable,
  });
}

function touchEnd(target: HTMLElement, clientX: number, options: TouchOptions = {}) {
  const { clientY = 300, identifier = 1 } = options;
  fireEvent.touchEnd(target, {
    touches: [],
    changedTouches: [point(clientX, clientY, identifier)],
  });
}

function touchCancel(target: HTMLElement, clientX: number, options: TouchOptions = {}) {
  const { clientY = 300, identifier = 1 } = options;
  fireEvent.touchCancel(target, {
    touches: [],
    changedTouches: [point(clientX, clientY, identifier)],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSwipePager — native touch continuity', () => {
  it('follows the finger and freezes the destination while held', () => {
    render(<Harness />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'candidate');

    touchMove(chrome, 260);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-destination', '0');
    expect(screen.getByTestId('offset')).toHaveTextContent('60');

    // Reversing past the origin clamps the preview but does not settle.
    touchMove(chrome, 150);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');

    touchEnd(chrome, 150);
  });

  it('commits only after the settle window, not on the release frame', async () => {
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 360);
    touchEnd(chrome, 360);

    // The preview is at rest over the destination, but the route has not
    // changed yet: release starts an animation.
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');
    expect(screen.getByTestId('offset')).toHaveTextContent('400');
    expect(onIndexChange).not.toHaveBeenCalled();

    await waitFor(() => expect(onIndexChange).toHaveBeenCalledWith(0));
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
  });

  it('snaps back below the threshold without changing the route', async () => {
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    // 30px: below the flick's 40px minimum, and below the distance threshold.
    touchMove(chrome, 230);
    touchEnd(chrome, 230);

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');
    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'below-threshold');
  });

  it('gives a vertical drag to the content for the rest of the contact', () => {
    render(<Harness />);
    const surface = screen.getByTestId('surface');

    touchStart(surface, 200, { clientY: 100 });
    // Interior of a work surface: never a candidate in the first place.
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    touchMove(surface, 240, { clientY: 400 });
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
  });

  it('surrenders a chrome candidate when the drag turns vertical', () => {
    render(<Harness />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200, { clientY: 100 });
    touchMove(chrome, 220, { clientY: 300 });

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'vertical');
  });
});

describe('useSwipePager — cancellation is one owned contact', () => {
  it('cancels on a genuine native touchcancel and records why', () => {
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 380);
    touchCancel(chrome, 380);

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'native-touchcancel');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('ignores touch-generated pointer cancellation', async () => {
    // Pointer Events are not an owner of a physical touch. A browser-generated
    // pointercancel or lostpointercapture must not end the held drag (#2724).
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 360);
    fireEvent(chrome, new Event('pointercancel', { bubbles: true }));
    fireEvent(chrome, new Event('lostpointercapture', { bubbles: true }));

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    touchEnd(chrome, 360);
    await waitFor(() => expect(onIndexChange).toHaveBeenCalledWith(0));
  });

  it('cancels on multitouch', () => {
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 300);
    fireEvent.touchStart(chrome, {
      touches: [point(200), point(240, 320, 2)],
      changedTouches: [point(240, 320, 2)],
    });

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'multitouch');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('stands down when another surface claims the finger', () => {
    render(<Harness />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 300);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');

    let release = () => {};
    act(() => {
      release = claimTouchOwnership(1, 'terminal-direction-pad');
    });

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute(
      'data-reason',
      'owned-by:terminal-direction-pad',
    );
    expect(screen.getByTestId('offset')).toHaveTextContent('0');

    act(() => release());
  });

  it('stands down when the browser already committed the touch to scrolling', () => {
    render(<Harness />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    // cancelable: false is what the browser reports once native scrolling owns
    // the contact; the shell cannot take those pixels back.
    touchMove(chrome, 300, { cancelable: false });

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'native-scroll');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
  });

  it('stands down when the layer loses its own leave authority', () => {
    const { rerender } = render(<Harness shellMayPage />);
    const chrome = screen.getByTestId('chrome');
    touchStart(chrome, 200);
    touchMove(chrome, 300);

    rerender(<Harness shellMayPage={false} />);

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'shell-standdown');
  });
});

describe('useSwipePager — reduced motion', () => {
  it('commits without a settle window when motion is reduced', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const onIndexChange = vi.fn();
    render(<Harness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 360);
    touchEnd(chrome, 360);

    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');
  });
});
