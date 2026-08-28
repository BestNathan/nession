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
vi.mock('@/session-first/patterns/FileWorkspace', () => ({
  FileWorkspace: () => <div data-testid="file-workspace" />,
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
vi.mock('@/session-first/SessionFirstChrome', () => ({
  SessionFirstChrome: ({
    onOpenEnv,
    error,
  }: {
    onOpenEnv: () => void;
    error: string | null;
  }) => (
    <div data-testid="session-first-chrome">
      {error ? <div data-testid="session-first-error">{error}</div> : null}
      <button type="button" data-testid="session-first-env" onClick={() => onOpenEnv()} />
    </div>
  ),
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
  useWebSocket: () => ({ requestAttach: vi.fn() }),
}));

const deepLink = vi.hoisted(() => ({
  isRestoringDeepLink: false,
  sessionIdFromUrl: null as string | null,
}));

vi.mock('@/hooks/useSessionFirstDeepLink', () => ({
  useSessionFirstDeepLink: () => deepLink,
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

  it('lists sessions without an Agent card grid', () => {
    renderShell();
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
  });

  it('selects a session, defaults to Terminal, then Workspace Files and Agent', async () => {
    renderShell();
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

  it('disables create when no online agents', () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [{ ...agent, status: 'offline' }],
    };
    renderShell();
    expect(screen.getByTestId('session-first-create')).toBeDisabled();
  });

  it('opens env manager from chrome and returns on back', async () => {
    renderShell();
    await userEvent.click(screen.getByTestId('session-first-env'));
    expect(screen.getByTestId('env-manager')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('env-manager')).not.toBeInTheDocument();
  });

  it('shows dashboard error via chrome', () => {
    dashboard.current = {
      ...dashboard.current,
      error: 'load failed',
    };
    renderShell();
    expect(screen.getByTestId('session-first-error')).toHaveTextContent('load failed');
  });

  it('opens attach dialog when a session is selected', async () => {
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByTestId('attach-dialog')).toBeInTheDocument();
  });

  it('writes sessionIdAtom when attach is confirmed', async () => {
    const { store } = renderShell();
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
});
