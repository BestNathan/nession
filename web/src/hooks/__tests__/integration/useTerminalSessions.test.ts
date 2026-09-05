import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalSessions } from '@/hooks/useTerminalSessions';
import type { WebSocketService } from '@/services/socket';
import type { Session } from '@/types';

// The hook fetches and subscribes through the sessions feature singleton;
// the wsService argument is now only an identity/null gate for re-keying.
const sessionsApiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  onSessionsChanged: vi.fn<(cb: (sessions: Session[]) => void) => () => void>(() => () => {}),
}));

vi.mock('@/features/sessions', () => ({ sessionsApi: sessionsApiMock }));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent1:test',
    agent_id: 'agent1',
    session_name: 'test',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useTerminalSessions', () => {
  let pushSessions: ((sessions: Session[]) => void) | null;

  beforeEach(() => {
    pushSessions = null;
    sessionsApiMock.listSessions.mockReset();
    sessionsApiMock.onSessionsChanged = vi.fn((cb: (sessions: Session[]) => void) => {
      pushSessions = cb;
      return () => {};
    });
  });

  function makeWsService(sessions: Session[] = []): WebSocketService {
    sessionsApiMock.listSessions.mockResolvedValue(sessions);
    return { connectionState: 'connected' } as unknown as WebSocketService;
  }

  it('returns loading=true initially, then sessions after fetch', async () => {
    const sessions = [makeSession()];
    const ws = makeWsService(sessions);

    const { result } = renderHook(() => useTerminalSessions(ws));

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual(sessions);
    expect(result.current.error).toBeNull();
  });

  it('handles fetch error', async () => {
    sessionsApiMock.listSessions.mockRejectedValue(new Error('network error'));
    const ws = { connectionState: 'connected' } as unknown as WebSocketService;

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('network error');
    expect(result.current.sessions).toEqual([]);
  });

  it('updates sessions on push event', async () => {
    const initial = [makeSession({ session_name: 'old' })];
    const ws = makeWsService(initial);

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'new' })];
    act(() => {
      pushSessions!(updated);
    });

    expect(result.current.sessions).toEqual(updated);
  });

  it('does nothing when wsService is null', () => {
    const { result } = renderHook(() => useTerminalSessions(null));

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(sessionsApiMock.listSessions).not.toHaveBeenCalled();
  });

  it('refetch calls listSessions again', async () => {
    const ws = makeWsService([]);
    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'refetched' })];
    sessionsApiMock.listSessions.mockResolvedValue(updated);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.sessions).toEqual(updated);
  });
});
