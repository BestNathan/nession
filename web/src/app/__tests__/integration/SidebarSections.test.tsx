import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Sidebar,
  type SidebarProps,
} from '@/app/Sidebar';
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

/**
 * The composition harness: collapse state is owned outside the Sidebar
 * (#1196 §5 — `WebLayout` in the product), so tests drive it the same
 * controlled way.
 */
function Harness({ overrides }: { overrides?: Partial<SidebarProps> }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Sidebar
      {...props(overrides)}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    />
  );
}

describe('sidebar sections (SC2)', () => {
  it('shows Agents, Sessions and service status at once when expanded', () => {
    render(<Harness />);

    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
    expect(screen.getByTestId('session-item-a1:fix')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument();
  });

  it('marks the active node and leaves the others unmarked', () => {
    render(<Harness />);

    // Location context lives here now that Web has no header. Only the node the
    // active Session runs on is marked — this is not a navigation hierarchy.
    expect(screen.getByTestId('sidebar-agent-a1')).toHaveAttribute('data-agent-active', 'true');
    expect(screen.getByTestId('sidebar-agent-a2')).not.toHaveAttribute('data-agent-active');
  });

  it('does not file sessions under their agent', () => {
    // `session-list.md` anti-pattern 1: flat by default, Agent is not a parent.
    render(<Harness />);

    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('session-item-row');
    expect(rows).toHaveLength(1);
  });

  it('puts the one Collapse control in the Agents head, not the service footer', () => {
    // #1196 §1: collapse is a shell action in the top navigation zone — the
    // same zone the rail's Expand returns to — while the footer keeps only
    // service status.
    render(<Harness />);

    const agentsSection = screen.getByTestId('sidebar-agents');
    expect(within(agentsSection).getByTestId('sidebar-collapse')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('sidebar-footer')).queryByTestId('sidebar-collapse'),
    ).not.toBeInTheDocument();
  });

  it('keeps the Collapse control when there are zero Agents', () => {
    // A shell control that vanishes with the data is the "jumping control"
    // #1196 removes; the Agents head stays so the control does too.
    render(<Harness overrides={{ agents: [] }} />);

    expect(screen.getByTestId('sidebar-collapse')).toBeInTheDocument();
  });

  it('collapses to a rail and offers a way back', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-rail-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('session-item-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-agents')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sidebar-rail-expand'));
    expect(screen.getByTestId('session-item-row')).toBeInTheDocument();
  });

  it('the rail has exactly one interactive control: Expand', async () => {
    // #1196 §2 — Agents/Sessions summaries are information, not controls: no
    // button role, no tab stop, and clicking them does not expand.
    render(<Harness />);
    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    const rail = screen.getByTestId('sidebar-rail');
    const buttons = within(rail).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Expand sidebar');

    for (const summary of ['sidebar-rail-agents', 'sidebar-rail-sessions']) {
      const el = screen.getByTestId(summary);
      expect(el.tagName).not.toBe('BUTTON');
      expect(el).not.toHaveAttribute('tabindex');
    }

    await userEvent.click(screen.getByTestId('sidebar-rail-agents'));
    await userEvent.click(screen.getByTestId('sidebar-rail-sessions'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
  });

  it('the rail summaries report truthful totals, not the filtered population', async () => {
    // #1196 §3 — the rail quotes the unfiltered population; a narrow filter
    // result is made explicit ("1 shown · 3 total") instead of redefining the
    // number.
    render(
      <Harness
        overrides={{ totalSessionCount: 3, isSearchActive: true }}
      />,
    );
    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    const sessionsSummary = screen.getByTestId('sidebar-rail-sessions');
    expect(sessionsSummary).toHaveTextContent('3');
    expect(sessionsSummary).toHaveAttribute('aria-label', '1 shown of 3 sessions');
    expect(sessionsSummary).toHaveAttribute('title', '1 shown · 3 total');

    const agentsSummary = screen.getByTestId('sidebar-rail-agents');
    expect(agentsSummary).toHaveTextContent('2');
    expect(agentsSummary).toHaveAttribute('aria-label', '2 agents · 1 online');
  });

  it('one offline Agent does not turn the rail summaries into an error state', async () => {
    // a2 is offline. The count stays neutral — `session-list.md` names a
    // global health indicator that collapses independent state dimensions an
    // anti-pattern; only the server dot carries connection state.
    render(<Harness />);
    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    const summary = screen.getByTestId('sidebar-rail-agents');
    expect(summary.className).not.toMatch(/destructive/);
    expect(screen.getByTestId('sidebar-rail-status').className).not.toMatch(/destructive/);
  });

  it('shows the connection state on the rail, not a roll-up of node health', async () => {
    // One node is offline above. That must not alarm the shell:
    // `session-list.md` names a global health indicator that collapses
    // independent state dimensions an anti-pattern.
    render(<Harness overrides={{ connectionStatus: 'reconnecting' }} />);

    await userEvent.click(screen.getByTestId('sidebar-collapse'));

    expect(screen.getByTestId('sidebar-rail-status')).toHaveAttribute(
      'aria-label',
      'Server reconnecting',
    );
  });

  it('cannot be collapsed when it is an overlay drawer', () => {
    render(<Harness overrides={{ collapsible: false }} />);

    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
  });
});
