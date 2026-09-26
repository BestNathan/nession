import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  WorkspaceRegion,
  type WorkspaceRegionProps,
} from '@/app/WorkspaceRegion';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';

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

vi.mock('@/app/experiences/app/FilesAppLayout', () => ({
  FilesAppLayout: () => <div data-testid="file-workspace" />,
}));

function baseProps(
  overrides: Partial<WorkspaceRegionProps> = {},
): WorkspaceRegionProps {
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
    onConfigure: vi.fn(),
    onKill: vi.fn(),
    onSurfaceChange: vi.fn(),
    onToolChange: vi.fn(),
    isWide: true,
    showList: true,
    showDetail: true,
    onCloseDrawer: vi.fn(),
    onBackToSessions: vi.fn(),

    ...overrides,
  };
}

function AppNavigationHarness() {
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');

  return (
    <WorkspaceRegion
      {...baseProps({
        isWide: false,
        selectedId: sess.session_id,
        selectedSession: sess,
        selectedAgent: agent,
        domain,
        surface,
        tool,
        onSurfaceChange: setSurface,
        onToolChange: setTool,
        showList: false,
        showDetail: true,
      })}
    />
  );
}

type AppLayerName = 'terminal' | 'workspace';

/**
 * `AppLayers` mounts only the layer that is open and names it on the root's
 * `data-layer`, so the current layer is asserted directly.
 *
 * The helper this replaces had to reverse-engineer the active page out of the
 * pager's track transform, because the shell exposed no active-page signal —
 * the transform *was* the state. That indirection is gone with the pager.
 *
 * The Terminal layer is asserted present in every case. It is the root: a
 * navigation that unmounted it would rebuild xterm, the attach state and the
 * scrollback, which #1049 forbids.
 */
function expectActiveAppLayer(layer: AppLayerName) {
  expect(screen.getByTestId('app-layer-root')).toHaveAttribute(
    'data-layer',
    layer,
  );
  expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
}

describe('WorkspaceRegion app layer composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts app-layer-root when mobile and a session is selected', () => {
    render(
      <WorkspaceRegion
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
    expect(screen.getByTestId('app-layer-root')).toBeInTheDocument();
    expect(screen.queryByTestId('back-to-list')).not.toBeInTheDocument();
  });

  it('does not mount app-layer-root when mobile and no session selected', () => {
    render(
      <WorkspaceRegion
        {...baseProps({
          isWide: false,
          selectedId: null,
          showList: true,
          showDetail: false,
        })}
      />,
    );
    expect(screen.queryByTestId('app-layer-root')).not.toBeInTheDocument();
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
  });

  it('does not mount app-layer-root on desktop even with a selection', () => {
    render(
      <WorkspaceRegion
        {...baseProps({
          isWide: true,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
        })}
      />,
    );
    expect(screen.queryByTestId('app-layer-root')).not.toBeInTheDocument();
    // Desktop is two columns: the Session's identity is its row in the sidebar,
    // not a heading above the work area (the header is gone — #748).
    expect(screen.getByTestId('sidebar-column')).toBeInTheDocument();
    expect(screen.getByTestId(`session-item-${sess.session_id}`)).toBeInTheDocument();
  });

  it('open-workspace header action calls onSurfaceChange(workspace)', async () => {
    const onSurfaceChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkspaceRegion
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

    await user.click(screen.getByTestId('app-header-workspace'));
    expect(onSurfaceChange).toHaveBeenCalledWith('workspace');
  });

  it('surface workspace shows file workspace content on spatial page', async () => {
    const { rerender } = render(
      <WorkspaceRegion
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
      <WorkspaceRegion
        {...baseProps({
          isWide: false,
          selectedId: sess.session_id,
          selectedSession: sess,
          selectedAgent: agent,
          domain,
          surface: 'workspace',
          // Files is only available with file ops; the workspace surface must
          // still show its deeper view once the capability is available.
          fileOps: {} as never,
          showList: false,
          showDetail: true,
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('file-workspace')).toBeInTheDocument();
    });
  });

  it('navigates to Claude Code from the app dock and back to terminal', async () => {
    const user = userEvent.setup();
    render(<AppNavigationHarness />);

    expectActiveAppLayer('terminal');

    await user.click(screen.getByTestId('app-header-workspace'));
    await waitFor(() => {
      expectActiveAppLayer('workspace');
    });
    await user.click(screen.getByTestId('workspace-capability-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code' }));
    expect(screen.getByTestId('claude-code-workspace')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Claude Code' })).toHaveLength(1);

    await user.click(screen.getByTestId('app-page-back'));
    await waitFor(() => {
      expectActiveAppLayer('terminal');
    });
    expect(screen.getByTestId('terminal-well')).not.toHaveClass('hidden');
  });
});
