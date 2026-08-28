import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import { useSessionFirstDeepLink } from '@/hooks/useSessionFirstDeepLink';
import { sessionIdAtom } from '@/atoms/session';
import type { Session } from '@/types';

vi.mock('@/hooks/useDeepLinkRestore', () => ({
  useDeepLinkRestore: vi.fn(),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ requestAttach: vi.fn() }),
}));

import { useDeepLinkRestore } from '@/hooks/useDeepLinkRestore';

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

describe('useSessionFirstDeepLink', () => {
  const confirmAttach = vi.fn();
  const onRestoreSession = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports restoring when on terminal route without active attach', () => {
    const { result } = renderHook(
      () => useSessionFirstDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
      }),
      { wrapper: wrapper('/terminal/a1%3As1') },
    );

    expect(result.current.isRestoringDeepLink).toBe(true);
    expect(result.current.sessionIdFromUrl).toBe('a1:s1');
  });

  it('delegates restore to useDeepLinkRestore with URL session id', () => {
    renderHook(
      () => useSessionFirstDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
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
      () => useSessionFirstDeepLink({
        sessions: [makeSession()],
        sessionsLoaded: true,
        loadingSessions: false,
        confirmAttach,
        onRestoreSession,
      }),
      { wrapper: SyncWrapper },
    );

    await waitFor(() => {
      expect(onRestoreSession).toHaveBeenCalledWith(makeSession());
    });
  });
});
