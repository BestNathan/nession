import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SessionFirstSidebar,
  type SessionFirstSidebarProps,
} from '@/app/SessionFirstSidebar';
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
    created_at: '2026-09-16T00:00:00Z',
    attached_clients: 0,
    status: 'active',
  } as unknown as Session,
];

function props(overrides: Partial<SessionFirstSidebarProps> = {}): SessionFirstSidebarProps {
  return {
    agents,
    filteredSessions: sessions,
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

describe('sidebar sections (SC2)', () => {
  it('shows Agents, Sessions and service status at once when expanded', () => {
    render(<SessionFirstSidebar {...props()} />);

    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
    expect(screen.getByTestId('session-item-a1:fix')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-sidebar-footer')).toBeInTheDocument();
  });

  it('marks the active node and leaves the others unmarked', () => {
    render(<SessionFirstSidebar {...props()} />);

    // Location context lives here now that Web has no header. Only the node the
    // active Session runs on is marked — this is not a navigation hierarchy.
    expect(screen.getByTestId('sidebar-agent-a1')).toHaveAttribute('data-agent-active', 'true');
    expect(screen.getByTestId('sidebar-agent-a2')).not.toHaveAttribute('data-agent-active');
  });

  it('does not file sessions under their agent', () => {
    // `session-list.md` anti-pattern 1: flat by default, Agent is not a parent.
    render(<SessionFirstSidebar {...props()} />);

    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('session-item-row');
    expect(rows).toHaveLength(1);
  });

  it('collapses to a rail and offers a way back', async () => {
    render(<SessionFirstSidebar {...props()} />);

    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    // The rail's whole job is being a way back; every control on it restores
    // the sidebar, so collapsing can never strand the user.
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-rail-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('session-item-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-agents')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sidebar-rail-expand'));
    expect(screen.getByTestId('session-item-row')).toBeInTheDocument();
  });

  it('shows the connection state on the rail, not a roll-up of node health', async () => {
    // One node is offline above. That must not alarm the shell:
    // `session-list.md` names a global health indicator that collapses
    // independent state dimensions an anti-pattern.
    render(<SessionFirstSidebar {...props({ connectionStatus: 'reconnecting' })} />);

    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    expect(screen.getByTestId('sidebar-rail-status')).toHaveAttribute(
      'aria-label',
      'Server reconnecting',
    );
  });

  it('cannot be collapsed when it is an overlay drawer', () => {
    render(<SessionFirstSidebar {...props({ collapsible: false })} />);

    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
  });
});
