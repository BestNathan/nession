import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { SessionFirstShell } from '@/app/SessionFirstShell';
import { sessionIdAtom } from '@/atoms/session';
import { probeResultsAtom, type AgentProbe } from '@/atoms/probe';
import { buildOptionsFingerprint } from '@/services/sessionAttachProfile';
import { envApi } from '@/features/env';
import { sessionsApi } from '@/features/sessions';
import type { Agent, AttachMode, Session } from '@/types';

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

// The mocked requestAttach response every flow in this file resolves to. Its
// stable options (mode + candidate urls) are what saved-profile fingerprints
// are validated against on the next attach.
const attachInfoResponse = {
  mode: 'p2p' as const,
  session_id: 'a1:fix',
  session_name: 'fix',
  connection_token: 'tok',
  agent_address: 'ws://a/ws',
  addresses: [{
    url: 'ws://a/ws', label: 'lan', network_type: 'lan' as const,
    priority: 0, status: 'reachable' as const,
  }],
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

vi.mock('@/app/useDashboard', () => ({
  useDashboard: () => dashboard.current,
}));
vi.mock('@/app/useProbePolling', () => ({
  useProbePolling: () => {},
}));
vi.mock('@/app/SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="session-first-terminal" />,
}));
vi.mock('@/app/workspace/tools/filesWeb', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
  FilesAppLayout: () => <div data-testid="file-workspace" />,
}));
vi.mock('@/features/env/components/EnvManager', () => ({
  EnvManager: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="env-manager" data-embedded={embedded ? 'true' : 'false'} />
  ),
}));
vi.mock('@/features/sessions/components/CreateSessionDialog', () => ({
  CreateSessionDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-session-dialog" /> : null,
}));
vi.mock('@/features/sessions/components/KillConfirmDialog', () => ({
  KillConfirmDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="kill-session-dialog" /> : null,
}));
vi.mock('@/features/server/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
}));
// New-model core surface: the shell builds its relay handle via
// relayServerHandle(wsService), whose transport members delegate to
// onConnectionStateChange + connectionState (runtime/relayServerConnection.ts).
// 'connected' mirrors the shell's post-handshake render state.
vi.mock('@/shared/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connectionState: 'connected',
    onConnectionStateChange: vi.fn(() => () => {}),
    // Legacy facade members some in-flight consumers still consult; inert
    // shims that disappear once those land on the new core.
    requestAttach: vi.fn(),
    beginRelay: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  }),
}));
// Data sources behind the REAL AttachDialog and the profile resolver: the
// attach-info request and the env-file list never touch the socket singleton.
vi.mock('@/features/sessions', () => ({
  sessionsApi: { requestAttach: vi.fn() },
}));
vi.mock('@/features/env', () => ({
  envApi: { listEnvFiles: vi.fn() },
}));

const mobileNav = vi.hoisted(() => ({
  showList: true,
  showDetail: true,
  openDetail: vi.fn(),
  openList: vi.fn(),
  isWide: true,
}));

vi.mock('@/app/useSessionFirstMobileNav', () => ({
  useSessionFirstMobileNav: () => mobileNav,
}));

const mockedSessionsApi = vi.mocked(sessionsApi);
const mockedEnvApi = vi.mocked(envApi);

// Probe cache entry for agent 'a1'. resolveTargetChoice cold-cache fallback
// would run a LIVE testAddresses probe — never in jsdom — so fast-path and
// valid-restore tests seed this cache and take the cached ordering branch.
function probeCache(): Map<string, AgentProbe> {
  return new Map([[
    'a1',
    { latencies: [], orderedUrls: ['ws://a/ws'], probedAt: Date.now() },
  ]]);
}

const STORAGE_KEY = 'nession_session_attach_profiles';

/** Seed a profile for the fixture session, matching the mocked attach-info
 *  fingerprint unless overridden. jsdom has no WebGL, so renderer is 'canvas'
 *  (a 'webgl' profile would fail validation on the renderer check). */
function seedProfile(overrides: {
  mode?: AttachMode;
  fingerprint?: string;
  selectedUrl?: string | null;
} = {}) {
  const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  map[sess.session_id] = {
    schemaVersion: 1,
    sessionId: sess.session_id,
    agentId: sess.agent_id,
    choice: {
      mode: overrides.mode ?? 'auto',
      renderer: 'canvas' as const,
      envRefs: [],
      selectedUrl: overrides.selectedUrl ?? null,
    },
    optionsFingerprint: overrides.fingerprint ?? buildOptionsFingerprint(attachInfoResponse),
    updatedAt: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function storedProfile(): {
  choice: { mode: string; renderer: string; selectedUrl: string | null };
  optionsFingerprint: string;
  updatedAt: number;
} {
  const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  return map[sess.session_id];
}

/** Reports the current pathname so router navigation is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="route-path">{location.pathname}</span>;
}

function renderShell(initialEntry = '/', opts: { seedProbeCache?: boolean } = {}) {
  const store = createStore();
  if (opts.seedProbeCache) {
    // Seeded BEFORE render: fast-path / restore code reads the atom (or a ref
    // holding this render's value) synchronously when its effect fires.
    store.set(probeResultsAtom, probeCache());
  }
  const view = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SessionFirstShell connectionStatus="connected" />
        <LocationProbe />
      </MemoryRouter>
    </Provider>,
  );
  return { store, ...view };
}

describe('session attach flow (real shell + real AttachDialog)', () => {
  beforeEach(() => {
    localStorage.clear();
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
    mockedSessionsApi.requestAttach.mockReset();
    // Production echoes the requested mode back, and the persisted fingerprint
    // encodes [mode, candidates] — a mock that always answered 'p2p' would let
    // a requested-mode regression (the dialog or resolver always asking 'p2p')
    // pass here while production reopened the dialog on the next attach. Auto
    // flows request 'p2p' (requestedModeOf / dialog auto→p2p) so tests 1–3 and
    // 5–7 keep resolving p2p-shaped info; only test 4's relay Save stores a
    // relay-shaped fingerprint (nothing asserts it — it stops at mode 'relay').
    mockedSessionsApi.requestAttach.mockImplementation(
      // Signature mirrors the real requestAttach (mode defaults to 'p2p').
      async (_sessionId: string, mode?: 'p2p' | 'relay') => ({
        ...attachInfoResponse,
        mode: mode ?? 'p2p',
      }),
    );
    mockedEnvApi.listEnvFiles.mockReset();
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [] });
  });

  it('opens the dialog for a first attach; confirming persists a profile and attaches', async () => {
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
    // The REAL dialog fetches attach info on open; Attach enables once it lands.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith(sess.session_id, 'p2p', undefined);
    await userEvent.click(attachBtn);
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    });
    // The explicit confirm persisted a per-session profile whose fingerprint
    // matches the fresh options — the next attach can fast-path.
    expect(storedProfile()).toMatchObject({
      schemaVersion: 1,
      sessionId: sess.session_id,
      agentId: sess.agent_id,
      choice: { mode: 'auto', renderer: 'canvas', envRefs: [], selectedUrl: null },
      optionsFingerprint: buildOptionsFingerprint(attachInfoResponse),
    });
  });

  it('attaches through the saved profile without ever opening the dialog', async () => {
    seedProfile();
    const { store } = renderShell('/', { seedProbeCache: true });
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    });
    // Fast path: one attach-info fetch (the resolver's — which calls
    // requestAttach with the mode only, no trailing undefined), never the dialog.
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledTimes(1);
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith(sess.session_id, 'p2p');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog for a stale profile and never auto-attaches', async () => {
    seedProfile({ fingerprint: 'stale-fp' });
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
    // Profile failed validation (fingerprint mismatch) → the dialog reopens.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(store.get(sessionIdAtom)).toBe('');
    // Cancelling must not attach either.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('configure Save persists the new mode without attaching', async () => {
    seedProfile();
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    const saveBtn = await screen.findByRole('button', { name: /^Save$/ });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    // Configure mode never offers Attach.
    expect(screen.queryByRole('button', { name: /^Attach$/ })).not.toBeInTheDocument();
    // Switch to Relay: the mode change refetches attach info (Save disables
    // until the mocked response lands). The requested mode must echo back as
    // 'relay' — a requested-mode derivation that always asked 'p2p' would save
    // a relay profile under a p2p fingerprint and reopen the dialog next time.
    await userEvent.click(screen.getByRole('button', { name: /^Relay/ }));
    await waitFor(() =>
      expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith(sess.session_id, 'relay', undefined),
    );
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await userEvent.click(saveBtn);
    // Saved, not attached. The dialog exit animation keeps the content mounted
    // briefly after the atom clears, so wait for it to leave the document.
    expect(store.get(sessionIdAtom)).toBe('');
    expect(storedProfile().choice.mode).toBe('relay');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('Cancel from configure leaves the saved profile unchanged', async () => {
    seedProfile({ mode: 'p2p' });
    const before = storedProfile();
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(storedProfile()).toEqual(before);
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('Cancel from configure leaves a saved manual URL untouched', async () => {
    // Manual path is a real candidate in attachInfoResponse, so the dialog
    // prefill would offer it — but opening the dialog must never persist
    // anything, and Cancel must leave the stored manual URL bit-for-bit
    // intact (the persistable field no end-to-end flow otherwise writes).
    seedProfile({ mode: 'p2p', selectedUrl: 'ws://a/ws' });
    const before = storedProfile();
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(storedProfile()).toEqual(before);
    expect(before.choice.selectedUrl).toBe('ws://a/ws');
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('restores into the dialog for a stale profile; Cancel leaves the terminal route', async () => {
    seedProfile({ fingerprint: 'stale-fp' });
    const { store } = renderShell('/terminal/a1:fix');
    // The stale profile opens the dialog instead of attaching; the restore
    // spinner is gone once the dialog owns the screen.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(store.get(sessionIdAtom)).toBe('');
    expect(screen.queryByText(/Restoring terminal session/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Nothing attached and the router left the terminal route (a replace to
    // '/', not a push that could re-fire the restore effect).
    expect(store.get(sessionIdAtom)).toBe('');
    await waitFor(() => {
      expect(screen.getByTestId('route-path')).toHaveTextContent('/');
    });
  });

  it('restores through a valid profile immediately, without a dialog', async () => {
    seedProfile();
    const { store } = renderShell('/terminal/a1:fix', { seedProbeCache: true });
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    });
    // One attach-info fetch (the profile resolver's) — the dialog never opened.
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Restoring terminal session/i)).not.toBeInTheDocument();
  });
});
