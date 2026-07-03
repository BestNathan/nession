import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentDetailPanel } from '../AgentDetailPanel';
import type { Agent } from '../../types';

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

describe('AgentDetailPanel', () => {
  it('renders agent hostname and status badge', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );
    const hostnames = screen.getAllByText('server-01');
    expect(hostnames.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('renders connection info (IP, port)', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
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
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('0.3.0')).toBeInTheDocument();
    expect(screen.getByText('3.3')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.1')).toBeInTheDocument();
  });

  it('shows "Unknown" for missing metadata fields', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent({ metadata: undefined })}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );
    const unknowns = screen.getAllByText('Unknown');
    expect(unknowns.length).toBeGreaterThanOrEqual(3);
  });

  it('shows session count', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 active sessions/)).toBeInTheDocument();
  });

  it('shows "No heartbeat data yet" for empty history', () => {
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={[]}
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
        onClose={onClose}
      />,
    );

    const closeButton = screen.getByRole('button', { name: 'Close' });
    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows uptime from heartbeat history (~3h)', () => {
    const threeHoursMs = 3 * 3600 * 1000;
    const firstHeartbeat = new Date(Date.now() - threeHoursMs).toISOString();
    const heartbeatHistory = [firstHeartbeat];
    render(
      <AgentDetailPanel
        agent={makeAgent()}
        heartbeatHistory={heartbeatHistory}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/3h 0m/)).toBeInTheDocument();
  });
});
