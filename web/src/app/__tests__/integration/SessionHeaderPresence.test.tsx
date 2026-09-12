import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionHeader } from '@/app/patterns/SessionHeader';
import type { DomainState } from '@/features/sessions/model/domainState';

function state(overrides: {
  agent?: DomainState['agent'];
  session?: DomainState['session'];
  attachment?: DomainState['attachment'];
} = {}): DomainState {
  return {
    agent: overrides.agent ?? { channel: 'online', copy: null },
    session: overrides.session ?? { channel: 'active', copy: null },
    attachment: overrides.attachment ?? { channel: 'attached', copy: null },
  };
}

function renderHeader(domain: DomainState, extra: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  return render(
    <SessionHeader
      sessionName="Fix terminal reconnect"
      agentLabel="devbox-01"
      state={domain}
      surface="terminal"
      onSurfaceChange={vi.fn()}
      onOpenAgent={vi.fn()}
      {...extra}
    />,
  );
}

describe('SessionHeader contextual presence', () => {
  it('keeps healthy infrastructure context out of the header', () => {
    renderHeader(state());

    // Identity and navigation stay; only the redundant infrastructure goes quiet.
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.queryByTestId('agent-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('escalates an unreachable agent exactly once', () => {
    renderHeader(state({ agent: { channel: 'offline', copy: 'Agent offline' } }));

    expect(screen.getByTestId('agent-context')).toHaveTextContent('Agent offline');
    // The status line must not repeat what the agent member already reports.
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('escalates a session that is gone', () => {
    renderHeader(state({ session: { channel: 'exited', copy: null } }));

    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
  });

  it('surfaces an attach that is still in flight', () => {
    renderHeader(state({ attachment: { channel: 'attaching', copy: null } }));

    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
  });

  it('stays quiet for a detached session', () => {
    renderHeader(state({ attachment: { channel: 'detached', copy: null } }));

    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('keeps a healthy server connection quiet', () => {
    renderHeader(state(), { serverStatus: 'connected' });

    expect(screen.queryByTestId('server-connection')).not.toBeInTheDocument();
  });

  it('surfaces a server connection that is not healthy', () => {
    renderHeader(state(), { serverStatus: 'reconnecting' });

    expect(screen.getByTestId('server-connection')).toHaveTextContent('server: reconnecting');
  });

  it('keeps the status line on app, which has no separate agent member', () => {
    renderHeader(state({ agent: { channel: 'offline', copy: 'Agent offline' } }), {
      experience: 'app',
      onOpenDrawer: vi.fn(),
      onOpenWorkspace: vi.fn(),
    });

    expect(screen.getByTestId('connection-status')).toHaveTextContent(/offline/i);
  });
});
