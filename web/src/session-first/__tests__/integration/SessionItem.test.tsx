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

  // jsdom does not apply group-hover; hover here exercises the row wrapper, click asserts behavior.
  it('calls onKill without selecting when kill is clicked', async () => {
    const user = userEvent.setup();
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
    const row = screen.getByTestId('session-item-row');
    await user.hover(row);
    const kill = screen.getByTestId('session-kill-a1:fix');
    await user.click(kill);
    expect(onKill).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows kill when selected even without hover', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected
        onSelect={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const kill = screen.getByTestId('session-kill-a1:fix');
    expect(kill).toBeInTheDocument();
    expect(kill.className).toMatch(/opacity-100/);
    expect(kill.className).toMatch(/pointer-events-auto/);
  });

  it('keeps kill in DOM when not selected or hovered', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const kill = screen.getByTestId('session-kill-a1:fix');
    expect(kill).toBeInTheDocument();
    expect(kill.className).toMatch(/opacity-0/);
    expect(kill.className).toMatch(/pointer-events-none/);
  });

  it('uses design tokens for row spacing', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    const row = screen.getByTestId('session-item-row');
    expect(row.className).toMatch(/shell-space|var\(--shell-space/);
  });
});
