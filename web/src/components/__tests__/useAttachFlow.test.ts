import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttachFlow } from '../useAttachFlow';
import type { WebSocketService } from '../../services/websocket';
import type { Session } from '../../types';
import type { AttachedSession } from '../TerminalView';

function session(): Session {
  return {
    session_id: 'agent-1:dev',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
  };
}

/** A handleAttach stub that stashes _attached like the real one does. */
function makeHandleAttach(): (s: Session) => Promise<void> {
  const fn = vi.fn(async (s: Session) => {
    (fn as unknown as { _attached?: AttachedSession })._attached = {
      sessionId: s.session_id,
      sessionName: s.session_name,
      attachInfo: { mode: 'relay', session_id: s.session_id },
    };
  });
  return fn as unknown as (s: Session) => Promise<void>;
}

function makeWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    applySessionEnv: vi.fn().mockResolvedValue({ success: true, warnings: [] }),
    unsetSessionEnv: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WebSocketService;
}

describe('useAttachFlow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('plain attach switches to terminal without applying env', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useAttachFlow(ws, makeHandleAttach(), vi.fn()));
    await act(async () => {
      result.current.onAttach(session());
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(ws.applySessionEnv).not.toHaveBeenCalled();
    expect(result.current.attachedSession?.appliedEnv).toEqual([]);
  });

  it('attach with env applies files and records them', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useAttachFlow(ws, makeHandleAttach(), vi.fn()));
    act(() => result.current.onAttachWithEnv(session()));
    expect(result.current.attachEnvSession).not.toBeNull();
    await act(async () => {
      result.current.confirmAttachEnv(session(), [{ name: 'a.env', source: 'server' }]);
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(ws.applySessionEnv).toHaveBeenCalledWith('agent-1:dev', [
      { name: 'a.env', source: 'server' },
    ]);
    expect(result.current.attachedSession?.appliedEnv).toHaveLength(1);
  });

  it('backToDashboard unsets applied env', async () => {
    const ws = makeWs();
    const fetchSessions = vi.fn();
    const { result } = renderHook(() => useAttachFlow(ws, makeHandleAttach(), fetchSessions));
    await act(async () => {
      result.current.confirmAttachEnv(session(), [{ name: 'a.env', source: 'server' }]);
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    act(() => result.current.backToDashboard());
    expect(ws.unsetSessionEnv).toHaveBeenCalledWith('agent-1:dev', [
      { name: 'a.env', source: 'server' },
    ]);
    expect(result.current.view).toBe('dashboard');
    expect(fetchSessions).toHaveBeenCalled();
  });
});
