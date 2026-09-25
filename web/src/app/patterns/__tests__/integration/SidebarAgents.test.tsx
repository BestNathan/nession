import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarAgents } from '@/app/patterns/SidebarAgents';
import type { Agent } from '@/types';

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
];

describe('SidebarAgents', () => {
  it('draws its own section head unless the caller owns it', () => {
    // The default is the Web sidebar's arrangement and must not move when an
    // App-side caller (#1050) asks for the head to be its own disclosure
    // trigger instead. `showSectionHead={false}` exists for that caller only.
    const { rerender } = render(
      <SidebarAgents agents={agents} activeAgentId="devbox-01" />,
    );
    expect(screen.getByText('Agents')).toBeInTheDocument();

    rerender(
      <SidebarAgents
        agents={agents}
        activeAgentId="devbox-01"
        showSectionHead={false}
      />,
    );
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
    // The rows are unaffected either way — the flag moves no node below the head.
    expect(screen.getByTestId('sidebar-agent-devbox-01')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
  });
});
