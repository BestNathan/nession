import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar, type SidebarProps } from '@/app/Sidebar';
import type { Agent, Session } from '@/types';

const agents: Agent[] = [
  {
    agent_id: 'a1',
    hostname: 'devbox-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 2,
    last_heartbeat: '2026-09-16T00:00:00Z',
  },
  {
    agent_id: 'a2',
    hostname: 'sg-prod',
    ip_address: '10.0.0.2',
    port: 19090,
    status: 'offline',
    session_count: 0,
    last_heartbeat: '2026-09-16T00:00:00Z',
  },
];

const sessions: Session[] = [
  {
    session_id: 'a1:fix',
    session_name: 'fix-terminal-reconnect',
    agent_id: 'a1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-11-06T10:00:00Z',
  },
];

function props(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    agents,
    filteredSessions: sessions,
    totalSessionCount: sessions.length,
    staleAgents: [],
    selectedId: 'a1:fix',
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

describe('Session-first Web sidebar (#2851)', () => {
  it('leads with Session navigation and keeps infrastructure below it', () => {
    render(<Sidebar {...props()} />);

    const top = screen.getByTestId('sidebar-top-actions');
    const list = screen.getByTestId('sidebar').querySelector('[data-testid="session-item-row"]');
    const agentsEntry = screen.getByTestId('sidebar-agents-entry');
    const footer = screen.getByTestId('sidebar-footer');

    expect(top).toHaveTextContent('New Session');
    expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
    expect(list).not.toBeNull();
    // Sessions are before infrastructure in document order.
    expect(list!.compareDocumentPosition(agentsEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agentsEntry.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not put an Agent roster at the top until its entry is opened', async () => {
    render(<Sidebar {...props()} />);

    expect(screen.queryByTestId('sidebar-agents')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agents-entry')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByTestId('sidebar-agents-entry'));

    expect(screen.getByTestId('sidebar-agents-entry')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agent-a1')).toHaveAttribute('data-agent-active', 'true');
    expect(screen.getByTestId('sidebar-agent-a2')).not.toHaveAttribute('data-agent-active');
  });

  it('offers exactly one collapse control, in the top navigation row', () => {
    render(<Sidebar {...props()} />);

    expect(within(screen.getByTestId('sidebar-top-actions')).getByTestId('sidebar-collapse')).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar-footer')).queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
  });

  it('keeps the collapse control when there are zero Agents', () => {
    render(<Sidebar {...props({ agents: [] })} />);
    expect(screen.getByTestId('sidebar-collapse')).toBeInTheDocument();
    expect(screen.getByTestId('create-session')).toBeDisabled();
  });

  it('uses the narrow overlay close action instead of a collapse control', () => {
    const onCloseDrawer = vi.fn();
    render(
      <Sidebar
        {...props()}
        collapsible={false}
        onCloseDrawer={onCloseDrawer}
      />,
    );

    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-drawer-close')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-drawer-close')).toHaveAccessibleName('Close sessions');
  });

  it('does not turn one offline Agent into an error in the server footer', () => {
    render(<Sidebar {...props({ connectionStatus: 'reconnecting' })} />);

    const footer = screen.getByTestId('sidebar-footer');
    expect(within(footer).getByTestId('sidebar-server-status')).toHaveTextContent('Server reconnecting');
    expect(within(footer).getByTestId('sidebar-server-dot').className).toMatch(/destructive/);
    expect(screen.getByTestId('sidebar-agents-entry')).not.toHaveTextContent('offline');
  });

  it('groups history by time and drops recency from the grouped rows', () => {
    const today = new Date().toISOString();
    render(
      <Sidebar
        {...props({
          filteredSessions: [
            { ...sessions[0], session_id: 'a1:today', last_activity: today },
            { ...sessions[0], session_id: 'a1:old', last_activity: '2020-01-01T00:00:00Z' },
          ],
        })}
      />,
    );

    expect(screen.getAllByTestId('session-group-label').map((label) => label.textContent)).toEqual([
      'Today',
      'Older',
    ]);
    for (const meta of screen.getAllByTestId('session-item-meta')) {
      expect(meta).not.toHaveTextContent(/ago/);
    }
  });

  it('keeps the Session rows flat under their time labels, never under an Agent', () => {
    render(
      <Sidebar
        {...props({
          filteredSessions: [
            { ...sessions[0], session_id: 'a1:one', last_activity: new Date().toISOString() },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('session-item-a1:one')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
  });
});
