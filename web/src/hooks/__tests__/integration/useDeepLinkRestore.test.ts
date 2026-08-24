import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDeepLinkRestore } from '@/hooks/useDeepLinkRestore';
import type { Session } from '@/types';
import type { AttachedSession } from '@/components/TerminalView';

function makeSession(id = 'agent-1:s1'): Session {
  return {
    session_id: id,
    agent_id: 'agent-1',
    session_name: 's1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2025-01-01T00:00:00Z',
  };
}

describe('useDeepLinkRestore', () => {
  const navigate = vi.fn();
  const confirmAttach = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for sessionsLoaded before navigating away on missing session', () => {
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: 'agent-1:s1',
      attachedSession: null,
      sessionsLoaded: false,
      loadingSessions: false,
      sessions: [],
      confirmAttach,
      navigate,
    }));

    expect(navigate).not.toHaveBeenCalled();
    expect(confirmAttach).not.toHaveBeenCalled();
  });

  it('auto-attaches once sessions are loaded', () => {
    const session = makeSession();
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: session.session_id,
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [session],
      confirmAttach,
      navigate,
    }));

    expect(confirmAttach).toHaveBeenCalledWith(session, expect.objectContaining({
      mode: 'auto',
    }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates home when session is missing after load', () => {
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: 'missing:s1',
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [makeSession()],
      confirmAttach,
      navigate,
    }));

    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('skips when already attached', () => {
    const attached: AttachedSession = {
      sessionId: 'agent-1:s1',
      sessionName: 's1',
      attachInfo: { mode: 'relay', session_id: 'agent-1:s1', agent_address: '', connection_token: '' },
    };
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: 'agent-1:s1',
      attachedSession: attached,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [makeSession()],
      confirmAttach,
      navigate,
    }));

    expect(confirmAttach).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
