import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionHeader } from '@/app/patterns/SessionHeader';
import type { DomainState } from '@/product/session/model/domainState';

/**
 * The header is App-only since #748: Web renders none, so these cases exercise
 * the App branch. Web's status home is the sidebar footer (covered by
 * SidebarSections.test.tsx), and Web has no `server-connection` member at all —
 * the App header never had one, so those cases are gone with the Web branch.
 */

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

function renderHeader(domain: DomainState) {
  return render(
    <SessionHeader
      sessionName="Fix terminal reconnect"
      state={domain}
      onOpenDrawer={vi.fn()}
      onOpenWorkspace={vi.fn()}
    />,
  );
}

describe('SessionHeader contextual presence (App)', () => {
  it('keeps healthy infrastructure context out of the header', () => {
    renderHeader(state());

    // Identity stays; only the redundant infrastructure goes quiet.
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
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

  it('reports an unreachable agent on the App status line', () => {
    // App has no separate agent member, so the agent dimension rides the status
    // line here. Web shows it on the affected Session row instead, where
    // `session-list.md` puts reachability.
    renderHeader(state({ agent: { channel: 'offline', copy: 'Agent offline' } }));

    expect(screen.getByTestId('connection-status')).toHaveTextContent(/offline/i);
  });
});
