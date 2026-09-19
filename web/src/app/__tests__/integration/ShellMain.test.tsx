import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShellMain } from '@/app/ShellMain';
import type { DomainState } from '@/product/session/model/domainState';
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

vi.mock('@/app/TerminalRegion', () => ({
  TerminalRegion: () => <div data-testid="terminal" />,
}));

vi.mock('@/app/experiences/web/FilesWebLayout', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
}));

describe('ShellMain', () => {
  it('uses a full-bleed content column (no inset padding)', () => {
    render(
      <ShellMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
      />,
    );

    const content = screen.getByTestId('main-content');
    expect(content.className).not.toMatch(/\bp-\d+\b/);
    expect(content.className).not.toMatch(/\bpt-\d+\b/);
    expect(content.className).toMatch(/flex-1/);
    expect(content.className).toMatch(/min-h-0/);
  });

  it('renders the fixture terminal override instead of the attached terminal', () => {
    render(
      <ShellMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        terminal={<div data-testid="fixture-terminal" />}
      />,
    );

    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it('falls back to the attached terminal when no override is given', () => {
    render(
      <ShellMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });

  it('threads experience to the header: switcher shows in web, hidden in app', () => {
    const view = render(
      <ShellMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('surface-switcher')).toBeInTheDocument();

    view.rerender(
      <ShellMain
        selectedSession={sess}
        selectedAgent={agent}
        agents={[agent]}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        experience="app"
      />,
    );
    expect(screen.queryByTestId('surface-switcher')).not.toBeInTheDocument();
  });

  it('shows the empty state when no session is selected', () => {
    render(
      <ShellMain
        selectedSession={null}
        selectedAgent={undefined}
        agents={[]}
        domain={null}
        surface="terminal"
        tool="files"
        fileOps={null}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
        onOpenDrawer={vi.fn()}
      />,
    );

    // Web renders no header at all now (#748): the identity, drawer and
    // server-status members that used to sit above the work area are gone, and
    // their homes are the sidebar. What remains here is the work area itself.
    expect(screen.queryByTestId('session-header-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-resting-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('server-connection')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-empty-state')).toHaveTextContent(
      'Select a session to start working',
    );
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

});
