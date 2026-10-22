import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { useSessionData } from '@/product/session/hooks/useSessionData';
import type { Session } from '@/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

// useSessionData now talks to the sessions feature singleton rather than a
// WebSocketService instance.
const sessionsApiMock = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
}));

vi.mock('@/product/session', () => ({ sessionsApi: sessionsApiMock }));

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

  // ── insertSession (#1430) ────────────────────────────────────────────

  it('inserts a Session the client already holds the identity of', () => {
    const { result } = renderHook(() => useSessionData());

    act(() => { result.current.insertSession(makeSession({ session_id: 'a1:acked' })); });

    expect(result.current.sessions.map((s) => s.session_id)).toEqual(['a1:acked']);
  });

  /** The broadcast may race the ACK: if the list already carries the id, the
   *  server's own row wins and the insert is a no-op rather than a duplicate. */
  it('does not duplicate or overwrite a row the list already carries', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({
      sessions: [makeSession({ session_id: 'a1:acked', status: 'active', window_count: 3 })],
    });
    const { result } = renderHook(() => useSessionData());
    await act(async () => { await result.current.fetchSessions(); });

    act(() => { result.current.insertSession(makeSession({ session_id: 'a1:acked' })); });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].status).toBe('active');
    expect(result.current.sessions[0].window_count).toBe(3);
  });
  // #1900: The server may finish a session.list request AFTER broadcasting a
  // newer session report; an old unknown snapshot must not erase that report.
  it('keeps a newer realtime bash command when an older list resolves unknown', async () => {
    let resolveList!: (value: { sessions: Session[]; stale_agents?: string[] }) => void;
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));
    const { result } = renderHook(() => useSessionData());
    let request!: Promise<void>;
    act(() => { request = result.current.fetchSessions(); });

    // Distinguish "no push" from "push seen but overwritten": the callback
    // actually updates the hook to bash before the stale response resolves.
    act(() => {
      result.current.applyRealtimeSessions([makeSession({ foreground_command: 'bash' })]);
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');

    await act(async () => {
      resolveList({ sessions: [makeSession({ foreground_command: null })], stale_agents: ['a1'] });
      await request;
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    expect(result.current.staleAgents).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.loadingSessions).toBe(false);
    expect(result.current.sessionsLoaded).toBe(true);
  });

  it('refetches a correlated bash report discarded after an unknown push (#1986)', async () => {
    const pending: Array<(data: { sessions: Session[] }) => void> = [];
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const { result } = renderHook(() => useSessionData());
    let fetching!: Promise<void>;
    act(() => { fetching = result.current.fetchSessions(); });

    // A push arrives after the request started, but before its reply.
    act(() => {
      result.current.applyRealtimeSessions([makeSession({ foreground_command: null })]);
    });
    await act(async () => {
      pending[0]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await Promise.resolve();
    });
    // Request correlation consumed the reported bash; the hook must not
    // overwrite the newer push with it, but must query the latest registry.
    expect(result.current.sessions[0].foreground_command).toBeNull();
    expect(sessionsApiMock.fetchSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[1]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await fetching;
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    expect(result.current.loadingSessions).toBe(false);
    expect(result.current.sessionsLoaded).toBe(true);
  });

  it('does not resurrect bash from a stale reply after a newer explicit clear (#1986)', async () => {
    const pending: Array<(data: { sessions: Session[] }) => void> = [];
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const { result } = renderHook(() => useSessionData());
    act(() => result.current.applyRealtimeSessions([
      makeSession({ foreground_command: 'bash' }),
    ]));
    let fetching!: Promise<void>;
    act(() => { fetching = result.current.fetchSessions(); });
    act(() => result.current.applyRealtimeSessions([
      makeSession({ foreground_command: null }),
    ]));
    await act(async () => {
      pending[0]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await Promise.resolve();
    });
    expect(result.current.sessions[0].foreground_command).toBeNull();
    expect(sessionsApiMock.fetchSessions).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending[1]({ sessions: [makeSession({ foreground_command: null })] });
      await fetching;
    });
    expect(result.current.sessions[0].foreground_command).toBeNull();
  });

  it('caps reconciliation at one retry under continual newer pushes (#1986)', async () => {
    const pending: Array<(data: { sessions: Session[] }) => void> = [];
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const { result } = renderHook(() => useSessionData());
    let fetching!: Promise<void>;
    act(() => { fetching = result.current.fetchSessions(); });
    act(() => result.current.applyRealtimeSessions([
      makeSession({ foreground_command: null }),
    ]));
    await act(async () => {
      pending[0]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await Promise.resolve();
    });
    act(() => result.current.applyRealtimeSessions([
      makeSession({ foreground_command: 'zsh' }),
    ]));
    await act(async () => {
      pending[1]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await fetching;
    });
    expect(result.current.sessions[0].foreground_command).toBe('zsh');
    expect(sessionsApiMock.fetchSessions).toHaveBeenCalledTimes(2);
    expect(result.current.loadingSessions).toBe(false);
  });

  it('still accepts a list when no newer push arrived (not a missing-push workaround)', async () => {
    sessionsApiMock.fetchSessions.mockResolvedValue({
      sessions: [makeSession({ foreground_command: null })],
    });
    const { result } = renderHook(() => useSessionData());
    await act(async () => { await result.current.fetchSessions(); });
    expect(result.current.sessions[0].foreground_command).toBeNull();
  });

  it('allows subsequent server truth to clear bash back to unknown', () => {
    const { result } = renderHook(() => useSessionData());
    act(() => {
      result.current.applyRealtimeSessions([makeSession({ foreground_command: 'bash' })]);
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    act(() => {
      result.current.applyRealtimeSessions([makeSession({ foreground_command: null })]);
    });
    expect(result.current.sessions[0].foreground_command).toBeNull();
    // Full list replacements also have legitimate deletion authority.
    act(() => { result.current.applyRealtimeSessions([]); });
    expect(result.current.sessions).toEqual([]);
  });

  it('lets an explicitly later fetch update workload after the earlier push', async () => {
    const { result } = renderHook(() => useSessionData());
    act(() => {
      result.current.applyRealtimeSessions([makeSession({ foreground_command: 'bash' })]);
    });
    sessionsApiMock.fetchSessions.mockResolvedValue({
      sessions: [makeSession({ foreground_command: null })],
    });
    await act(async () => { await result.current.fetchSessions({ force: true }); });
    expect(result.current.sessions[0].foreground_command).toBeNull();
  });

  it('ignores an older concurrent list even when it resolves after the later fetch', async () => {
    const resolves: Array<(value: { sessions: Session[]; stale_agents?: string[] }) => void> = [];
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      resolves.push(resolve);
    }));
    const { result } = renderHook(() => useSessionData());
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = result.current.fetchSessions();
      second = result.current.fetchSessions({ force: true });
    });
    await act(async () => {
      resolves[1]({ sessions: [makeSession({ foreground_command: 'bash' })] });
      await second;
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    await act(async () => {
      resolves[0]({ sessions: [makeSession({ foreground_command: null })], stale_agents: ['a1'] });
      await first;
    });
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    expect(result.current.staleAgents).toEqual([]);
    expect(result.current.loadingSessions).toBe(false);
  });

  it('does not allow a pre-create request to erase a new authoritative ACK row', async () => {
    let resolveList!: (value: { sessions: Session[] }) => void;
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));
    const { result } = renderHook(() => useSessionData());
    let pending!: Promise<void>;
    act(() => { pending = result.current.fetchSessions(); });
    act(() => { result.current.insertSession(makeSession({ session_id: 'a1:acked' })); });
    await act(async () => { resolveList({ sessions: [] }); await pending; });
    expect(result.current.sessions.map(s => s.session_id)).toEqual(['a1:acked']);
  });

  it('does not surface a stale request error after newer realtime success', async () => {
    let rejectList!: (error: Error) => void;
    sessionsApiMock.fetchSessions.mockImplementation(() => new Promise((_, reject) => {
      rejectList = reject;
    }));
    const { result } = renderHook(() => useSessionData());
    let pending!: Promise<void>;
    act(() => { pending = result.current.fetchSessions(); });
    act(() => { result.current.applyRealtimeSessions([makeSession({ foreground_command: 'bash' })]); });
    await act(async () => { rejectList(new Error('superseded request')); await pending; });
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.sessions[0].foreground_command).toBe('bash');
    expect(result.current.loadingSessions).toBe(false);
  });

});
