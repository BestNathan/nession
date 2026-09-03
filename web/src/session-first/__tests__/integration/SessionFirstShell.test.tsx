import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { SessionFirstShell } from '@/session-first/SessionFirstShell';
import { sessionIdAtom } from '@/atoms/session';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
  ip_address: '10.0.0.1', port: 1, status: 'offline', session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};
const sess: Session = {
  session_id: 'a1:fix', agent_id: 'a1', session_name: 'Fix terminal reconnect',
  status: 'active', window_count: 1, attached_clients: 0,
  last_activity: new Date().toISOString(),
};

const dashboard = vi.hoisted(() => ({
  current: {
    agents: [] as Agent[],
    sessions: [] as Session[],
    staleAgents: [] as string[],
    filteredSessions: [] as Session[],
    loadingSessions: false,
    sessionsLoaded: true,
    error: null as string | null,
    fetchSessions: vi.fn(),
    clearError: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    statusFilter: 'all' as const,
    setStatusFilter: vi.fn(),
    sortField: 'activity' as const,
    sortDirection: 'desc' as const,
    toggleSort: vi.fn(),
    isSearchActive: false,
    showCreateModal: false,
    setShowCreateModal: vi.fn(),
    sessionToKill: null as Session | null,
    setSessionToKill: vi.fn(),
    handleSessionCreated: vi.fn(),
    handleSessionKilled: vi.fn(),
  },
}));

const attachChoice = vi.hoisted(() => ({
  mode: 'auto' as const,
  attachInfo: { mode: 'relay' as const, session_id: 'a1:fix' },
  orderedUrls: [] as string[],
  latencies: [] as never[],
  selectedUrl: null,
  relayUrl: null,
  renderer: 'canvas' as const,
  envRefs: [],
}));

vi.mock('@/hooks/useDashboard', () => ({
  useDashboard: () => dashboard.current,
}));
vi.mock('@/hooks/useProbePolling', () => ({
  useProbePolling: () => {},
}));
vi.mock('@/session-first/SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="session-first-terminal" />,
}));
vi.mock('@/session-first/workspace/tools/filesWeb', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
  FilesAppLayout: () => <div data-testid="file-workspace" />,
}));
vi.mock('@/components/CreateSessionDialog', () => ({
  CreateSessionDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-session-dialog" /> : null,
}));
vi.mock('@/components/KillConfirmDialog', () => ({
  KillConfirmDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="kill-session-dialog" /> : null,
}));
vi.mock('@/components/env/EnvManager', () => ({
  EnvManager: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="env-manager">
      <button type="button" onClick={() => onBack()}>Back</button>
    </div>
  ),
}));
vi.mock('@/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));
vi.mock('@/components/env/AttachDialog', () => ({
  AttachDialog: ({
    isOpen,
    onConfirm,
    session,
  }: {
    isOpen: boolean;
    onConfirm: (s: Session, c: typeof attachChoice) => void;
    session: Session | null;
  }) =>
    isOpen && session ? (
      <div data-testid="attach-dialog">
        <button
          type="button"
          data-testid="attach-confirm"
          onClick={() => onConfirm(session, attachChoice)}
        />
      </div>
    ) : null,
}));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    requestAttach: vi.fn(),
    beginRelay: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  }),
}));

const deepLink = vi.hoisted(() => ({
  isRestoringDeepLink: false,
  sessionIdFromUrl: null as string | null,
  restored: new Set<string>(),
}));

// Faithful to the real hook: a sessionIdFromUrl restores that session's
// selection (guarded so the render-phase restore runs once per id).
vi.mock('@/hooks/useSessionFirstDeepLink', () => ({
  useSessionFirstDeepLink: (opts: {
    sessions: Session[];
    onRestoreSession: (session: Session) => void;
  }) => {
    if (
      deepLink.sessionIdFromUrl &&
      !deepLink.restored.has(deepLink.sessionIdFromUrl)
    ) {
      deepLink.restored.add(deepLink.sessionIdFromUrl);
      const session = opts.sessions.find(
        (s) => s.session_id === deepLink.sessionIdFromUrl,
      );
      if (session) {
        opts.onRestoreSession(session);
      }
    }
    return {
      isRestoringDeepLink: deepLink.isRestoringDeepLink,
      sessionIdFromUrl: deepLink.sessionIdFromUrl,
    };
  },
}));

const mobileNav = vi.hoisted(() => ({
  showList: true,
  showDetail: true,
  openDetail: vi.fn(),
  openList: vi.fn(),
  isWide: true,
}));

vi.mock('@/hooks/useSessionFirstMobileNav', () => ({
  useSessionFirstMobileNav: () => mobileNav,
}));

function renderShell(initialEntry = '/') {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SessionFirstShell connectionStatus="authenticated" onLegacy={vi.fn()} />
      </MemoryRouter>
    </Provider>,
  );
  return { store, ...view };
}

describe('SessionFirstShell', () => {
  beforeEach(() => {
    deepLink.isRestoringDeepLink = false;
    deepLink.sessionIdFromUrl = null;
    deepLink.restored.clear();
    mobileNav.showList = true;
    mobileNav.showDetail = true;
    mobileNav.isWide = true;
    mobileNav.openDetail.mockClear();
    mobileNav.openList.mockClear();
    dashboard.current = {
      ...dashboard.current,
      agents: [agent],
      sessions: [sess],
      filteredSessions: [sess],
      staleAgents: [],
      showCreateModal: false,
      sessionToKill: null,
    };
  });

  it('applies session-first-shell class for light chrome lock', () => {
    renderShell();
    expect(screen.getByTestId('session-first-shell').className).toMatch(
      /session-first-shell/,
    );
  });

  it('applies data-sf-design polish token overlay on shell root', () => {
    renderShell();
    expect(screen.getByTestId('session-first-shell')).toHaveAttribute(
      'data-sf-design',
      'polish',
    );
  });

  it('applies safe-area padding to sidebar footer', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    const footer = screen.getByTestId('session-first-sidebar-footer');
    expect(footer.className).toMatch(
      /pb-\[max\(0\.5rem,env\(safe-area-inset-bottom\)\)\]/,
    );
    expect(footer.className).toMatch(/shell-space|var\(--shell-space/);
  });

  it('lists sessions in the drawer without an Agent card grid', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    expect(screen.queryByTestId('session-item-row')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    expect(screen.getByTestId('session-item-a1:fix')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
  });

  it('selects a session, defaults to Terminal, then Workspace Files and Agent', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByRole('heading', { name: 'Fix terminal reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByTestId('agent-detail')).toBeInTheDocument();
  });

  it('shows empty copy when there are no sessions', () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [],
      sessions: [],
      filteredSessions: [],
    };
    // No selection to restore with an empty list: enter via the mobile list
    // pane, where the drawer is open at rest.
    mobileNav.isWide = false;
    mobileNav.showList = true;
    mobileNav.showDetail = false;
    renderShell();
    expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
  });

  it('opens create dialog from sidebar header', async () => {
    dashboard.current = {
      ...dashboard.current,
      showCreateModal: true,
    };
    renderShell();
    expect(screen.getByTestId('create-session-dialog')).toBeInTheDocument();
  });

  it('opens kill dialog when setSessionToKill is triggered', () => {
    dashboard.current = {
      ...dashboard.current,
      sessionToKill: sess,
    };
    renderShell();
    expect(screen.getByTestId('kill-session-dialog')).toBeInTheDocument();
  });

  it('disables create when no online agents', async () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [{ ...agent, status: 'offline' }],
    };
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    expect(screen.getByTestId('session-first-create')).toBeDisabled();
  });

  it('opens env manager from sidebar footer overflow and returns on back', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(await screen.findByTestId('session-first-env'));
    expect(screen.getByTestId('env-manager')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('env-manager')).not.toBeInTheDocument();
  });

  it('renders without the global chrome bar', () => {
    renderShell();
    expect(screen.queryByTestId('session-first-chrome')).not.toBeInTheDocument();
    expect(screen.queryByText('Nession')).not.toBeInTheDocument();
  });

  it('shows inline dashboard error banner', async () => {
    dashboard.current = {
      ...dashboard.current,
      error: 'load failed',
    };
    renderShell();
    expect(screen.getByTestId('session-first-error')).toHaveTextContent('load failed');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(dashboard.current.clearError).toHaveBeenCalledTimes(1);
  });

  it('opens attach dialog when a session is selected', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByTestId('attach-dialog')).toBeInTheDocument();
  });

  it('writes sessionIdAtom when attach is confirmed', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await userEvent.click(screen.getByTestId('attach-confirm'));
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe('a1:fix');
    });
  });

  it('shows restoring copy while deep link attach is in progress', () => {
    deepLink.isRestoringDeepLink = true;
    renderShell('/terminal/a1%3Afix');
    expect(screen.getByText(/Restoring terminal session/i)).toBeInTheDocument();
    expect(screen.queryByTestId('session-item-a1:fix')).not.toBeInTheDocument();
  });

  it('calls openDetail when a session is selected', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(mobileNav.openDetail).toHaveBeenCalled();
  });

  it('shows back control that returns to the session list on mobile detail', async () => {
    mobileNav.isWide = true;
    mobileNav.showList = false;
    mobileNav.showDetail = true;
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await userEvent.click(screen.getByTestId('session-first-back-to-list'));
    expect(mobileNav.openList).toHaveBeenCalled();
  });

  it('mounts AppSpatialShell on mobile when a session is selected (no XOR back)', async () => {
    mobileNav.isWide = false;
    mobileNav.showList = true;
    mobileNav.showDetail = false;
    renderShell();
    expect(screen.queryByTestId('app-spatial-shell')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-back-to-list')).not.toBeInTheDocument();
  });

  it('does not mount AppSpatialShell on desktop after selecting a session', async () => {
    mobileNav.isWide = true;
    mobileNav.showList = true;
    mobileNav.showDetail = true;
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.queryByTestId('app-spatial-shell')).not.toBeInTheDocument();
  });
});
