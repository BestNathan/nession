import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttachFlow } from '../useAttachFlow';
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

describe('useAttachFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('onAttach opens the dialog (does not attach immediately)', () => {
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(fn, vi.fn()));
    act(() => result.current.onAttach(session()));
    expect(result.current.attachDialogSession).not.toBeNull();
    expect(result.current.view).toBe('dashboard');
  });

  it('confirmAttach with p2p mode switches to terminal', async () => {
    const { fn, calls } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(fn, vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), 'p2p');
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(calls).toEqual(['p2p']);
  });

  it('persists mode prefs on attach', async () => {
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(fn, vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), 'auto');
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    const saved = JSON.parse(localStorage.getItem('nession_attach_prefs') ?? '{}');
    expect(saved.mode).toBe('auto');
  });

  it('backToDashboard resets view and fetches sessions', () => {
    const fetchSessions = vi.fn();
    const { fn } = makeHandleAttach();
    const { result } = renderHook(() => useAttachFlow(fn, fetchSessions));
    // Manually set terminal state to simulate an active attach.
    act(() => {
      result.current.attachDialogSession = session();
    });
    act(() => result.current.backToDashboard());
    expect(result.current.view).toBe('dashboard');
    expect(fetchSessions).toHaveBeenCalled();
  });
});
