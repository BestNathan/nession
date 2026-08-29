import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHeader } from '@/session-first/patterns/SessionHeader';
import type { DomainState } from '@/session-first/domainState';

const healthy: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};
const offline: DomainState = {
  ...healthy,
  agent: { channel: 'offline', copy: 'Agent offline' },
};

describe('SessionHeader', () => {
  it('shows session name, quiet agent identity, and surface switcher', async () => {
    const onSurface = vi.fn();
    render(
      <SessionHeader
        sessionName="Fix terminal reconnect"
        agentLabel="devbox-01"
        state={healthy}
        surface="terminal"
        onSurfaceChange={onSurface}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.getByTestId('agent-context')).toHaveTextContent('devbox-01');
    expect(screen.queryByText('Agent offline')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    expect(onSurface).toHaveBeenCalledWith('workspace');
  });

  it('makes AgentContext prominent when offline', () => {
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="devbox-01"
        state={offline}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(screen.getByTestId('agent-context')).toHaveTextContent('Agent offline');
  });

  it('uses a larger back control under max-lg', () => {
    render(
      <SessionHeader
        sessionName="demo"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onBackToSessions={vi.fn()}
      />,
    );
    const back = screen.getByTestId('session-first-back-to-list');
    expect(back.className).toMatch(/max-lg:size-11/);
  });

  it('uses design tokens for header spacing and back transition', () => {
    render(
      <SessionHeader
        sessionName="demo"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onBackToSessions={vi.fn()}
      />,
    );
    const header = screen.getByRole('banner');
    expect(header.className).toMatch(/sf-space|var\(--sf-space/);
    const back = screen.getByTestId('session-first-back-to-list');
    expect(back.className).toMatch(/max-lg:size-11/);
    expect(back.className).toMatch(/duration-\[var\(--sf-motion\)\]/);
  });
});
