import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '@/components/SessionList';
import type { Session } from '@/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:sess-1',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 3,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
    ...overrides,
  };
}

const defaultProps = {
  sortField: 'name' as const,
  sortDirection: 'asc' as const,
  toggleSort: vi.fn(),
  isSearchActive: false,
};

describe('SessionList', () => {
  describe('stale agent marking', () => {
    it('marks sessions whose agent failed to answer the refresh', () => {
      render(
        <SessionList
          sessions={[makeSession()]}
          loading={false}
          staleAgents={['agent-1']}
          onAttach={vi.fn()}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      expect(screen.getByTestId('stale-badge-agent-1:sess-1')).toBeInTheDocument();
    });

    it('does not mark sessions when no agent is stale', () => {
      render(
        <SessionList
          sessions={[makeSession()]}
          loading={false}
          onAttach={vi.fn()}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      expect(screen.queryByTestId('stale-badge-agent-1:sess-1')).not.toBeInTheDocument();
    });

    /** Only the unreachable agent's rows are flagged — a healthy agent in the
     *  same list must stay unmarked. */
    it('marks only the stale agent when several agents are listed', () => {
      const sessions: Session[] = [
        makeSession({ session_id: 'agent-1:a', agent_id: 'agent-1' }),
        makeSession({ session_id: 'agent-2:b', agent_id: 'agent-2' }),
      ];

      render(
        <SessionList
          sessions={sessions}
          loading={false}
          staleAgents={['agent-2']}
          onAttach={vi.fn()}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      expect(screen.queryByTestId('stale-badge-agent-1:a')).not.toBeInTheDocument();
      expect(screen.getByTestId('stale-badge-agent-2:b')).toBeInTheDocument();
    });

    /** A stale session is still fully usable — the badge is informational, so
     *  Attach must keep working. */
    it('keeps a stale session attachable', async () => {
      const onAttach = vi.fn();
      render(
        <SessionList
          sessions={[makeSession()]}
          loading={false}
          staleAgents={['agent-1']}
          onAttach={onAttach}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: /attach/i }));
      expect(onAttach).toHaveBeenCalledTimes(1);
    });
  });


  it('renders session rows', () => {
    const sessions: Session[] = [
      makeSession({ session_name: 'dev', status: 'active' }),
      makeSession({ session_id: 'agent-1:sess-2', session_name: 'staging', status: 'detached' }),
    ];

    render(
      <SessionList
        sessions={sessions}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        {...defaultProps}
      />,
    );

    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
  });

  it('has Attach and Kill buttons for each session', () => {
    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        {...defaultProps}
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument();
  });

  it('calls onAttach when Attach button is clicked', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const session = makeSession();

    render(
      <SessionList
        sessions={[session]}
        loading={false}
        onAttach={onAttach}
        onKill={vi.fn()}
        {...defaultProps}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Attach' }));
    expect(onAttach).toHaveBeenCalledWith(session);
  });

  it('calls onKill when Kill button is clicked', async () => {
    const user = userEvent.setup();
    const onKill = vi.fn();
    const session = makeSession();

    render(
      <SessionList
        sessions={[session]}
        loading={false}
        onAttach={vi.fn()}
        onKill={onKill}
        {...defaultProps}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Kill' }));
    expect(onKill).toHaveBeenCalledWith(session);
  });

  it('shows no sessions message when empty', () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        {...defaultProps}
      />,
    );

    expect(screen.getByText(/No sessions for this agent/)).toBeInTheDocument();
  });

  it('shows skeleton when loading', () => {
    render(
      <SessionList
        sessions={[]}
        loading={true}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        {...defaultProps}
      />,
    );

    // Skeletons should be rendered
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('calls toggleSort with "name" when Name header clicked', async () => {
    const user = userEvent.setup();
    const toggleSort = vi.fn();

    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={toggleSort}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(toggleSort).toHaveBeenCalledWith('name');
  });

  it('calls toggleSort with "activity" when Activity header clicked', async () => {
    const user = userEvent.setup();
    const toggleSort = vi.fn();

    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={toggleSort}
        isSearchActive={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Activity' }));
    expect(toggleSort).toHaveBeenCalledWith('activity');
  });

  it('shows search-empty state when isSearchActive and no sessions', () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={true}
      />,
    );

    expect(screen.getByText(/No agents or sessions match your search/)).toBeInTheDocument();
  });

  it('shows default empty state when not isSearchActive and no sessions', () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByText(/No sessions for this agent/)).toBeInTheDocument();
  });

  const sampleSession = {
    session_id: 's1',
    session_name: 'build',
    agent_id: 'agent-1',
    status: 'active' as const,
    window_count: 2,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
  };

  it('fills available height instead of a fixed max-height', () => {
    const { container } = render(
      <SessionList
        sessions={[sampleSession]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );
    const scrollArea = container.querySelector('[data-testid="session-scroll"]');
    expect(scrollArea?.className).toContain('flex-1');
    expect(scrollArea?.className).not.toContain('max-h-64');
  });

  it('hides the Activity sort column on mobile', () => {
    render(
      <SessionList
        sessions={[sampleSession]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );
    const activity = screen.getByRole('button', { name: /Activity/ });
    expect(activity.className).toContain('hidden');
    expect(activity.className).toContain('md:flex');
  });
});
