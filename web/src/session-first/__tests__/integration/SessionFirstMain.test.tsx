import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import type { DomainState } from '@/session-first/domainState';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1',
  hostname: 'devbox-01',
  display_name: 'devbox-01',
  ip_address: '10.0.0.1',
  port: 1,
  status: 'online',
  session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};

const sess: Session = {
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
  attachment: { channel: 'attached', copy: null },
};

vi.mock('@/session-first/SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="session-first-terminal" />,
}));

vi.mock('@/session-first/workspace/tools/filesWeb', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
  FilesAppLayout: () => <div data-testid="file-workspace" />,
}));

describe('SessionFirstMain', () => {
  it('uses a full-bleed content column (no inset padding)', () => {
    render(
      <SessionFirstMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onBackToSessions={vi.fn()}
        connectionStatus="connected"
      />,
    );

    const content = screen.getByTestId('session-first-main-content');
    expect(content.className).not.toMatch(/\bp-\d+\b/);
    expect(content.className).not.toMatch(/\bpt-\d+\b/);
    expect(content.className).toMatch(/flex-1/);
    expect(content.className).toMatch(/min-h-0/);
  });

  it('renders the fixture terminal override instead of the attached terminal', () => {
    render(
      <SessionFirstMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        connectionStatus="connected"
        terminal={<div data-testid="fixture-terminal" />}
      />,
    );

    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-terminal')).not.toBeInTheDocument();
  });

  it('falls back to the attached terminal when no override is given', () => {
    render(
      <SessionFirstMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        connectionStatus="connected"
      />,
    );

    expect(screen.getByTestId('session-first-terminal')).toBeInTheDocument();
  });

  it('threads experience to the header: switcher shows in web, hidden in app', () => {
    const view = render(
      <SessionFirstMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        connectionStatus="connected"
      />,
    );
    expect(screen.getByTestId('surface-switcher')).toBeInTheDocument();

    view.rerender(
      <SessionFirstMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        connectionStatus="connected"
        experience="app"
      />,
    );
    expect(screen.queryByTestId('surface-switcher')).not.toBeInTheDocument();
  });

  it('shows the resting top row and empty state when no session is selected', () => {
    render(
      <SessionFirstMain
        selectedSession={null}
        selectedAgent={undefined}
        agents={[]}
        domain={null}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenDrawer={vi.fn()}
        connectionStatus="connected"
      />,
    );

    expect(screen.getByTestId('session-resting-header')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-open-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('server-connection')).toHaveTextContent(
      'server: connected',
    );
    expect(screen.getByTestId('session-empty-state')).toHaveTextContent(
      'Select a session to start working',
    );
    expect(screen.queryByTestId('session-first-terminal')).not.toBeInTheDocument();
  });

  it('opens the sessions drawer from the resting top row button', async () => {
    const onOpenDrawer = vi.fn();
    const user = userEvent.setup();
    render(
      <SessionFirstMain
        selectedSession={null}
        selectedAgent={undefined}
        agents={[]}
        domain={null}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenDrawer={onOpenDrawer}
        connectionStatus="connected"
      />,
    );

    await user.click(screen.getByTestId('session-first-open-drawer'));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });
});
