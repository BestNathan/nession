import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SessionFirstWorkspace,
  type SessionFirstWorkspaceProps,
} from '@/session-first/SessionFirstWorkspace';
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

vi.mock('@/session-first/workspace/tools/filesApp', () => ({
  FilesAppLayout: () => <div data-testid="file-workspace" />,
}));

function baseProps(
  overrides: Partial<SessionFirstWorkspaceProps> = {},
): SessionFirstWorkspaceProps {
  return {
    connectionStatus: 'connected',
    agents: [agent],
    filteredSessions: [sess],
    staleAgents: [],
    selectedId: null,
    clientSessionId: '',
    loadingSessions: false,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    statusFilter: 'all',
    setStatusFilter: vi.fn(),
    sortField: 'activity',
    sortDirection: 'desc',
    toggleSort: vi.fn(),
    isSearchActive: false,
    selectedSession: null,
    selectedAgent: undefined,
    domain: null,
    surface: 'terminal',
    tool: 'files',
    fileOps: null,
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onKill: vi.fn(),
    onSurfaceChange: vi.fn(),
    onToolChange: vi.fn(),
    onOpenAgent: vi.fn(),
    isWide: true,
    showList: true,
    showDetail: true,
    onBackToSessions: vi.fn(),
    onOpenEnv: vi.fn(),
    onLegacy: vi.fn(),
    ...overrides,
  };
}

describe('SessionFirstWorkspace spatial shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts app-spatial-shell when mobile and a session is selected', () => {
    render(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: false,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
          showList: false,
          showDetail: true,
        })}
      />,
    );
    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-back-to-list')).not.toBeInTheDocument();
  });

  it('does not mount app-spatial-shell when mobile and no session selected', () => {
    render(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: false,
          selectedId: null,
          showList: true,
          showDetail: false,
        })}
      />,
    );
    expect(screen.queryByTestId('app-spatial-shell')).not.toBeInTheDocument();
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
  });

  it('does not mount app-spatial-shell on desktop even with a selection', () => {
    render(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: true,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
        })}
      />,
    );
    expect(screen.queryByTestId('app-spatial-shell')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fix terminal reconnect' })).toBeInTheDocument();
  });

  it('open-workspace header action calls onSurfaceChange(workspace)', async () => {
    const onSurfaceChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: false,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
          onSurfaceChange,
          showList: false,
          showDetail: true,
        })}
      />,
    );

    await user.click(screen.getByTestId('app-spatial-open-workspace'));
    expect(onSurfaceChange).toHaveBeenCalledWith('workspace');
  });

  it('surface workspace shows file workspace content on spatial page', async () => {
    const { rerender } = render(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: false,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
          surface: 'terminal',
          showList: false,
          showDetail: true,
        })}
      />,
    );

    rerender(
      <SessionFirstWorkspace
        {...baseProps({
          isWide: false,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
          surface: 'workspace',
          showList: false,
          showDetail: true,
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('file-workspace')).toBeInTheDocument();
    });
  });
});
