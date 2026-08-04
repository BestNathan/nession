import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalSessions } from '../useTerminalSessions';
import type { WebSocketService } from '../../services/websocket';
import type { Session } from '../../types';

function mockWsService(sessions: Session[] = []) {
  const listeners = new Set<(s: Session[]) => void>();
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
    onSessionsChanged: vi.fn((cb: (s: Session[]) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    _push: (s: Session[]) => listeners.forEach((cb) => cb(s)),
  } as unknown as WebSocketService & { _push: (s: Session[]) => void };
}

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading=true initially, then sessions after fetch', async () => {
    const sessions = [makeSession()];
    const ws = mockWsService(sessions);

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
    const ws = mockWsService();
    ws.listSessions = vi.fn().mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('network error');
    expect(result.current.sessions).toEqual([]);
  });

  it('updates sessions on push event', async () => {
    const initial = [makeSession({ session_name: 'old' })];
    const ws = mockWsService(initial);

    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'new' })];
    act(() => {
      ws._push(updated);
    });

    expect(result.current.sessions).toEqual(updated);
  });

  it('does nothing when wsService is null', () => {
    const { result } = renderHook(() => useTerminalSessions(null));

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('refetch calls listSessions again', async () => {
    const ws = mockWsService([]);
    const { result } = renderHook(() => useTerminalSessions(ws));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = [makeSession({ session_name: 'refetched' })];
    ws.listSessions = vi.fn().mockResolvedValue(updated);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.sessions).toEqual(updated);
  });
});
