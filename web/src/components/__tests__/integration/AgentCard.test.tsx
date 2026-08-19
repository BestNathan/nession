import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCard } from '@/components/AgentCard';
import type { Agent } from '@/types';

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
    registered_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    metadata: {
      tmux_version: '3.3',
      os_version: 'Linux 6.1',
      nession_version: '0.3.0',
    },
    ...overrides,
  };
}

describe('AgentCard', () => {
  it('renders agent hostname as display name when display_name is unset', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} />);
    // Hostname appears as the h3 title (falls back from display_name)
    expect(screen.getByRole('heading', { name: 'server-01' })).toBeInTheDocument();
  });

  it('renders custom display_name when set', () => {
    render(<AgentCard agent={makeAgent({ display_name: 'prod-box' })} onClick={vi.fn()} />);
    expect(screen.getByText('prod-box')).toBeInTheDocument();
  });

  it('renders IP address info via session count text', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} />);
    expect(screen.getByText(/3 sessions/)).toBeInTheDocument();
  });

  it('shows version info', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} />);
    expect(screen.getByText(/v0\.3\.0/)).toBeInTheDocument();
  });

  it('shows uptime', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} />);
    expect(screen.getByText(/up \d+[hm]/)).toBeInTheDocument();
  });

  it('shows online status badge', () => {
    render(<AgentCard agent={makeAgent({ status: 'online' })} onClick={vi.fn()} />);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('shows offline status badge', () => {
    render(<AgentCard agent={makeAgent({ status: 'offline' })} onClick={vi.fn()} />);
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('shows degraded status badge', () => {
    render(<AgentCard agent={makeAgent({ status: 'degraded' })} onClick={vi.fn()} />);
    expect(screen.getByText('degraded')).toBeInTheDocument();
  });

  it('shows singular session count', () => {
    render(<AgentCard agent={makeAgent({ session_count: 1 })} onClick={vi.fn()} />);
    expect(screen.getByText(/1 session/)).toBeInTheDocument();
  });

  it('fires onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<AgentCard agent={makeAgent()} onClick={onClick} />);

    await user.click(screen.getByRole('heading', { name: 'server-01' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not apply ring style (selected state removed)', () => {
    const { container } = render(
      <AgentCard agent={makeAgent()} onClick={vi.fn()} />,
    );
    const card = container.firstElementChild;
    expect(card?.className).not.toContain('ring-2');
  });

  it('shows edit button on hover (desktop)', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} />);
    const btn = screen.getByTitle('Rename agent');
    expect(btn).toBeInTheDocument();
  });
});
