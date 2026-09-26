import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '@/product/session/patterns/SessionList';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
  ip_address: '10.0.0.1', port: 1, status: 'offline', session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};
const sess: Session = {
  session_id: 'a1:fix', agent_id: 'a1', session_name: 'Fix terminal reconnect',
  status: 'active', window_count: 1, attached_clients: 0,
  foreground_command: 'claude',
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
    // The workload hint is the Session's own foreground command, not a literal
    // this row supplies (session-item.md §Workload semantics).
    expect(screen.getByTestId('session-item-meta')).toHaveTextContent(/claude/);
    expect(screen.getByTestId('session-item-meta')).not.toHaveTextContent(/shell/);
    expect(screen.getByText(/devbox-01/)).toBeInTheDocument();
    expect(screen.getByText(/Agent offline/)).toBeInTheDocument();
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(onSelect).toHaveBeenCalledWith(sess);
  });

  it('says unknown for a Session with no reported foreground command', () => {
    const withoutCommand: Session = { ...sess, foreground_command: undefined };
    render(
      <SessionList
        sessions={[withoutCommand]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        onSelect={vi.fn()}
      />,
    );
    // Not `shell`: an unreported command means the row does not know, and
    // guessing the most common value is how the literal got there.
    expect(screen.getByTestId('session-item-meta')).toHaveTextContent(/^unknown/);
  });

  it('forwards onConfigure to the row', async () => {
    const onConfigure = vi.fn();
    render(
      <SessionList
        sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()} onConfigure={onConfigure}
      />,
    );
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    expect(onConfigure).toHaveBeenCalledWith(sess);
  });

  it('renders a caller-supplied header above its own rows (#1083)', () => {
    const other: Session = { ...sess, session_id: 'a1:other', session_name: 'Other' };
    render(
      <SessionList
        sessions={[sess, other]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()}
        groups={[
          {
            key: 'today',
            header: <h2 data-testid="group">Today</h2>,
            sessions: [sess],
          },
          {
            key: 'older',
            header: <h2 data-testid="group">Older</h2>,
            sessions: [other],
          },
        ]}
      />,
    );

    // Header-then-rows, in the caller's order, in one list.
    const headings = screen.getAllByTestId('group').map((el) => el.textContent);
    expect(headings).toEqual(['Today', 'Older']);
    const order = screen
      .getAllByTestId(/^session-item-row$/)
      .map((row) => row.textContent);
    expect(order[0]).toContain('Fix terminal reconnect');
    expect(order[1]).toContain('Other');
  });

  it('renders a footer after the rows, and none by default (#1083)', () => {
    // The App's Agents entry rides here — "below history" as literally DOM
    // order inside the scroll area, so an expanded disclosure is the
    // container's problem rather than a second region competing for height.
    const withFooter = render(
      <SessionList
        sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()}
        footer={<div data-testid="sl-footer">Agents</div>}
      />,
    );
    const row = screen.getByTestId('session-item-row');
    const footer = screen.getByTestId('sl-footer');
    expect(row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    withFooter.unmount();

    // Absent is the default, and it is what keeps Web's DOM unchanged.
    render(
      <SessionList
        sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('sl-footer')).not.toBeInTheDocument();
  });

  it('forwards showRowRecency to every row, defaulting to the three-slot line', () => {
    const two = [sess, { ...sess, session_id: 'a1:two' }];
    const without = render(
      <SessionList
        sessions={two} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()} showRowRecency={false}
      />,
    );
    for (const meta of screen.getAllByTestId('session-item-meta')) {
      expect(meta.textContent).toMatch(/^claude · /);
      expect(meta.textContent).not.toMatch(/ago|刚刚/);
    }
    without.unmount();

    render(
      <SessionList
        sessions={two} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()}
      />,
    );
    for (const meta of screen.getAllByTestId('session-item-meta')) {
      expect(meta.textContent).toMatch(/^claude · .+ · /);
    }
  });
});
