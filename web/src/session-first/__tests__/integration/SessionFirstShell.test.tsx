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
    error: null,
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
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ requestAttach: vi.fn() }),
}));
vi.mock('@/services/deepLinkAttach', () => ({
  resolveDeepLinkAttachChoice: vi.fn(),
}));

import { resolveDeepLinkAttachChoice } from '@/services/deepLinkAttach';

const attachChoice = {
  mode: 'auto' as const,
  attachInfo: { mode: 'relay' as const, session_id: 'a1:fix' },
  orderedUrls: [] as string[],
  latencies: [] as never[],
  selectedUrl: null,
  relayUrl: null,
  renderer: 'canvas' as const,
  envRefs: [],
};

function renderShell() {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <SessionFirstShell onLegacy={vi.fn()} />
      </MemoryRouter>
    </Provider>,
  );
  return { store, ...view };
}

const sessB: Session = {
  ...sess,
  session_id: 'a1:other',
  session_name: 'Other session',
};

describe('SessionFirstShell', () => {
  beforeEach(() => {
    vi.mocked(resolveDeepLinkAttachChoice).mockReset();
    vi.mocked(resolveDeepLinkAttachChoice).mockResolvedValue(attachChoice);
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

  it('attaches via resolveDeepLinkAttachChoice and writes sessionIdAtom', async () => {
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await waitFor(() => {
      expect(resolveDeepLinkAttachChoice).toHaveBeenCalledWith(
        expect.anything(),
        sess,
        expect.any(Map),
      );
    });
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe('a1:fix');
    });
  });

  it('shows Attach failed and does not write sessionIdAtom when resolve throws', async () => {
    vi.mocked(resolveDeepLinkAttachChoice).mockRejectedValueOnce(new Error('nope'));
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await waitFor(() => {
      expect(screen.getByText('Attach failed')).toBeInTheDocument();
    });
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('ignores a slower first attach after a later selection', async () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [agent],
      sessions: [sess, sessB],
      filteredSessions: [sess, sessB],
    };
    let resolveA: (value: typeof attachChoice) => void = () => undefined;
    const promiseA = new Promise<typeof attachChoice>((resolve) => {
      resolveA = resolve;
    });
    vi.mocked(resolveDeepLinkAttachChoice)
      .mockReturnValueOnce(promiseA)
      .mockResolvedValueOnce(attachChoice);

    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await userEvent.click(screen.getByTestId('session-item-a1:other'));
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe('a1:other');
    });
    resolveA(attachChoice);
    await promiseA;
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe('a1:other');
    });
    expect(store.get(sessionIdAtom)).not.toBe('a1:fix');
  });
});
