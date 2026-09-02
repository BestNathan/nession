import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHeader } from '@/session-first/patterns/SessionHeader';
import type { DomainState } from '@/session-first/domainState';

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
  it('renders a single row: sessions, name, state fragment, workspace', () => {
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
    // state fragment survives compression (no status collapsing)
    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
  });

  it('does not render the Terminal|Workspace switcher in app', () => {
    render(<SessionHeader {...base} experience="app" />);
    expect(screen.queryByTestId('surface-switcher')).not.toBeInTheDocument();
  });

  it('fires onOpenWorkspace from the workspace button', async () => {
    const onOpenWorkspace = vi.fn();
    render(<SessionHeader {...base} experience="app" onOpenWorkspace={onOpenWorkspace} />);
    await userEvent.click(screen.getByTestId('app-header-workspace'));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });
});
