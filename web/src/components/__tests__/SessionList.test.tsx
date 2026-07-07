import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '../SessionList';
import type { Session } from '../../types';

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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
        {...defaultProps}
      />,
    );

    // Skeletons should be rendered
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('disables Attach buttons when attachingInProgress', () => {
    render(
      <SessionList
        sessions={[makeSession()]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={true}
        {...defaultProps}
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
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
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );

    expect(screen.getByText(/No sessions for this agent/)).toBeInTheDocument();
  });
});
