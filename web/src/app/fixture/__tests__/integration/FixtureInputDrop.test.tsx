import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { FixtureApp } from '@/app/fixture/FixtureApp';

// xterm's `open()` needs matchMedia in jsdom, and this file renders the real
// `FixtureTerminal` — the point of it is that the route reaches the surface
// through the components the route actually mounts, so stubbing the terminal
// would remove the seam being tested. Same stub, and same reason, as
// `TerminalInteractionController.test.ts`.
beforeAll(() => {
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
});

/** The fixture reads its route's inputs, so every render needs a route. */
function renderFixture(route = '/fixture/app') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <FixtureApp />
    </MemoryRouter>,
  );
}

/**
 * #1307 SC-09: a Session that lost input is reachable from a fixture route.
 *
 * The notice is the requirement's answer to input that cannot be proven
 * delivered, and until this route existed it had no screen: a live one needs an
 * Agent to restart mid-session, so it could not be photographed and no golden
 * image pinned it. `TerminalSurface`'s own test covers the sentence per reason;
 * what is under test here is the half that was missing — that the route's input
 * reaches that surface at all, through `FixtureTerminal`, unaltered.
 *
 * The assertion is on the rendered text rather than on a prop, because a prop
 * assertion would pass for a fixture that threaded the drop into a component
 * which then dropped it.
 */
describe('FixtureApp input drop', () => {
  it('renders the notice for a reason the route names', () => {
    renderFixture('/fixture/app?drop=epoch');

    const notice = screen.getByTestId('terminal-input-drop');
    expect(notice).toHaveTextContent(
      'Some input may not have reached the session — check before re-running it.',
    );
  });

  it('draws no notice on the canonical route', () => {
    // The 37 golden baselines capture this route, so the parameter has to be
    // absent-by-default rather than merely optional.
    renderFixture();

    expect(screen.queryByTestId('terminal-input-drop')).toBeNull();
  });

  it('reads the reason the route named, not a fixed one', () => {
    // One reason is a notice that ignores its input. `age` is the furthest from
    // `epoch` textually, so a hardcoded sentence cannot satisfy both.
    renderFixture('/fixture/app?drop=age');

    expect(screen.getByTestId('terminal-input-drop')).toHaveTextContent(
      'Input was discarded before it could be delivered — it waited too long.',
    );
  });
});
