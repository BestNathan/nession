import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureApp } from '@/app/fixture/FixtureApp';

vi.mock('@/app/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

/** The fixture reads its route's inputs, so every render needs a route. */
function renderFixture(route = '/fixture/app') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <FixtureApp />
    </MemoryRouter>,
  );
}

/** The Sessions layer, open, with its rows on screen. */
async function openSessions(route?: string) {
  renderFixture(route);
  await userEvent.setup().click(screen.getByTestId('app-header-sessions'));
}

describe('FixtureApp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the Terminal root with neither layer mounted', () => {
    renderFixture();
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute(
      'data-layer',
      'terminal',
    );
    // Exactly one header line. The pager mounted all three pages at once, so a
    // second one used to exist permanently; that duplicate is what this
    // composition removes, and a regression would bring it back.
    expect(screen.getAllByTestId('session-header-line')).toHaveLength(1);
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    expect(screen.queryByTestId('app-layer-sessions')).toBeNull();
  });

  it('opens Workspace as a layer and returns to the same Terminal', async () => {
    renderFixture();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('app-header-workspace'));
    expect(screen.getByTestId('app-layer-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    // The Terminal stays mounted underneath rather than being translated
    // off-screen. That is the mechanism behind #1049's "returning restores the
    // same Terminal state": there is no unmount, so there is no rebuild.
    expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();

    await user.click(screen.getByTestId('app-tool-back'));
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
  });

  it('opens Sessions as a layer and leaves the surface at the Terminal', async () => {
    renderFixture();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('app-header-sessions'));
    expect(screen.getByTestId('app-layer-sessions')).toBeInTheDocument();
    // The App's own Sessions surface, not `Sidebar` (#1050 stage 1).
    expect(screen.getByTestId('app-sessions-surface')).toBeInTheDocument();
    // Sessions is navigation, not a surface — the Terminal remains the surface
    // and stays visible behind the layer. The old test recorded the same intent
    // as "a pager position, not a surface"; the overlay model is what makes it
    // literally true instead of a consequence of which page happened to mount.
    expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminal-well').classList.contains('hidden'),
    ).toBe(false);
  });

  it('renders the Session list in the order the product sorts it, not the declaration order', async () => {
    await openSessions();

    // `filterSessions` sorts by name ascending, and the fixture renders its
    // output: alphabetically `design-system` leads and `staging-deploy` trails,
    // where `fixtureData` declares them third and sixth. The declaration order
    // is not a sort any (field, direction) produces, so a fixture that passed
    // the raw list would be showing a screen the app cannot reach — which is
    // what this asserts against, not the sort function's own behaviour.
    const rows = screen.getAllByTestId('session-item-row');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent('design-system');
    expect(rows[5]).toHaveTextContent('staging-deploy');
  });

  it('narrows the list to the Sessions the search field carries', async () => {
    await openSessions();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);

    // The field is located by role, not by its copy: the copy is asserted where
    // it is decided (`SearchBar`), and a locator that restated it would turn the
    // next wording change into a failing test about debouncing.
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'devbox' },
    });
    // The field debounces (200ms) before it hands the query to the list.
    act(() => {
      vi.advanceTimersByTime(250);
    });

    // Three of six: `filterSessions` matches the Session's name *or* its Agent
    // id, so this keeps every `devbox-01` Session — including `design-system`,
    // whose name says nothing about the query.
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(3);
    expect(screen.getByTestId('session-item-devbox-01:design-system')).toBeInTheDocument();
    expect(screen.queryByTestId('session-item-macbook:dotfiles')).toBeNull();
  });

  it('reads a stale Agent as each of its Sessions not having answered', async () => {
    await openSessions('/fixture/app?stale=macbook');

    // The reading comes from `mapDomainState` over the route's input, never from
    // a string the fixture wrote: `macbook` is listed as online and is the Agent
    // that did not answer, so its Sessions take the error channel, while
    // `sg-prod`'s keeps the offline one it already had.
    const didNotRespond = screen.getAllByText('Agent did not respond');
    expect(didNotRespond).toHaveLength(2);
    expect(didNotRespond[0].className).toContain('text-agent-error');
    expect(screen.getAllByText('Agent offline')).toHaveLength(1);
  });
});
