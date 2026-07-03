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
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });
});
