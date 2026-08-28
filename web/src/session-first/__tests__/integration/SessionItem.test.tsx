import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionItem } from '@/session-first/patterns/SessionItem';
import type { DomainState } from '@/session-first/domainState';
import type { Session } from '@/types';

const session: Session = {
  session_id: 'a1:fix',
  agent_id: 'a1',
  session_name: 'Fix terminal reconnect',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: new Date().toISOString(),
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

describe('SessionItem', () => {
  it('selects the session when the row is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(onSelect).toHaveBeenCalledWith(session);
  });

  it('calls onKill without selecting when kill is clicked', async () => {
    const onSelect = vi.fn();
    const onKill = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onKill={onKill}
      />,
    );
    await userEvent.click(screen.getByTestId('session-kill-a1:fix'));
    expect(onKill).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
