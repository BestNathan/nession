import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { useSessionData } from '@/hooks/useSessionData';
import type { Session } from '@/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

// useSessionData now talks to the sessions feature singleton rather than a
// WebSocketService instance.
const sessionsApiMock = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
}));

vi.mock('@/features/sessions', () => ({ sessionsApi: sessionsApiMock }));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'a1:s1',
    agent_id: 'a1',
    session_name: 's1',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
    ...overrides,
  };
}

describe('useSessionData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores fetched sessions', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({ sessions: [makeSession()] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions(); });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.staleAgents).toEqual([]);
    expect(result.current.sessionsLoaded).toBe(true);
  });

  /** The refresh button relies on this: `force` must reach the feature API, or
   *  the server would answer from its registry instead of re-querying agents. */
  it('forwards force to the feature API', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({ sessions: [] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions({ force: true }); });

    expect(sessionsApiMock.fetchSessions).toHaveBeenCalledWith({ force: true });
  });

  it('forwards agentId to the feature API', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({ sessions: [] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions({ agentId: 'a1' }); });

    expect(sessionsApiMock.fetchSessions).toHaveBeenCalledWith({ agentId: 'a1' });
  });

  it('records stale agents and warns the user', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({
      sessions: [makeSession()],
      stale_agents: ['a1'],
    });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions({ force: true }); });

    expect(result.current.staleAgents).toEqual(['a1']);
    // Sessions are kept, not dropped — that is the whole point of stale marking.
    expect(result.current.sessions).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('does not warn when nothing is stale', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({ sessions: [], stale_agents: [] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions({ force: true }); });

    expect(toast.warning).not.toHaveBeenCalled();
  });

  /** A refresh that recovers must clear the previous stale marks, otherwise
   *  the badges would stick around forever. */
  it('clears stale agents on a subsequent healthy refresh', async () => {
    sessionsApiMock.fetchSessions
      .mockResolvedValueOnce({ sessions: [makeSession()], stale_agents: ['a1'] })
      .mockResolvedValueOnce({ sessions: [makeSession()], stale_agents: [] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions({ force: true }); });
    expect(result.current.staleAgents).toEqual(['a1']);

    await act(async () => { await result.current.fetchSessions({ force: true }); });
    expect(result.current.staleAgents).toEqual([]);
  });

  it('treats a missing stale_agents field as none stale', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({ sessions: [makeSession()] });
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions(); });

    expect(result.current.staleAgents).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('surfaces fetch failures and stops loading', async () => {
    sessionsApiMock.fetchSessions.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useSessionData());

    await act(async () => { await result.current.fetchSessions(); });

    expect(toast.error).toHaveBeenCalledWith('network down');
    await waitFor(() => { expect(result.current.loadingSessions).toBe(false); });
  });
});
