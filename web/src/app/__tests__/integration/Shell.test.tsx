import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { Shell } from '@/app/Shell';
import { sessionIdAtom } from '@/product/session/state';
import { toast } from 'sonner';
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

vi.mock('@/app/useDashboard', () => ({
  useDashboard: () => dashboard.current,
}));
vi.mock('@/app/useProbePolling', () => ({
  useProbePolling: () => {},
}));
vi.mock('@/app/TerminalRegion', () => ({
  TerminalRegion: () => <div data-testid="terminal" />,
}));
vi.mock('@/app/experiences/web/FilesWebLayout', () => ({
  FilesWebLayout: () => <div data-testid="file-workspace" />,
}));
vi.mock('@/capabilities/env/components/EnvManager', () => ({
  EnvManager: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="env-manager" data-embedded={embedded ? 'true' : 'false'} />
  ),
}));
vi.mock('@/product/session/components/CreateSessionDialog', () => ({
  // The stub exposes what the real dialog hands over on success — the created
  // Session's id (#1082) — so the composition that consumes it can be tested
  // here rather than only in the dialog's own suite, where the consumer does
  // not exist.
  CreateSessionDialog: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean;
    onCreated: (sessionId?: string) => void;
  }) =>
    isOpen ? (
      <div data-testid="create-session-dialog">
        <button
          type="button"
          data-testid="create-session-submit"
          onClick={() => onCreated('a1:created')}
        />
      </div>
    ) : null,
}));
vi.mock('@/product/session/components/KillConfirmDialog', () => ({
  KillConfirmDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="kill-session-dialog" /> : null,
}));
vi.mock('@/capabilities/env/components/EnvManager', () => ({
  EnvManager: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="env-manager">
      <button type="button" onClick={() => onBack()}>Back</button>
    </div>
  ),
}));
vi.mock('@/platform/server/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));
vi.mock('@/product/session/components/AttachDialog', () => ({
  AttachDialog: ({
    isOpen,
    onConfirm,
    session,
    intent = 'attach',
  }: {
    isOpen: boolean;
    onConfirm: (s: Session, c: typeof attachChoice) => void;
    session: Session | null;
    intent?: string;
  }) =>
    isOpen && session ? (
      <div data-testid="attach-dialog">
        <span data-testid="attach-dialog-intent">{intent}</span>
        <button
          type="button"
          data-testid="attach-confirm"
          onClick={() => onConfirm(session, attachChoice)}
        />
      </div>
    ) : null,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
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

const deepLink = vi.hoisted(() => ({
  isRestoringDeepLink: false,
  sessionIdFromUrl: null as string | null,
  restored: new Set<string>(),
}));

// Faithful to the real hook: a sessionIdFromUrl restores that session's
// selection (guarded so the render-phase restore runs once per id).
vi.mock('@/app/useDeepLink', () => ({
  useDeepLink: (opts: {
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

vi.mock('@/app/useMobileNav', () => ({
  useMobileNav: () => mobileNav,
}));

function renderShell(initialEntry = '/') {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Shell connectionStatus="connected" />
      </MemoryRouter>
    </Provider>,
  );
  return { store, ...view };
}

/**
 * Open More and pick a progressively disclosed Workspace capability.
 *
 * Base UI keeps one popup node mounted across open/close and holds it inert
 * (`pointer-events: none`) until the open transition settles, so a click issued
 * the moment the item appears can land on a menu that is still animating in.
 * Wait for the popup to actually be interactive rather than sleeping.
 */
async function clickDisclosedCapability(name: string) {
  await userEvent.click(screen.getByTestId('workspace-capability-more'));
  const item = await screen.findByRole('menuitem', { name });
  await waitFor(() => {
    expect(item).not.toHaveStyle({ pointerEvents: 'none' });
  });
  await userEvent.click(item);
}

describe('Shell', () => {
  beforeEach(() => {
    // confirmAttach persists per-Session attach profiles on confirm; clear
    // them so a confirm in one test cannot seed the next test's dialog-vs-fast-path.
    localStorage.clear();
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

  it('applies shell class for light chrome lock', () => {
    renderShell();
    expect(screen.getByTestId('shell').className).toMatch(
      /shell/,
    );
  });

  it('applies data-sf-design polish token overlay on shell root', () => {
    renderShell();
    expect(screen.getByTestId('shell')).toHaveAttribute(
      'data-sf-design',
      'polish',
    );
  });

  it('applies safe-area padding to sidebar footer', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    const footer = screen.getByTestId('sidebar-footer');
    // The floor is the foot's own token, so the inset still wins on a device
    // that has one and the padding stays on the design system's scale where it
    // does not.
    expect(footer.className).toMatch(
      /pb-\[max\(var\(--shell-foot-pad-y\),env\(safe-area-inset-bottom\)\)\]/,
    );
    expect(footer.className).toMatch(/shell-space|var\(--shell-space/);
  });

  it('lists sessions in the sidebar column, without an Agent card grid', () => {
    // Wide is two columns now, so the rows are present without opening anything.
    // The Agents section reports infrastructure; it is still not a card grid and
    // Sessions are still not filed under their Agent.
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    expect(screen.getByTestId('sidebar-column')).toBeInTheDocument();
    expect(screen.getByTestId('session-item-a1:fix')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-agents')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-grid')).not.toBeInTheDocument();
  });

  it('selects a session, defaults to Terminal, then switches Workspace capabilities from More', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    // No header heading any more — Session identity is the selected row.
    expect(screen.getByTestId('session-item-a1:fix')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    // Files is the default opened capability, but this shell has no file ops
    // (relay-only), so it holds a stable explanatory state rather than a dead
    // slot or an arbitrary switch to another registered capability.
    expect(screen.getByTestId('workspace-capability-unavailable')).toHaveTextContent(
      'Files is not available here',
    );

    // Available capabilities are progressively disclosed instead of parked in
    // permanent chrome.
    await clickDisclosedCapability('Agent');
    expect(screen.getByTestId('agent-detail')).toBeInTheDocument();

    await clickDisclosedCapability('Claude Code');
    expect(screen.getByTestId('claude-code-workspace')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-detail')).not.toBeInTheDocument();
  });

  it('shows empty copy when there are no sessions', () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [],
      sessions: [],
      filteredSessions: [],
    };
    // At wide this is the Web frame: the empty line sits beside the sidebar's
    // own list copy. The narrow case is the App's home, and is its own test
    // (#1082) — it no longer renders this line at all.
    renderShell();
    expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
  });

  it('gives the no-session App root a home with an action instead of a status line (#1082)', () => {
    dashboard.current = {
      ...dashboard.current,
      // The shared fixture Agent is offline; this case is the one where
      // creation can succeed.
      agents: [{ ...agent, status: 'online' }],
      sessions: [],
      filteredSessions: [],
    };
    mobileNav.isWide = false;
    renderShell();

    // The screen the issue was filed about: it used to say "Select a session to
    // start working" and offer nothing — and once the Sessions drawer was
    // dismissed there was no way back to one either.
    expect(screen.queryByTestId('session-empty-state')).not.toBeInTheDocument();
    const home = screen.getByTestId('app-home');
    expect(home).toBeInTheDocument();

    // The primary action is on the screen, named the way the control it opens
    // is named everywhere, and it is the *enabled* case here: an Agent is
    // online.
    expect(screen.getByTestId('app-home-new-session')).toBeEnabled();
    expect(screen.getByText('New Session')).toBeInTheDocument();
    expect(screen.queryByTestId('app-home-no-agent')).not.toBeInTheDocument();

    // Both routes out are visible controls, not gestures: Sessions in the
    // header, and Browse on the surface.
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-home-browse-sessions')).toBeInTheDocument();

    // Workspace is the depth around a piece of work; there is none yet.
    expect(screen.queryByTestId('app-header-workspace')).not.toBeInTheDocument();
  });

  it('disables the home action and says why when no Agent is online (#1082)', () => {
    dashboard.current = {
      ...dashboard.current,
      agents: [{ ...agent, status: 'offline' }],
      sessions: [],
      filteredSessions: [],
    };
    mobileNav.isWide = false;
    renderShell();

    // A disabled control with no explanation is the dead end one click earlier:
    // the user cannot tell whether to wait, retry, or add an Agent.
    expect(screen.getByTestId('app-home-new-session')).toBeDisabled();
    expect(screen.getByTestId('app-home-no-agent')).toHaveTextContent(
      'No online Agent available',
    );
    // The route to existing work is unaffected — it is not the thing that is
    // unavailable.
    expect(screen.getByTestId('app-home-browse-sessions')).toBeEnabled();
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

  /**
   * The row's Kill action — now inside the `…` menu below `lg` (#1050 stage 2)
   * — has to reach the confirmation, not the kill. `setSessionToKill` is the
   * seam: typing the Session's name is what unlocks the destructive button, and
   * a row that killed directly would bypass it.
   *
   * The dashboard is mocked here, so the mock writes the field the real
   * `useDashboardModals` state owns and the Shell is re-rendered on the result
   * — the `sessionToKill !== null` that `ShellDialogs` turns into the dialog.
   * What this adds over `opens kill dialog` above is the half that test cannot
   * see: that the row routes to that state at all.
   */
  it('routes the row overflow Kill action to the kill confirmation', async () => {
    const setSessionToKill = vi.fn((killed: Session | null) => {
      dashboard.current = { ...dashboard.current, sessionToKill: killed };
    });
    dashboard.current = {
      ...dashboard.current,
      agents: [agent],
      sessions: [sess],
      filteredSessions: [sess],
      staleAgents: [],
      sessionToKill: null,
      setSessionToKill,
    };
    const view = renderShell();
    expect(screen.queryByTestId('kill-session-dialog')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByTestId(`session-actions-${sess.session_id}`),
    );
    const kill = await screen.findByTestId(
      `session-actions-kill-${sess.session_id}`,
    );
    await waitFor(() => {
      expect(kill).not.toHaveStyle({ pointerEvents: 'none' });
    });
    await userEvent.click(kill);

    expect(setSessionToKill).toHaveBeenCalledWith(sess);
    expect(dashboard.current.sessionToKill).toEqual(sess);

    view.unmount();
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
    expect(screen.getByTestId('create-session')).toBeDisabled();
  });

  it('opens env files from workspace dock when a session is selected', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    await clickDisclosedCapability('Env');
    expect(screen.getByTestId('env-manager')).toBeInTheDocument();
  });

  it('renders without the global chrome bar', () => {
    renderShell();
    expect(screen.queryByTestId('shell-chrome')).not.toBeInTheDocument();
    expect(screen.queryByText('Nession')).not.toBeInTheDocument();
  });

  it('shows inline dashboard error banner', async () => {
    dashboard.current = {
      ...dashboard.current,
      error: 'load failed',
    };
    renderShell();
    expect(screen.getByTestId('shell-error')).toHaveTextContent('load failed');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(dashboard.current.clearError).toHaveBeenCalledTimes(1);
  });

  it('opens attach dialog when a session is selected', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.getByTestId('attach-dialog')).toBeInTheDocument();
  });

  it('writes sessionIdAtom when attach is confirmed', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    await userEvent.click(screen.getByTestId('attach-confirm'));
    await waitFor(() => {
      expect(store.get(sessionIdAtom)).toBe('a1:fix');
    });
  });

  it('routes the configure action to a configure-intent dialog whose Save persists without attaching', async () => {
    deepLink.sessionIdFromUrl = sess.session_id;
    const { store } = renderShell();
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    expect(screen.getByTestId('attach-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('attach-dialog-intent')).toHaveTextContent('configure');
    // The Save-equivalent confirm must route to the configure handler (persist
    // the profile, close the dialog) — never to attach.
    await userEvent.click(screen.getByTestId('attach-confirm'));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Attach settings saved — applies to the next attach');
    expect(store.get(sessionIdAtom)).toBe('');
    expect(screen.queryByTestId('attach-dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem('nession_session_attach_profiles')).toContain(sess.session_id);
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
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(mobileNav.openDetail).toHaveBeenCalled();
  });

  // The Web back-to-list control is gone with the header (#748). Web never
  // needed one: at wide the sidebar is a column, and below `lg` a selected
  // Session hands off to the App's layer composition, which carries its own nav.

  it('mounts the App layer composition on mobile, before and after selecting (no XOR back)', async () => {
    mobileNav.isWide = false;
    mobileNav.showList = true;
    mobileNav.showDetail = false;
    renderShell();
    // Present from the start since #1082 — the composition is the experience,
    // not a reward for having selected something. Selecting then swaps what the
    // Terminal layer holds (the home for the session's terminal) without
    // remounting the composition around it.
    expect(screen.getByTestId('app-layer-root')).toBeInTheDocument();
    expect(screen.getByTestId('app-home')).toBeInTheDocument();

    // The rows live in the Sessions layer, which is closed at rest. That is the
    // journey now: the header's affordance opens it, exactly as a user without
    // a Session reaches their existing work.
    await userEvent.click(screen.getByTestId('app-header-sessions'));
    await userEvent.click(await screen.findByTestId('session-item-a1:fix'));

    expect(screen.getByTestId('app-layer-root')).toBeInTheDocument();
    // The Terminal layer now holds the Session's terminal instead of the home.
    expect(screen.queryByTestId('app-home')).not.toBeInTheDocument();
    expect(screen.queryByTestId('back-to-list')).not.toBeInTheDocument();
  });

  it('makes the created Session current from the id the dialog returned (#1082)', async () => {
    const created: Session = {
      session_id: 'a1:created',
      agent_id: 'a1',
      session_name: 'Fresh work',
      status: 'active',
      window_count: 1,
      attached_clients: 0,
      last_activity: new Date().toISOString(),
    };
    dashboard.current = {
      ...dashboard.current,
      agents: [{ ...agent, status: 'online' }],
      sessions: [],
      filteredSessions: [],
      showCreateModal: true,
      // Creating refreshes the lists, and the new Session arrives with the
      // refresh — a separate request the dialog's response does not wait for.
      handleSessionCreated: vi.fn(() => {
        dashboard.current = {
          ...dashboard.current,
          sessions: [created],
          filteredSessions: [created],
        };
      }),
    };
    mobileNav.isWide = false;
    renderShell();
    expect(screen.getByTestId('app-home')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('create-session-submit'));

    // Creation is an entry into the work, not a refresh that leaves the user on
    // the same empty home: the id is matched against the refreshed list and the
    // ordinary selection path runs — attach, detail, Terminal root.
    expect(mobileNav.openDetail).toHaveBeenCalled();
    expect(screen.queryByTestId('app-home')).not.toBeInTheDocument();
  });

  it('does not select a same-named Session while the created one is missing (#1082)', async () => {
    const impostor: Session = {
      session_id: 'a1:other',
      agent_id: 'a1',
      session_name: 'Fresh work',
      status: 'active',
      window_count: 1,
      attached_clients: 0,
      last_activity: new Date().toISOString(),
    };
    dashboard.current = {
      ...dashboard.current,
      agents: [{ ...agent, status: 'online' }],
      sessions: [impostor],
      filteredSessions: [impostor],
      showCreateModal: true,
      // The refresh has not landed yet, so the created id is simply absent.
      handleSessionCreated: vi.fn(),
    };
    mobileNav.isWide = false;
    renderShell();

    await userEvent.click(screen.getByTestId('create-session-submit'));

    // The list holds a Session with the *same name* — the guess a name-based
    // implementation would make. Selecting it would attach the user to a
    // different piece of work than the one they just created.
    expect(mobileNav.openDetail).not.toHaveBeenCalled();
    expect(screen.getByTestId('app-home')).toBeInTheDocument();
  });

  it('does not mount the App layer composition on desktop after selecting a session', async () => {
    mobileNav.isWide = true;
    mobileNav.showList = true;
    mobileNav.showDetail = true;
    deepLink.sessionIdFromUrl = sess.session_id;
    renderShell();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(screen.queryByTestId('app-layer-root')).not.toBeInTheDocument();
  });
});
