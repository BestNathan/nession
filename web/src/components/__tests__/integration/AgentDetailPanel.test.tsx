import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import type { Agent, Session } from '@/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-01',
    ip_address: '10.0.0.1',
    port: 8080,
    status: 'online',
    session_count: 3,
    active_sessions: 2,
    last_heartbeat: new Date().toISOString(),
    metadata: {
      tmux_version: '3.3',
      os_version: 'Linux 6.1',
      nession_version: '0.3.0',
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:session-1',
    agent_id: 'agent-1',
    session_name: 'session-1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentDetailPanel', () => {
  it('renders agent hostname and status badge', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('online')).toBeInTheDocument();
    // Hostname appears both in header title (h2) and system info card
    const hostnames = screen.getAllByText('server-01');
    expect(hostnames.length).toBeGreaterThanOrEqual(2);
  });

  it('renders connection info (IP, port) in system info card', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
  });

  it('renders versions from metadata', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('v0.3.0')).toBeInTheDocument();
    expect(screen.getByText('3.3')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.1')).toBeInTheDocument();
  });

  it('shows "Unknown" for missing metadata fields', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent({ metadata: undefined })}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    const unknowns = screen.getAllByText('Unknown');
    expect(unknowns.length).toBeGreaterThanOrEqual(2);
  });

  it('shows session count', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    // Sessions stat card shows the count
    expect(screen.getByText('3')).toBeInTheDocument();
    // Sessions section shows count
    expect(screen.getByText(/0 sessions on this agent/)).toBeInTheDocument();
  });

  it('shows "No heartbeat data yet" for empty history', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No heartbeat data yet')).toBeInTheDocument();
  });

  it('shows heartbeat timeline when history exists', () => {
    const now = Date.now();
    const heartbeatHistory = [
      new Date(now - 120_000).toISOString(),
      new Date(now - 60_000).toISOString(),
    ];
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={heartbeatHistory}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('No heartbeat data yet')).not.toBeInTheDocument();
    const agoElements = screen.getAllByText(/ago/);
    expect(agoElements.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onClose when Sheet close button clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={onClose}
      />,
    );

    const closeButton = screen.getByRole('button', { name: 'Close' });
    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows uptime from agent registered_at (~3h)', () => {
    const threeHoursMs = 3 * 3600 * 1000;
    const registeredAt = new Date(Date.now() - threeHoursMs).toISOString();
    render(
      <AgentDetailPanel
        agent={makeAgent({ registered_at: registeredAt })}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    // Uptime appears both in header stats row and stat card
    const uptimes = screen.getAllByText('3h 0m');
    expect(uptimes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders sessions in recent sessions list', () => {
    const sessions: Session[] = [
      makeSession({ session_id: 'agent-1:s1', session_name: 'dev', status: 'active' }),
      makeSession({ session_id: 'agent-1:s2', session_name: 'staging', status: 'detached' }),
    ];
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={sessions}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('detached')).toBeInTheDocument();
    expect(screen.getByText(/2 sessions on this agent/)).toBeInTheDocument();
  });

  it('shows empty state for no sessions', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No active sessions')).toBeInTheDocument();
  });

  it('renders quick actions bar', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('Copy All')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Ping')).toBeInTheDocument();
  });

  it('shows agent ID in truncated form', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent({ agent_id: 'a-very-long-agent-id-that-should-be-truncated-12345678' })}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    // The truncated ID should not be the full string
    expect(screen.queryByText('a-very-long-agent-id-that-should-be-truncated-12345678')).not.toBeInTheDocument();
  });

  it('shows Claude Code tab', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });
});
