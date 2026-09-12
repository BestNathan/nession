import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHeader } from '@/app/patterns/SessionHeader';
import type { DomainState } from '@/features/sessions/model/domainState';

const healthy: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

const base = {
  sessionName: 'fix-terminal-reconnect',
  agentLabel: 'devbox-01',
  state: healthy,
  surface: 'terminal' as const,
  onSurfaceChange: vi.fn(),
  onOpenAgent: vi.fn(),
};

describe('SessionHeader app branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single row: sessions, name, workspace — and no status while healthy', () => {
    render(
      <SessionHeader
        {...base}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByText('fix-terminal-reconnect')).toBeInTheDocument();
    // Healthy + redundant infrastructure is quiet: the status line exists only
    // when it has something the user can act on.
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('renders the status line when the agent is unreachable', () => {
    render(
      <SessionHeader
        {...base}
        state={{ ...healthy, agent: { channel: 'offline', copy: 'Agent offline' } }}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-status')).toHaveTextContent(/offline/);
  });

  it('omits the sessions and workspace buttons when callbacks are absent', () => {
    render(<SessionHeader {...base} experience="app" />);
    expect(screen.queryByTestId('app-header-sessions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-header-workspace')).not.toBeInTheDocument();
  });

  it('fires onOpenWorkspace from the workspace button', async () => {
    const onOpenWorkspace = vi.fn();
    render(<SessionHeader {...base} experience="app" onOpenWorkspace={onOpenWorkspace} />);
    await userEvent.click(screen.getByTestId('app-header-workspace'));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });
});
