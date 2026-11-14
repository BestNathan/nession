import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { toast } from 'sonner';
import { Shell } from '@/app/Shell';
import { sessionIdAtom } from '@/product/session/state';
import { leaseRuntimeAtPhase } from '@/test/leaseRuntime';
import { probeResultsAtom, type AgentProbe } from '@/product/agent/state';
import { buildOptionsFingerprint } from '@/platform/attach/sessionAttachProfile';
import { envApi } from '@/capabilities/env';
import { sessionsApi } from '@/product/session';
import type { Agent, AttachInfo, AttachMode, Session } from '@/types';

async function openSessionAction(
  id: string,
  action: 'settings' | 'kill',
): Promise<void> {
  await userEvent.click(screen.getByTestId(`session-actions-${id}`));
  const item = await screen.findByTestId(`session-actions-${action}-${id}`);
  await waitFor(() => expect(item).not.toHaveStyle({ pointerEvents: 'none' }));
  await userEvent.click(item);
}


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
/** Second Session on the same Agent, for the latest-intent ordering cases. */
const sessB: Session = {
  ...sess, session_id: 'a1:other', session_name: 'Other terminal',
};

// The mocked requestAttach response every flow in this file resolves to. Its
// stable options (mode + candidate urls) are what saved-profile fingerprints
// are validated against on the next attach.
const attachInfoResponse = {
  mode: 'p2p' as const,
  session_id: 'a1:fix',
  session_name: 'fix',
  agent_token: 'tok',
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
vi.mock('@/app/TerminalRegion', () => ({
  TerminalRegion: () => <div data-testid="terminal" />,
}));
vi.mock('@/app/experiences/web/FilesWebLayout', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
}));
vi.mock('@/app/experiences/web/EnvWebLayout', () => ({
  EnvWebLayout: () => <div data-testid="env-workspace" />,
}));
vi.mock('@/product/session/components/CreateSessionDialog', () => ({
  CreateSessionDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-session-dialog" /> : null,
}));
vi.mock('@/product/session/components/KillConfirmDialog', () => ({
  KillConfirmDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="kill-session-dialog" /> : null,
}));
vi.mock('@/platform/server/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// New-model core surface: the shell builds its relay handle via
// relayServerHandle(wsService), whose transport members delegate to
// onConnectionStateChange + connectionState (platform/attach/relayServerConnection.ts).
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
vi.mock('@/product/session', () => ({
  sessionsApi: {
    requestAttach: vi.fn(),
    // Rows read metadata through the same plugin (#2789); these cases never
    // exercise it, so the stub reports an unreachable answer and each row
    // keeps its tmux-name fallback.
    getMetadata: vi.fn(() =>
      Promise.resolve({ success: false, error_kind: 'unavailable', error: 'unused' }),
    ),
    connectionRevision: vi.fn(() => 0),
    onConnectionChange: vi.fn(() => () => {}),
  },
}));
// Partial mock — see CreateSessionDialog.test.tsx.
vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi: { listEnvFiles: vi.fn() },
}));

const mobileNav = vi.hoisted(() => ({
  showList: true,
  showDetail: true,
  openDetail: vi.fn(),
  openList: vi.fn(),
  isWide: true,
}));

vi.mock('@/app/useMobileNav', () => ({
  useMobileNav: () => mobileNav,
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
 *  fingerprint unless overridden. jsdom has no WebGL, so renderer is 'canvas'. */
function seedProfile(overrides: {
  mode?: AttachMode;
  fingerprint?: string;
  selectedUrl?: string | null;
} = {}, session: Session = sess) {
  const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  map[session.session_id] = {
    schemaVersion: 1,
    sessionId: session.session_id,
    agentId: session.agent_id,
    choice: {
      mode: overrides.mode ?? 'auto',
      renderer: 'canvas' as const,
      selectedUrl: overrides.selectedUrl ?? null,
    },
    optionsFingerprint: overrides.fingerprint ?? buildOptionsFingerprint(attachInfoResponse),
    updatedAt: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function storedProfile(session: Session = sess): {
  choice: { mode: string; renderer: string; selectedUrl: string | null };
  optionsFingerprint: string;
  updatedAt: number;
} {
  const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  return map[session.session_id];
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
        <Shell connectionStatus="connected" />
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
      choice: { mode: 'auto', renderer: 'canvas', selectedUrl: null },
      optionsFingerprint: buildOptionsFingerprint(attachInfoResponse),
    });
  });

  it('attaches through the saved profile without ever opening the dialog', async () => {
    seedProfile();
    const { store } = renderShell('/', { seedProbeCache: true });
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

  it('fast-paths attach when fingerprint is stale but auto intent still applies (#1186)', async () => {
    seedProfile({ fingerprint: 'stale-fp' });
    const { store } = renderShell('/', { seedProbeCache: true });
    await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog when a saved manual URL is no longer offered', async () => {
    seedProfile({ mode: 'relay', selectedUrl: 'ws://gone/ws' });
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(store.get(sessionIdAtom)).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('configure Save persists the new mode without attaching', async () => {
    seedProfile();
    const { store } = renderShell();
    await openSessionAction(sess.session_id, 'settings');
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
    await openSessionAction(sess.session_id, 'settings');
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
    await openSessionAction(sess.session_id, 'settings');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(storedProfile()).toEqual(before);
    expect(before.choice.selectedUrl).toBe('ws://a/ws');
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('restores into the dialog when a saved manual URL is gone; Cancel leaves the terminal route', async () => {
    seedProfile({ mode: 'relay', selectedUrl: 'ws://gone/ws' });
    const { store } = renderShell('/terminal/a1:fix');
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

  it('is a no-op when clicking the row of the already-attached healthy session', async () => {
    seedProfile();
    const { store } = renderShell('/', { seedProbeCache: true });
    store.set(sessionIdAtom, sess.session_id);
    // The healthy phase is a runtime fact (#1309): the row-click guard reads
    // it back from the registry, so a live attached runtime is what stands in
    // for "the terminal is up".
    const release = leaseRuntimeAtPhase(sess.session_id, 'attached');
    try {
      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      // Healthy attached terminal: the row click must NOT re-enter the profile
      // fast path (a re-attach would bump the route epoch and tear down the live
      // runtime, #668 class) and must not open the dialog either — a fast-path
      // regression would show up as one resolver-style requestAttach call.
      expect(mockedSessionsApi.requestAttach).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    } finally {
      release();
    }
  });

  it('opens the dialog when clicking the row of the already-attached failed session', async () => {
    seedProfile();
    const { store } = renderShell('/', { seedProbeCache: true });
    store.set(sessionIdAtom, sess.session_id);
    const release = leaseRuntimeAtPhase(sess.session_id, 'failed');
    try {
      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      // A failed terminal: recovery stays an explicit user action — the dialog
      // opens for re-confirmation instead of a silent auto-attach.
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
      await waitFor(() => expect(attachBtn).toBeEnabled());
      // Nothing auto-attached: the only attach-info fetch is the dialog's own
      // (3-arg signature, pinned in the first test) — the fast-path resolver's
      // 2-arg call never ran — and sessionIdAtom still names the session.
      expect(mockedSessionsApi.requestAttach).toHaveBeenCalledTimes(1);
      expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith(
        sess.session_id,
        'p2p',
        undefined,
      );
      expect(store.get(sessionIdAtom)).toBe(sess.session_id);
    } finally {
      release();
    }
  });

  /**
   * #2873: two Session selections can each have a pending profile validation.
   * Only the flight that still owns the intent may commit — an older
   * resolution must not attach, open a dialog, or toast over the newer one.
   * The deferred attach-info promises make the resolution order explicit; no
   * timing sleeps decide the outcome.
   */
  describe('latest-intent attach ownership (#2873)', () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason?: unknown) => void;
    };

    function deferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    /** One deferred attach-info reply per `requestAttach` call, in order. */
    function gatedAttach(): Deferred<AttachInfo>[] {
      const calls: Deferred<AttachInfo>[] = [];
      mockedSessionsApi.requestAttach.mockImplementation(() => {
        const call = deferred<AttachInfo>();
        calls.push(call);
        return call.promise;
      });
      return calls;
    }

    function attachInfoFor(session: Session): AttachInfo {
      return {
        ...attachInfoResponse,
        session_id: session.session_id,
        session_name: session.session_name,
      };
    }

    function bothSessions(): void {
      dashboard.current = {
        ...dashboard.current,
        sessions: [sess, sessB],
        filteredSessions: [sess, sessB],
      };
    }

    function routePath(): string {
      return screen.getByTestId('route-path').textContent ?? '';
    }

    /** The attach navigation is a router transition; wait for it to land. */
    async function expectRoute(session: Session): Promise<void> {
      await waitFor(() => {
        expect(decodeURIComponent(routePath())).toBe(`/terminal/${session.session_id}`);
      });
    }

    /** Let every queued promise continuation run before asserting absence. */
    async function flushMicrotasks(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    beforeEach(() => {
      vi.mocked(toast.error).mockClear();
    });

    it('SC-01 keeps the newer B selection when stale A resolves afterwards', async () => {
      seedProfile();
      seedProfile({}, sessB);
      bothSessions();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      await userEvent.click(screen.getByTestId(`session-item-${sessB.session_id}`));
      expect(calls).toHaveLength(2);

      // B validates and attaches first.
      calls[1].resolve(attachInfoFor(sessB));
      await waitFor(() => expect(store.get(sessionIdAtom)).toBe(sessB.session_id));
      await expectRoute(sessB);

      // A's older validation now resolves. It must not steal the selection.
      calls[0].resolve(attachInfoFor(sess));
      await flushMicrotasks();

      expect(store.get(sessionIdAtom)).toBe(sessB.session_id);
      await expectRoute(sessB);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
      // The stale result never confirmed A: its persisted profile is untouched.
      expect(storedProfile(sess).updatedAt).toBe(1);
    });

    it('SC-01 does not open a stale A dialog after B attaches', async () => {
      // A's stored manual URL is absent from the fresh candidates, so its
      // resolution is a dialog request rather than a choice.
      seedProfile({ mode: 'relay', selectedUrl: 'ws://gone/ws' });
      seedProfile({}, sessB);
      bothSessions();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      await userEvent.click(screen.getByTestId(`session-item-${sessB.session_id}`));
      calls[1].resolve(attachInfoFor(sessB));
      await waitFor(() => expect(store.get(sessionIdAtom)).toBe(sessB.session_id));

      calls[0].resolve(attachInfoFor(sess));
      await flushMicrotasks();

      expect(store.get(sessionIdAtom)).toBe(sessB.session_id);
      await expectRoute(sessB);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('SC-01 does not surface a stale A failure after B attaches', async () => {
      seedProfile();
      seedProfile({}, sessB);
      bothSessions();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      await userEvent.click(screen.getByTestId(`session-item-${sessB.session_id}`));
      calls[1].resolve(attachInfoFor(sessB));
      await waitFor(() => expect(store.get(sessionIdAtom)).toBe(sessB.session_id));

      calls[0].reject(new Error('attach info request failed'));
      await flushMicrotasks();

      expect(toast.error).not.toHaveBeenCalled();
      expect(store.get(sessionIdAtom)).toBe(sessB.session_id);
      await expectRoute(sessB);
    });

    it('SC-02 A→B→A attaches the latest A flight and older completions keep its guard', async () => {
      seedProfile();
      seedProfile({}, sessB);
      bothSessions();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`)); // A (1)
      await userEvent.click(screen.getByTestId(`session-item-${sessB.session_id}`)); // B (2)
      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`)); // A (3)
      expect(calls).toHaveLength(3);

      // B's flight is stale the moment the third (A) flight starts.
      calls[1].resolve(attachInfoFor(sessB));
      await flushMicrotasks();
      expect(store.get(sessionIdAtom)).toBe('');

      // The first A flight is stale too, and its `finally` must not clear the
      // third flight's guard: clicking A again is still a double click.
      calls[0].resolve(attachInfoFor(sess));
      await flushMicrotasks();
      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      expect(calls).toHaveLength(3);

      calls[2].resolve(attachInfoFor(sess));
      await waitFor(() => expect(store.get(sessionIdAtom)).toBe(sess.session_id));
      await expectRoute(sess);
    });

    it('SC-02 a same-Session double click runs one validation and attaches once', async () => {
      seedProfile();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      expect(calls).toHaveLength(1);

      calls[0].resolve(attachInfoFor(sess));
      await waitFor(() => expect(store.get(sessionIdAtom)).toBe(sess.session_id));
      expect(mockedSessionsApi.requestAttach).toHaveBeenCalledTimes(1);
    });

    it('SC-02 an explicit configure dialog is not overwritten by a stale fast path', async () => {
      seedProfile();
      seedProfile({}, sessB);
      bothSessions();
      const calls = gatedAttach();
      const { store } = renderShell('/', { seedProbeCache: true });

      await userEvent.click(screen.getByTestId(`session-item-${sess.session_id}`));
      expect(calls).toHaveLength(1);

      // Opening Settings is explicit intent and revokes A's pending validation.
      await openSessionAction(sessB.session_id, 'settings');
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      calls[0].resolve(attachInfoFor(sess));
      await flushMicrotasks();

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(store.get(sessionIdAtom)).toBe('');
    });
  });
});
