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
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
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

  it('uses a compact back control visible only below lg', () => {
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
    expect(back.className).toMatch(/size-9/);
    expect(back.className).toMatch(/lg:hidden/);
  });

  it('opens the sessions drawer from the top row button', async () => {
    const onOpenDrawer = vi.fn();
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenDrawer={onOpenDrawer}
      />,
    );
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it('shows the server micro-status when provided', () => {
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
        serverStatus="connected"
      />,
    );
    expect(screen.getByTestId('server-connection')).toHaveTextContent('server: connected');
  });

  it('marks the server micro-status with the error tone when disconnected', () => {
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
        serverStatus="disconnected"
      />,
    );
    const status = screen.getByTestId('server-connection');
    expect(status.className).toMatch(/text-agent-error/);
  });

  it('omits the drawer button and server status when not provided', () => {
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="host"
        state={healthy}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('session-first-open-drawer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('server-connection')).not.toBeInTheDocument();
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
    expect(back.className).toMatch(/size-9/);
    expect(back.className).toMatch(/duration-\[var\(--sf-motion\)\]/);
  });
});
