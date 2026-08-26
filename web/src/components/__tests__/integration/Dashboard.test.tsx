import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AgentSection } from '@/components/Dashboard';
import type { Agent } from '@/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-01',
    display_name: 'prod-box',
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

describe('AgentSection (mobile strip)', () => {
  const baseProps = {
    loadingAgents: false,
    agents: [] as Agent[],
    filteredAgents: [] as Agent[],
    isSearchActive: false,
    setSelectedAgent: vi.fn(),
  };

  const twoAgents = [
    makeAgent({ agent_id: 'agent-1', display_name: 'prod-box' }),
    makeAgent({ agent_id: 'agent-2', display_name: 'dev-box' }),
  ];

  it('renders a horizontally scrollable agent strip instead of a summary bar', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    expect(screen.queryByTestId('agent-summary-bar')).not.toBeInTheDocument();
    const strip = screen.getByTestId('agent-strip');
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).toContain('scrollbar-none');
  });

  it('renders every agent card in the strip without shrinking', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    const strip = screen.getByTestId('agent-strip');
    expect(within(strip).getByText('prod-box')).toBeInTheDocument();
    expect(within(strip).getByText('dev-box')).toBeInTheDocument();
    const firstCard = strip.firstElementChild;
    expect(firstCard?.className).toContain('flex-shrink-0');
  });

  it('hides the desktop grid below md and shows it from md up', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    const grid = screen.getByTestId('agent-grid');
    expect(grid.className).toContain('hidden');
    expect(grid.className).toContain('md:grid');
  });
});
