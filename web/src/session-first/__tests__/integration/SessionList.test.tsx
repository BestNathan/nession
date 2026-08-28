import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '@/session-first/patterns/SessionList';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
  ip_address: '10.0.0.1', port: 1, status: 'offline', session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};
const sess: Session = {
  session_id: 'a1:fix', agent_id: 'a1', session_name: 'Fix terminal reconnect',
  status: 'active', window_count: 1, attached_clients: 0,
  last_activity: new Date().toISOString(),
};

describe('SessionList', () => {
  it('shows empty copy about Sessions', () => {
    render(
      <SessionList
        sessions={[]} agents={[]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
  });

  it('shows search miss copy when filtered list is empty', () => {
    render(
      <SessionList
        sessions={[]} agents={[]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        isSearchActive onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/No sessions match your search/i)).toBeInTheDocument();
  });

  it('lists a session while Agent is offline with Agent copy, not Session offline', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.getByText(/shell/)).toBeInTheDocument();
    expect(screen.getByText(/devbox-01/)).toBeInTheDocument();
    expect(screen.getByText(/Agent offline/)).toBeInTheDocument();
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(onSelect).toHaveBeenCalledWith(sess);
  });
});
