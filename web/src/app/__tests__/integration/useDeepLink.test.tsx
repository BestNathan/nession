import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import { useDeepLink } from '@/app/useDeepLink';
import { attachToSessionAtom, sessionIdAtom } from '@/product/session/state';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import type { Session } from '@/types';

vi.mock('@/app/useDeepLinkRestore', () => ({
  useDeepLinkRestore: vi.fn(),
}));

import { useDeepLinkRestore } from '@/app/useDeepLinkRestore';

function makeSession(id = 'a1:s1'): Session {
  return {
    session_id: id,
    agent_id: 'a1',
    session_name: 's1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
  };
}

function wrapper(initialEntry: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Provider store={createStore()}>
        <MemoryRouter initialEntries={[initialEntry]}>
          {children}
        </MemoryRouter>
      </Provider>
    );
  };
}

describe('useDeepLink', () => {
  const confirmAttach = vi.fn();
  const onRestoreSession = vi.fn();
  const requestAttach = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports restoring when on terminal route without active attach', () => {
    const { result } = renderHook(
      () => useDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
        requestAttach,
      }),
      { wrapper: wrapper('/terminal/a1%3As1') },
    );

    expect(result.current.isRestoringDeepLink).toBe(true);
    expect(result.current.sessionIdFromUrl).toBe('a1:s1');
  });

  it('delegates restore to useDeepLinkRestore with URL session id', () => {
    renderHook(
      () => useDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
        requestAttach,
      }),
      { wrapper: wrapper('/terminal/a1%3As1') },
    );

    expect(useDeepLinkRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingSessionId: 'a1:s1',
        attachedSession: null,
      }),
    );
  });

  it('syncs shell selection when attach atom matches URL session', async () => {
    const store = createStore();
    store.set(sessionIdAtom, 'a1:s1');

    function SyncWrapper({ children }: { children: ReactNode }) {
      return (
        <Provider store={store}>
          <MemoryRouter initialEntries={['/terminal/a1%3As1']}>
            {children}
          </MemoryRouter>
        </Provider>
      );
    }

    renderHook(
      () => useDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
        requestAttach,
      }),
      { wrapper: SyncWrapper },
    );

    await waitFor(() => {
      expect(onRestoreSession).toHaveBeenCalledWith(makeSession());
    });
  });

  it('switches to URL session when already attached to a different session', async () => {
    const store = createStore();
    store.set(sessionIdAtom, 'a1:s1'); // Already attached to s1

    const session2 = makeSession('a1:s2');

    function SyncWrapper({ children }: { children: ReactNode }) {
      return (
        <Provider store={store}>
          <MemoryRouter initialEntries={['/terminal/a1%3As2']}> {/* URL points to s2 */}
            {children}
          </MemoryRouter>
        </Provider>
      );
    }

    renderHook(
      () => useDeepLink({
        sessions: [makeSession(), session2],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
        requestAttach,
      }),
      { wrapper: SyncWrapper },
    );

    await waitFor(() => {
      // Should sync UI selection
      expect(onRestoreSession).toHaveBeenCalledWith(session2);
      // Should trigger attach flow to the new session
      expect(requestAttach).toHaveBeenCalledWith(session2);
    });
  });

  it('does not bounce back to the old session when attachToSession navigates (#1396)', async () => {
    const store = createStore();
    store.set(sessionIdAtom, 'a1:s1'); // attached to s1, viewing /terminal/a1:s1

    const session2 = makeSession('a1:s2');
    const choice: AttachChoice = {
      mode: 'auto',
      attachInfo: { mode: 'p2p', session_id: 'a1:s2' },
      orderedUrls: ['ws://agent/ws'],
      latencies: [],
      selectedUrl: null,
      renderer: 'webgl',
      envRefs: [],
    };

    // attachToSessionAtom writes sessionIdAtom=B and navigates in one jotai
    // write; the URL param and the attach atom land in the same commit.
    let doAttach: () => void = () => {};
    function Harness() {
      const navigate = useNavigate();
      doAttach = () => {
        store.set(attachToSessionAtom, { session: session2, choice, navigate });
      };
      return null;
    }

    function SwitchWrapper({ children }: { children: ReactNode }) {
      return (
        <Provider store={store}>
          <MemoryRouter initialEntries={['/terminal/a1%3As1']}>
            {children}
            <Harness />
          </MemoryRouter>
        </Provider>
      );
    }

    renderHook(
      () => useDeepLink({
        sessions: [makeSession(), session2],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
        requestAttach,
      }),
      { wrapper: SwitchWrapper },
    );

    act(() => {
      doAttach();
    });

    // The switch converges on s2 (URL caught up → selection syncs)…
    await waitFor(() => {
      expect(onRestoreSession).toHaveBeenCalledWith(session2);
    });
    // …and never treats the propagation window as "URL wants s1".
    expect(requestAttach).not.toHaveBeenCalled();
  });
});
