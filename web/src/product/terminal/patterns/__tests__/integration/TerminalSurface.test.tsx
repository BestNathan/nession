import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  TerminalSurface,
  type TerminalSurfaceProps,
} from '@/product/terminal/patterns/TerminalSurface';

/**
 * Answers "yes, desktop" — deliberately, and it is load-bearing.
 *
 * `TerminalSurface` must not consult the viewport at all any more, so any
 * media query reintroduced here would be answered `true` and would show up as
 * the *wrong capsule* rather than as a silent 768-vs-1024 disagreement.
 */
vi.mock('@/shared/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

function renderSurface(
  experience: 'web' | 'app',
  props: Partial<
    Pick<
      TerminalSurfaceProps,
      'inputDrop' | 'onDismissInputDrop' | 'terminalControl' | 'onTakeControl'
    >
  > = {},
) {
  return render(
    <TerminalSurface
      experience={experience}
      inputDisabled={false}
      controller={null}
      {...props}
    >
      <div data-testid="terminal-viewport-slot" />
    </TerminalSurface>,
  );
}

describe('TerminalSurface', () => {
  it('hosts xterm tree and floating capsule without legacy layout', () => {
    renderSurface('web');

    // The host is the *inner* box, not the surface root: it carries the
    // scrollback mode and the capsule the occlusion band is drawn for, and the
    // strips the surface owns are laid out after it (#1307 stage 6 — see the
    // last describe block, which is what fails if this moves back up).
    const surface = screen.getByTestId('terminal-surface');
    const host = surface.querySelector('[data-terminal-capsule-host]');
    expect(host).toHaveAttribute('data-terminal-scrollback-mode', 'local-buffer');
    expect(host).toContainElement(screen.getByTestId('terminal-capsule'));

    expect(screen.getByTestId('terminal-viewport-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-terminal-layout')).not.toBeInTheDocument();
  });

  it('takes the capsule experience from the shell, not from the viewport', () => {
    // Regression (#1049 / #1057). This component used to choose the capsule
    // with its own `useMediaQuery('(min-width: 768px)')` while the shell chose
    // its layout with `(min-width: 1024px)`. Between those widths the App shell
    // drew an App layout around a **Web** capsule — including the permanent
    // history control #1034 retired. iPad portrait and every landscape phone
    // live in that band.
    //
    // The mocked query above returns `true`, so this passes only while the prop
    // is what decides: if a viewport query ever comes back, the `app` render
    // below would produce the web capsule and fail here.
    const app = renderSurface('app');
    expect(screen.queryByTestId('capsule-history-trigger')).toBeNull();
    app.unmount();

    renderSurface('web');
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
  });
});

/**
 * #1307 SC-09 — the one user-visible surface this requirement adds.
 *
 * The requirement's constraint on it is "quiet by default, present only when a
 * decision is owed", so the absent case is asserted first and deliberately:
 * a notice that renders empty is a notice that occupies the surface forever,
 * and the shipping rule in this tree is "absent, not empty".
 */
describe('input that will never arrive (#1307 SC-09)', () => {
  it('says nothing when nothing has been lost', () => {
    renderSurface('web');

    expect(screen.queryByTestId('terminal-input-drop')).toBeNull();
  });

  it('states the uncertainty an epoch change leaves behind', () => {
    // The case the whole state exists for. The agent that could say whether
    // these bytes reached the PTY is gone, and its answer died with it, so the
    // surface says what is unknown rather than a fact it does not have — a
    // user who reads silence here is a user who re-runs a command that may
    // already have run.
    renderSurface('web', { inputDrop: { reason: 'epoch', chunks: 1, at: 0 } });

    expect(screen.getByTestId('terminal-input-drop')).toHaveTextContent(
      'Some input may not have reached the session — check before re-running it.',
    );
  });

  it('accounts for the losses the client can explain', () => {
    // The other three are losses the client *can* account for, which is what
    // makes silence the wrong answer for them too — the requirement asks for
    // "discard with explicit UX", not for three more ways to say nothing.
    const explained: Array<[Parameters<typeof renderSurface>[1], string]> = [
      [{ inputDrop: { reason: 'age', chunks: 2, at: 0 } }, 'it waited too long'],
      [{ inputDrop: { reason: 'bound', chunks: 1, at: 0 } }, 'too much was already waiting'],
      [{ inputDrop: { reason: 'generation', chunks: 1, at: 0 } }, 'another client took control'],
    ];

    for (const [props, phrase] of explained) {
      const view = renderSurface('web', props);
      expect(screen.getByTestId('terminal-input-drop')).toHaveTextContent(phrase);
      view.unmount();
    }
  });

  it('offers the decision and nothing else, and offers it once', async () => {
    // No re-send, and that is the design rather than an omission: the bytes
    // were discarded rather than kept (SC-15 keeps input contents out of
    // durable state) and re-sending input that may already have run is the
    // automatic replay the requirement forbids. So the strip carries exactly
    // one action, and it is the user's own decision to put it away.
    const onDismissInputDrop = vi.fn();
    renderSurface('web', {
      inputDrop: { reason: 'epoch', chunks: 1, at: 0 },
      onDismissInputDrop,
    });

    const strip = screen.getByTestId('terminal-input-drop');
    const actions = strip.querySelectorAll('button');
    expect(actions).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissInputDrop).toHaveBeenCalledTimes(1);
  });
});

/**
 * What the capsule host wraps (#1307 stage 6).
 *
 * `[data-terminal-capsule-host]` is not merely the capsule's positioning
 * anchor. `index.css` gives it the occlusion band — an `::after` at its own
 * bottom, `height: var(--terminal-content-bottom-inset)` — and the dock is
 * `absolute z-30` against it, so *anything laid out inside the host at its
 * bottom* is drawn under the composer. That is what happened: measured at
 * 390×844 on `/fixture/app?drop=epoch`, the notice was 366×49 (75%) covered by
 * an opaque `backdrop-filter` shell, `elementFromPoint` at its own centre
 * returned the capsule's textarea, and the frame was byte-identical to the
 * route with no notice at all.
 *
 * jsdom performs no layout, so this file cannot assert the geometry. It asserts
 * the structural invariant the geometry follows from — the part a later
 * refactor would break silently, because every DOM-reading assertion in this
 * file passes either way:
 *
 *   host  ⊇  { the well } ∪ { the capsule }      and      host  ⊅  { strips }
 *
 * The capsule is asserted *inside* the host for the same reason the strips are
 * asserted outside it: it is `z-30` and measured against the host, so a fix
 * that moved it out would trade one occlusion bug for another.
 */
describe('the capsule host wraps the well, not the surface (#1307 stage 6)', () => {
  function hostOf(view: ReturnType<typeof renderSurface>): HTMLElement {
    const surface = view.getByTestId('terminal-surface');
    // The host *is* the surface in the shape this test exists to reject, so the
    // lookup has to accept both or the assertions below would fail on a null
    // lookup instead of on the containment they are about.
    const host = surface.matches('[data-terminal-capsule-host]')
      ? surface
      : surface.querySelector('[data-terminal-capsule-host]');
    // Reachability, so "outside the host" cannot be satisfied by dropping the
    // attribute from the tree.
    expect(host).not.toBeNull();
    return host as HTMLElement;
  }

  it('keeps the delivery-unknown notice out of the host', () => {
    const view = renderSurface('web', { inputDrop: { reason: 'epoch', chunks: 1, at: 0 } });
    const notice = view.getByTestId('terminal-input-drop');

    expect(hostOf(view).contains(notice)).toBe(false);
  });

  it('keeps the observer bar out of the host', () => {
    // The same geometry as the notice, and the same occlusion — it predates
    // #1307, which is why it is asserted here rather than in that change.
    const view = renderSurface('web', { terminalControl: { role: 'observer' } });
    const bar = view.getByTestId('terminal-observer-bar');

    expect(hostOf(view).contains(bar)).toBe(false);
  });

  it('wraps the well and the capsule the band exists for', () => {
    const view = renderSurface('web');
    const host = hostOf(view);

    expect(host.contains(view.getByTestId('terminal-viewport-slot'))).toBe(true);
    expect(host.contains(view.getByTestId('terminal-capsule'))).toBe(true);
  });
});
