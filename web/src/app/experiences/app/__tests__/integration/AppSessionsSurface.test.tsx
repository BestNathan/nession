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
    expect(screen.getByTestId('app-agents-count')).toHaveTextContent('2');
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

  it('carries the shared search field', () => {
    // Same `SearchBar` the Web column renders, placeholder included. That
    // placeholder ("Search agents and sessions...") describes more than this
    // surface filters — only Sessions are filtered — and is left alone here on
    // purpose: it belongs to the shared component, so rewording it would move
    // Web too. #1050 stage 3 owns that copy.
    render(<AppSessionsSurface {...props()} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
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

    // Chip counts are Agent counts while the filter applies to Sessions — the
    // inconsistency #1050 Finding 2 recorded, carried over rather than
    // corrected here (stage 3).
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
});
