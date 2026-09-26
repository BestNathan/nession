import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AppSessionsSurface,
  type AppSessionsSurfaceProps,
} from '@/app/experiences/app/AppSessionsSurface';
import type { Agent, Session } from '@/types';

const agents: Agent[] = [
  {
    agent_id: 'devbox-01',
    hostname: 'devbox-01',
    display_name: 'devbox-01',
    ip_address: '10.0.0.11',
    port: 19091,
    status: 'online',
    session_count: 2,
    last_heartbeat: '2026-09-01T08:00:00Z',
    registered_at: '2026-08-01T00:00:00Z',
  },
  {
    agent_id: 'sg-prod',
    hostname: 'sg-prod',
    display_name: 'sg-prod',
    ip_address: '10.0.0.21',
    port: 19091,
    status: 'offline',
    session_count: 1,
    last_heartbeat: '2026-09-01T07:30:00Z',
    registered_at: '2026-08-20T00:00:00Z',
  },
];

const sessions: Session[] = [
  {
    session_id: 'devbox-01:fix-terminal-reconnect',
    session_name: 'fix-terminal-reconnect',
    agent_id: 'devbox-01',
    created_at: '2026-09-01T00:00:00Z',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    foreground_command: 'bash',
    last_activity: '2026-09-01T08:00:00Z',
  } as unknown as Session,
  {
    session_id: 'devbox-01:design-system',
    session_name: 'design-system',
    agent_id: 'devbox-01',
    created_at: '2026-09-01T00:00:00Z',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    foreground_command: 'codex',
    last_activity: '2026-09-01T07:40:00Z',
  } as unknown as Session,
];

/**
 * The floor class the list must carry, spelled out here rather than imported
 * from the component: an assertion that reads the component's own constant
 * would follow any edit to it, and the point is to pin the token the list
 * depends on. App-scoped in name because the token only exists under
 * `[data-experience="app"]` (`nession/no-cross-experience-token`).
 */
const AppSessionsListFloorClass =
  'min-h-[length:var(--shell-sessions-list-min-height)]';

/**
 * A local time `minutes` from today's midnight — negative for earlier days.
 *
 * The bucket boundaries are local midnights, so a test that wants "today" must
 * say *when in today* rather than "an hour ago": at 00:30, an hour ago is
 * yesterday, and the assertion would fail for one hour of every day.
 */
function todayAt(minutes: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + minutes * 60_000);
}

function props(
  overrides: Partial<AppSessionsSurfaceProps> = {},
): AppSessionsSurfaceProps {  return {
    agents,
    filteredSessions: sessions,
    staleAgents: [],
    selectedId: 'devbox-01:fix-terminal-reconnect',
    clientSessionId: 'client-1',
    loadingSessions: false,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    statusFilter: 'all',
    setStatusFilter: vi.fn(),
    sortField: 'name',
    sortDirection: 'desc',
    toggleSort: vi.fn(),
    isSearchActive: false,
    connectionStatus: 'connected',
    domain: null,
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onConfigure: vi.fn(),
    onKill: vi.fn(),
    ...overrides,
  };
}

describe('App Sessions surface (#1050 stage 1)', () => {
  it('renders the Session list and the service foot', () => {
    render(<AppSessionsSurface {...props()} />);

    expect(screen.getByTestId('app-sessions-surface')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(2);
    expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument();
    expect(screen.getByTestId('create-session')).toBeEnabled();
  });

  it('offers no way to collapse itself into a rail', () => {
    // #1050 Finding 1: the App inherited `SidebarProps.collapsible`'s `true`
    // default, so its full-width overlay could collapse into a 50px rail with
    // no re-expand affordance anywhere in the App frame. The prop is not in
    // this component's props at all; this pins that it stays that way.
    render(<AppSessionsSurface {...props()} />);

    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
  });

  it('demotes Agents to a disclosure that starts closed', () => {
    render(<AppSessionsSurface {...props()} />);

    // Closed by default: session navigation is what this surface is for.
    expect(screen.queryByTestId('sidebar-agents')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-agents-disclosure')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // #1083: the count is what the entry *names* — `1 online`, not the 2 Agents
    // that exist. The fixture carries one online and one offline, so the two
    // readings differ and `toHaveTextContent('2')` could not tell them apart.
    expect(screen.getByTestId('app-agents-count')).toHaveTextContent('1 online');
  });

  it('puts the Agents entry below the Session rows, not above them', () => {
    // The whole point of #1083's criterion 9: infrastructure that leads the
    // page is the management console the issue is about. Position is asserted
    // as DOM order rather than as a style, because the move is the requirement.
    render(<AppSessionsSurface {...props()} />);

    const rows = screen.getAllByTestId('session-item-row');
    const entry = screen.getByTestId('app-agents-disclosure');
    const lastRow = rows[rows.length - 1];
    expect(lastRow).toBeDefined();
    expect(
      lastRow.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the Agents rows reachable behind the disclosure', async () => {
    render(<AppSessionsSurface {...props()} />);

    await userEvent.click(screen.getByTestId('app-agents-disclosure'));

    // The same SidebarAgents rows the Web column renders — not a reimplementation.
    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agent-devbox-01')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agent-sg-prod')).toBeInTheDocument();
    expect(screen.getByTestId('app-agents-disclosure')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // One "Agents" label, not two: the caller owns the head here, so the
    // closed→open transition must not stack a second one above the rows.
    expect(screen.getAllByText('Agents')).toHaveLength(1);

    await userEvent.click(screen.getByTestId('app-agents-disclosure'));
    expect(screen.queryByTestId('sidebar-agents')).not.toBeInTheDocument();
  });

  it('lets the chrome yield and keeps a floor under the list', () => {
    // Geometry, not styling. jsdom has no layout, so this pins the composition
    // contract that produces the geometry — the browser measurement behind this
    // change is recorded in the PR: at 844×390 the list wrapper used to be
    // exactly 0px and every row was unreachable (#1057).
    render(<AppSessionsSurface {...props()} />);

    const chrome = screen.getByTestId('app-sessions-chrome');
    // Shrinkable and scrollable: the deficit lands here.
    expect(chrome.className).toMatch(/\bmin-h-0\b/);
    expect(chrome.className).toMatch(/\boverflow-y-auto\b/);
    expect(chrome.className).not.toMatch(/\bshrink-0\b/);

    // ...and the list cannot follow it down, because `flex-1` alone has a zero
    // basis and takes no share of the deficit.
    const list = screen.getByTestId('app-sessions-list');
    expect(list.className).toContain(AppSessionsListFloorClass);
    expect(list.className).toMatch(/\bflex-1\b/);
  });

  it('keeps Session selection as the row action', async () => {
    const onSelect = vi.fn();
    render(<AppSessionsSurface {...props({ onSelect })} />);

    await userEvent.click(screen.getByTestId('session-item-devbox-01:design-system'));

    // Selection is what the row is for; the row's secondary actions live behind
    // their own controls and must not swallow it.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      session_id: 'devbox-01:design-system',
    });
  });

  it("says what it searches instead of inheriting Web's copy", () => {
    // The App filters Sessions only — `filterSessions` matches a Session's name
    // and its Agent id, and Agents are a collapsed disclosure here, never a
    // filtered set. `SearchBar`'s default promises both sets, so this surface
    // passes its own copy (#1050 stage 3). Web is untouched: `SessionListHeader`
    // passes no `placeholder` and `SearchBar.test.tsx` pins the default.
    render(<AppSessionsSurface {...props()} />);

    expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Search agents and sessions...'),
    ).not.toBeInTheDocument();
  });

  it('annotates its filter chips with no count', async () => {
    render(<AppSessionsSurface {...props()} />);
    await userEvent.click(screen.getByTestId('session-list-filters'));

    // An accessible name is exact here, badge text included — so these resolve
    // only while the chips are their bare labels. They used to read "Online 1"
    // / "Offline 1" from Agent counts while filtering Sessions; a count is part
    // of the name, which is why this is the assertion that fails if it returns
    // (see `SessionsFilters` for why it is gone rather than corrected).
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Online' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offline' })).toBeInTheDocument();
  });

  it('moves filters and sort behind a single trigger', async () => {
    const setStatusFilter = vi.fn();
    const toggleSort = vi.fn();
    const onRefresh = vi.fn();
    const onCreate = vi.fn();
    render(
      <AppSessionsSurface
        {...props({ setStatusFilter, toggleSort, onRefresh, onCreate })}
      />,
    );

    expect(
      screen.queryByTestId('session-list-filters-panel'),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('session-list-filters'));

    // The chips filter Sessions and now say only that — no Agent counts.
    expect(screen.getByTestId('session-list-filters-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Online/ }));
    expect(setStatusFilter).toHaveBeenCalledWith('online');

    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(toggleSort).toHaveBeenCalledWith('name');
    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(toggleSort).toHaveBeenCalledWith('activity');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('create-session'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('sizes its text controls by role, and its icon control by the icon token', () => {
    // #1073: the surface's own controls answer "what is this text's job", not
    // "which primitive rendered it". Every one of them was `text-xs` (12px)
    // from `Button size="sm"` — smaller than the search placeholder above them
    // and smaller than the metadata under the rows they act on.
    //
    // The header's `+` is not an exception to that rule but outside it: it has
    // no text, so there is no type role for it to take. #1083 moved creation
    // into the header as an icon (it was a labelled `+ New Session` row), and
    // it is sized by the icon-button token, which is where the 44px floor the
    // App contract measures actually comes from.
    const AppBodyRoleClass = 'text-[length:var(--typography-body-size)]';
    const AppIconButtonSizeClass = 'size-[length:var(--shell-icon-button-size)]';
    render(<AppSessionsSurface {...props()} />);

    expect(screen.getByTestId('session-list-filters').className).toContain(AppBodyRoleClass);

    const create = screen.getByTestId('create-session');
    expect(create.className).not.toContain(AppBodyRoleClass);
    expect(create.className).toContain(AppIconButtonSizeClass);
  });

  it('states the page title in the App title role (#1073)', () => {
    // Criterion 2: `Sessions` is a page title, not the muted section label this
    // screen used to open with. The role class is asserted rather than the size
    // because a literal px would be the local type decision #1073 forbids.
    //
    // `AppTitleRoleClass` is named, and named for the experience, because
    // `--typography-title-size` is emitted only under `[data-experience="app"]`
    // — an unnamed literal here is what `nession/no-cross-experience-token`
    // reports, and it is right to: the same string outside the App resolves to
    // nothing and the declaration is dropped silently.
    const AppTitleRoleClass = 'text-[length:var(--typography-title-size)]';
    render(<AppSessionsSurface {...props()} />);

    expect(screen.getByRole('heading', { name: 'Sessions' }).className).toContain(
      AppTitleRoleClass,
    );
  });

  it('groups history by time, and then drops the per-row recency (#1083)', () => {
    // The "never both" rule, and the only place it can be checked cheaply: with
    // two buckets the labels appear *and* the rows lose their third slot. Built
    // against the real clock rather than a faked one, so the buckets are the
    // ones a user would see — an hour ago is today, ten days ago is not.
    // Anchored to local midnight, not to `now - 1h`: an hour before 00:30 is
    // *yesterday*, so a relative offset puts this session in the wrong bucket
    // for the first hour of every day. 00:30 today is always today.
    const spread: Session[] = [
      { ...sessions[0]!, session_id: 'a:today', last_activity: todayAt(30).toISOString() },
      { ...sessions[1]!, session_id: 'a:older', last_activity: todayAt(-10 * 1440).toISOString() },
    ];
    render(<AppSessionsSurface {...props({ filteredSessions: spread })} />);

    // Today and Older, and no `Previous 7 days` between them: the empty bucket
    // is dropped rather than labelled.
    expect(
      screen.getAllByTestId('session-group-label').map((el) => el.textContent),
    ).toEqual(['Today', 'Older']);

    for (const meta of screen.getAllByTestId('session-item-meta')) {
      expect(meta.textContent).not.toMatch(/ago|刚刚/);
    }
  });

  it('leaves the list flat, and the recency in place, when one bucket holds it', () => {
    // The other half of "never both": grouping that has nothing to say must not
    // put a label over the whole list. Both fixtures here are an hour old.
    const oneBucket: Session[] = sessions.map((s, i) => ({
      ...s,
      session_id: `a:${i}`,
      last_activity: todayAt(30 + i).toISOString(),
    }));
    render(<AppSessionsSurface {...props({ filteredSessions: oneBucket })} />);

    expect(screen.queryAllByTestId('session-group-label')).toHaveLength(0);
    for (const meta of screen.getAllByTestId('session-item-meta')) {
      expect(meta.textContent).toMatch(/ago|刚刚/);
    }
  });

  it('sizes the chips and the sort row by the same control role', async () => {
    const AppBodyRoleClass = 'text-[length:var(--typography-body-size)]';
    render(<AppSessionsSurface {...props()} />);

    await userEvent.click(screen.getByTestId('session-list-filters'));

    // The chips are `Button size="sm"` and the sort row is a plain div; both are
    // controls on this surface, so both take the one role.
    expect(screen.getByRole('button', { name: 'Online' }).className).toContain(AppBodyRoleClass);
    expect(screen.getByRole('button', { name: 'Name' }).closest('div')?.className).toContain(
      AppBodyRoleClass,
    );
  });
});
