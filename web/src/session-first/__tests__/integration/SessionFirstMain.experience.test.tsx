import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import type { DomainState } from '@/session-first/domainState';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

let lastCtx: WorkspaceContext | null = null;
vi.mock('@/session-first/workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({ ctx }: { ctx: WorkspaceContext }) => {
    lastCtx = ctx;
    return <div data-testid="mock-workspace-shell" />;
  },
}));
vi.mock('@/session-first/SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="mock-terminal" />,
}));

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

const base = {
  selectedSession: { session_id: 's1', agent_id: 'devbox-01', session_name: 'fix-terminal-reconnect', status: 'active' as const, window_count: 2, attached_clients: 1, last_activity: '2026-09-01T09:00:00Z' },
  selectedAgent: undefined,
  domain: null,
  surface: 'terminal' as const,
  tool: 'files' as const,
  fileOps: null,
  onSurfaceChange: vi.fn(),
  onToolChange: vi.fn(),
  onOpenAgent: vi.fn(),
  connectionStatus: 'connected' as const,
};

describe('SessionFirstMain experience threading', () => {
  beforeEach(() => {
    lastCtx = null;
  });

  it('passes experience="app" into the workspace ctx', () => {
    render(
      <SessionFirstMain
        {...base}
        domain={domain}
        experience="app"
      />,
    );
    expect(screen.getByTestId('mock-workspace-shell')).toBeInTheDocument();
    expect(lastCtx?.experience).toBe('app');
  });

  it('defaults to experience="web"', () => {
    render(<SessionFirstMain {...base} domain={domain} />);
    expect(screen.getByTestId('mock-workspace-shell')).toBeInTheDocument();
    expect(lastCtx?.experience).toBe('web');
  });
});
