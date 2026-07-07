import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttachFlow } from '../useAttachFlow';
import type { WebSocketService } from '../../services/websocket';
import type { Session, AttachMode } from '../../types';
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

/** A handleAttach stub that records the mode and stashes _attached. */
function makeHandleAttach(): {
  fn: (s: Session, mode?: AttachMode) => Promise<void>;
  calls: AttachMode[];
} {
  const calls: AttachMode[] = [];
  const fn = vi.fn(async (s: Session, mode: AttachMode = 'auto') => {
    calls.push(mode);
    (fn as unknown as { _attached?: AttachedSession })._attached = {
      sessionId: s.session_id,
      sessionName: s.session_name,
      attachInfo: { mode: 'relay', session_id: s.session_id },
    };
  });
  return { fn: fn as unknown as (s: Session, mode?: AttachMode) => Promise<void>, calls };
}

function makeWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    applySessionEnv: vi.fn().mockResolvedValue({ success: true, warnings: [] }),
    unsetSessionEnv: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WebSocketService;
}

describe('useAttachFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('onAttach opens the dialog (does not attach immediately)', () => {
    const ws = makeWs();
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(ws, fn, vi.fn()));
    act(() => result.current.onAttach(session()));
    expect(result.current.attachDialogSession).not.toBeNull();
    expect(result.current.view).toBe('dashboard');
  });

  it('confirmAttach with mode + no env switches to terminal', async () => {
    const ws = makeWs();
    const { fn, calls } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(ws, fn, vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), 'p2p', []);
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(calls).toEqual(['p2p']);
    expect(ws.applySessionEnv).not.toHaveBeenCalled();
    expect(result.current.attachedSession?.appliedEnv).toEqual([]);
  });

  it('confirmAttach applies env and persists prefs', async () => {
    const ws = makeWs();
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(ws, fn, vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), 'relay', [{ name: 'a.env', source: 'server' }]);
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(ws.applySessionEnv).toHaveBeenCalledWith('agent-1:dev', [
      { name: 'a.env', source: 'server' },
    ]);
    expect(result.current.attachedSession?.appliedEnv).toHaveLength(1);
    // Preferences persisted for next time.
    const saved = JSON.parse(localStorage.getItem('nession_attach_prefs') ?? '{}');
    expect(saved.mode).toBe('relay');
    expect(saved.envFiles).toHaveLength(1);
  });

  it('backToDashboard unsets applied env', async () => {
    const ws = makeWs();
    const fetchSessions = vi.fn();
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(ws, fn, fetchSessions));
    await act(async () => {
      result.current.confirmAttach(session(), 'auto', [{ name: 'a.env', source: 'server' }]);
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
