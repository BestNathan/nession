import { useMemo, useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimTouchOwnership } from '@/shared/lib/touchOwnership';
import type { WorkspaceStackReport } from '@/app/workspace/workspaceContext';
import type { ShellBounds } from '../../edgeBand';
import { useSwipePager } from '../../useSwipePager';

const SHELL: ShellBounds = { left: 0, right: 400 };

interface HarnessProps {
  index?: number;
  pageCount?: number;
  shellMayPage?: boolean;
  onIndexChange?: (index: number) => void;
  innerStack?: WorkspaceStackReport | null;
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
  innerStack = null,
}: HarnessProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pager = useSwipePager({
    pageCount,
    index,
    onIndexChange,
    getShellBounds: () => SHELL,
    shellMayPage,
    innerStack,
    rootRef,
  });

  return (
    <div
      ref={rootRef}
      data-testid="pager-root"
      data-phase={pager.phase}
      data-reason={pager.lastReason ?? ''}
      data-destination={pager.destinationIndex ?? ''}
      data-inner={pager.innerAction ?? ''}
      data-destination-label={pager.destinationLabel ?? ''}
    >
      <div data-testid="chrome" style={{ height: 600 }}>
        <button type="button" data-testid="action">
          Action
        </button>
      </div>
      <div data-testid="surface" data-terminal-viewport style={{ height: 600 }} />
      <output data-testid="offset">{pager.dragOffset}</output>
      <output data-testid="inner-offset">{pager.innerOffset}</output>
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

describe('useSwipePager — Workspace inner stack (#3971)', () => {
  function inner(
    pop: (() => void) | null,
    forward: (() => void) | null,
  ): WorkspaceStackReport {
    return {
      pop: pop === null ? null : { title: 'Transcripts', onActivate: pop },
      forward: forward === null ? null : { title: 'Record', onActivate: forward },
    };
  }

  it('pops one capability depth even while the outer pager is standing down', async () => {
    const onPop = vi.fn();
    const onIndexChange = vi.fn();
    render(
      <Harness
        index={2}
        shellMayPage={false}
        innerStack={inner(onPop, null)}
        onIndexChange={onIndexChange}
      />,
    );
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 100);
    touchMove(chrome, 180);

    // The same single coordinator owns the contact; it resolved to the inner
    // stack, so the outer layer does not move and the destination is named.
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-inner', 'pop');
    expect(screen.getByTestId('pager-root')).toHaveAttribute(
      'data-destination-label',
      'Transcripts',
    );
    expect(screen.getByTestId('inner-offset')).toHaveTextContent('80');
    expect(screen.getByTestId('offset')).toHaveTextContent('0');

    touchEnd(chrome, 180);
    expect(onPop).toHaveBeenCalledTimes(1);
    expect(onIndexChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
  });

  it('snaps back below the threshold without leaving the depth', async () => {
    const onPop = vi.fn();
    render(<Harness index={2} shellMayPage={false} innerStack={inner(onPop, null)} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 100);
    touchMove(chrome, 130);
    touchEnd(chrome, 130);

    expect(onPop).not.toHaveBeenCalled();
    // The rejected contact still belongs to the Workspace frame: the settle
    // must keep the inner owner instead of falling through to the outer page
    // snapback, which would remove the transform immediately (#4185).
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-inner', 'pop');

    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
    expect(screen.getByTestId('inner-offset')).toHaveTextContent('0');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-inner', '');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'below-threshold');
  });

  it('resists a leftward drag when no forward destination was recorded', async () => {
    const onPop = vi.fn();
    const onIndexChange = vi.fn();
    render(
      <Harness
        index={2}
        shellMayPage={false}
        innerStack={inner(onPop, null)}
        onIndexChange={onIndexChange}
      />,
    );
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 120);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'resisting');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-reason', 'no-destination');

    touchEnd(chrome, 120);
    expect(onPop).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('moves forward only to the destination the capability recorded', async () => {
    const onPop = vi.fn();
    const onForward = vi.fn();
    const onIndexChange = vi.fn();
    render(
      <Harness
        index={2}
        shellMayPage={false}
        innerStack={inner(onPop, onForward)}
        onIndexChange={onIndexChange}
      />,
    );
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 300);
    touchMove(chrome, 220);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-inner', 'forward');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-destination-label', 'Record');

    touchEnd(chrome, 220);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onPop).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('leaves an interactive owner its contact even with an inner destination', () => {
    const onPop = vi.fn();
    render(<Harness index={2} shellMayPage={false} innerStack={inner(onPop, null)} />);
    const action = screen.getByTestId('action');

    touchStart(action, 100);
    touchMove(action, 180);
    touchEnd(action, 180);

    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle');
    expect(onPop).not.toHaveBeenCalled();
  });
});

describe('useSwipePager — a settle is caught up, not blocked (#4185)', () => {
  it('lets a contact that arrives during an inner snapback settle start immediately', async () => {
    const onPop = vi.fn();
    render(
      <Harness
        index={2}
        shellMayPage={false}
        innerStack={{ pop: { title: 'Transcripts', onActivate: onPop }, forward: null }}
      />,
    );
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 100);
    touchMove(chrome, 130);
    touchEnd(chrome, 130);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');

    touchStart(chrome, 100);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'candidate');
    touchMove(chrome, 180);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-inner', 'pop');
    touchEnd(chrome, 180);

    expect(onPop).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
  });

  function StatefulHarness({
    onIndexChange = vi.fn(),
  }: {
    onIndexChange?: (index: number) => void;
  }) {
    const [index, setIndex] = useState(1);
    const rootRef = useRef<HTMLDivElement>(null);
    const pager = useSwipePager({
      pageCount: 3,
      index,
      onIndexChange: (next) => {
        onIndexChange(next);
        setIndex(next);
      },
      getShellBounds: () => SHELL,
      shellMayPage: true,
      innerStack: null,
      rootRef,
    });

    return (
      <div
        ref={rootRef}
        data-testid="pager-root"
        data-phase={pager.phase}
        data-destination={pager.destinationIndex ?? ''}
      >
        <div data-testid="chrome" style={{ height: 600 }} />
      </div>
    );
  }

  it('finalizes a pending page commit when the next contact arrives', async () => {
    const onIndexChange = vi.fn();
    render(<StatefulHarness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    touchStart(chrome, 200);
    touchMove(chrome, 360);
    touchEnd(chrome, 360);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');
    expect(onIndexChange).not.toHaveBeenCalled();

    // Catch up: the commit the user can already see becomes real, and the new
    // contact is a candidate — not ignored for the rest of the animation.
    touchStart(chrome, 200);
    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'candidate');

    // The caught-up route change belongs to this contact, so it must not stand
    // the contact down. From Sessions the reverse direction is the Terminal.
    touchMove(chrome, 120);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-destination', '1');

    touchEnd(chrome, 120);
    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  function LayerAwareHarness({
    onIndexChange = vi.fn(),
  }: {
    onIndexChange?: (index: number) => void;
  }) {
    const [index, setIndex] = useState(2);
    const rootRef = useRef<HTMLDivElement>(null);
    // The Workspace root reports an empty stack, exactly as AppLayers does; a
    // commit to Terminal replaces it with null in the same render.
    const innerStack = useMemo<WorkspaceStackReport | null>(
      () => (index === 2 ? { pop: null, forward: null } : null),
      [index],
    );
    const pager = useSwipePager({
      pageCount: 3,
      index,
      onIndexChange: (next) => {
        onIndexChange(next);
        setIndex(next);
      },
      getShellBounds: () => SHELL,
      shellMayPage: true,
      innerStack,
      rootRef,
    });

    return (
      <div
        ref={rootRef}
        data-testid="pager-root"
        data-phase={pager.phase}
        data-destination={pager.destinationIndex ?? ''}
        data-inner={pager.innerAction ?? ''}
      >
        <div data-testid="chrome" style={{ height: 600 }} />
      </div>
    );
  }

  it('keeps a caught-up contact when the commit also replaces the inner stack', async () => {
    const onIndexChange = vi.fn();
    render(<LayerAwareHarness onIndexChange={onIndexChange} />);
    const chrome = screen.getByTestId('chrome');

    // Workspace root -> Terminal is an outer page commit.
    touchStart(chrome, 200);
    touchMove(chrome, 360);
    touchEnd(chrome, 360);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'settling');
    expect(onIndexChange).not.toHaveBeenCalled();

    // Catching it up both changes the route and unmounts the Workspace stack.
    touchStart(chrome, 200);
    expect(onIndexChange).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'candidate');

    // That authority change must not be mistaken for an external handoff.
    touchMove(chrome, 230);
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'navigation');
    expect(screen.getByTestId('pager-root')).toHaveAttribute('data-destination', '0');

    touchEnd(chrome, 230);
    await waitFor(() =>
      expect(screen.getByTestId('pager-root')).toHaveAttribute('data-phase', 'idle'),
    );
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
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
