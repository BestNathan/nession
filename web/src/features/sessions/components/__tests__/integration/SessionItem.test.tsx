import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionItem } from '@/features/sessions/components/SessionItem';
import type { DomainState } from '@/features/sessions/model/domainState';
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
    // Hidden state is lg+-only now: icons stay visible below the breakpoint.
    expect(kill.className).toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/lg:pointer-events-none/);
    expect(kill.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
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

describe('SessionItem settings action', () => {
  it('renders no settings button when onConfigure is absent', () => {
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
    expect(screen.queryByTestId(`session-settings-${session.session_id}`)).toBeNull();
  });

  it('calls onConfigure with the session and never selects the row', async () => {
    const onSelect = vi.fn();
    const onConfigure = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onConfigure={onConfigure}
      />,
    );
    const button = screen.getByTestId(`session-settings-${session.session_id}`);
    expect(button).toHaveAccessibleName(
      `Configure attach settings for ${session.session_name}`,
    );
    await userEvent.click(button);
    expect(onConfigure).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // jsdom does not apply group-hover; class composition is the assertable contract.
  it('is always interactive below lg and revealed on hover at lg+ (kill parity)', () => {
    const onSelect = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onConfigure={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    // No unprefixed hidden state: icons are visible by default below lg. A bare
    // /opacity-0/ regex would also match inside lg:opacity-0, so negatives use
    // token boundaries.
    expect(settings.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(settings.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
    // The lg+ reveal chain is gated behind the breakpoint.
    expect(settings.className).toMatch(/lg:opacity-0/);
    expect(settings.className).toMatch(/lg:pointer-events-none/);
    expect(settings.className).toMatch(/lg:group-hover:opacity-100/);
    expect(settings.className).toMatch(/lg:group-hover:pointer-events-auto/);
    expect(kill.className).toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/lg:pointer-events-none/);
  });

  it('keeps the icon visible while selected', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected
        onSelect={vi.fn()}
        onConfigure={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    expect(settings.className).toMatch(/opacity-100/);
    expect(settings.className).toMatch(/pointer-events-auto/);
    // The selected override is lg:-prefixed so tailwind-merge drops the lg:
    // hidden rules — otherwise the hidden state would win the cascade at lg+.
    expect(settings.className).not.toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/opacity-100/);
    expect(kill.className).toMatch(/pointer-events-auto/);
    expect(kill.className).not.toMatch(/lg:opacity-0/);
  });
});
