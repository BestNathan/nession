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
  props: Partial<Pick<TerminalSurfaceProps, 'inputDrop' | 'onDismissInputDrop'>> = {},
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

    expect(screen.getByTestId('terminal-surface')).toHaveAttribute(
      'data-terminal-capsule-host',
    );
    expect(screen.getByTestId('terminal-surface')).toHaveAttribute(
      'data-terminal-scrollback-mode',
      'local-buffer',
    );
    expect(screen.getByTestId('terminal-viewport-slot')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
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
