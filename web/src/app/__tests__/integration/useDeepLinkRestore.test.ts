import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeepLinkRestore } from '@/app/useDeepLinkRestore';
import type { Session } from '@/types';
import type { AttachedSession } from '@/features/terminal/types';

vi.mock('@/services/deepLinkAttach', () => ({
  resolveDeepLinkAttachChoice: vi.fn(),
  resolveProfileAttach: vi.fn(),
}));

// loadSessionProfile must answer per-test (profile present or not), so the
// mock reads a mutable store instead of returning a fixed value.
const profileStore = vi.hoisted(() => ({
  current: null as SessionAttachProfile | null,
}));

vi.mock('@/services/sessionAttachProfile', () => ({
  loadSessionProfile: () => profileStore.current,
}));

import { resolveDeepLinkAttachChoice, resolveProfileAttach } from '@/services/deepLinkAttach';
import type { SessionAttachProfile } from '@/services/sessionAttachProfile';

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

function makeProfile(session: Session): SessionAttachProfile {
  return {
    schemaVersion: 1,
    sessionId: session.session_id,
    agentId: session.agent_id,
    choice: {
      mode: 'auto',
      renderer: 'canvas',
      envRefs: [],
      selectedUrl: null,
    },
    optionsFingerprint: 'fingerprint',
    updatedAt: 0,
  };
}

describe('useDeepLinkRestore', () => {
  const navigate = vi.fn();
  const confirmAttach = vi.fn();
  const requestConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    profileStore.current = null;
  });

  it('waits for sessionsLoaded before navigating away on missing session', () => {
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: 'agent-1:s1',
      attachedSession: null,
      sessionsLoaded: false,
      loadingSessions: false,
      sessions: [],
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
      navigate,
    }));

    expect(navigate).not.toHaveBeenCalled();
    expect(resolveDeepLinkAttachChoice).not.toHaveBeenCalled();
  });

  it('auto-attaches once sessions are loaded', async () => {
    const session = makeSession();
    const choice = {
      mode: 'auto' as const,
      attachInfo: { mode: 'p2p' as const, session_id: session.session_id, connection_token: 'tok' },
      orderedUrls: ['ws://a/ws'],
      latencies: [],
      selectedUrl: null,
      relayUrl: null,
      renderer: 'webgl' as const,
      envRefs: [],
    };
    vi.mocked(resolveDeepLinkAttachChoice).mockResolvedValue(choice);

    renderHook(() => useDeepLinkRestore({
      pendingSessionId: session.session_id,
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [session],
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
      navigate,
    }));

    await waitFor(() => {
      expect(resolveDeepLinkAttachChoice).toHaveBeenCalledWith(session, new Map());
      // Restore opts out of profile persistence: no explicit user confirmation.
      expect(confirmAttach).toHaveBeenCalledWith(session, choice, { persistProfile: false });
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates home when session is missing after load', () => {
    renderHook(() => useDeepLinkRestore({
      pendingSessionId: 'missing:s1',
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [makeSession()],
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
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
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
      navigate,
    }));

    expect(resolveDeepLinkAttachChoice).not.toHaveBeenCalled();
    expect(confirmAttach).not.toHaveBeenCalled();
  });

  it('attaches with the saved profile when it validates — default persist, no dialog', async () => {
    const session = makeSession();
    const profile = makeProfile(session);
    const choice = {
      mode: 'auto' as const,
      attachInfo: { mode: 'p2p' as const, session_id: session.session_id, connection_token: 'tok' },
      orderedUrls: ['ws://a/ws'],
      latencies: [],
      selectedUrl: null,
      relayUrl: null,
      renderer: 'webgl' as const,
      envRefs: [],
    };
    profileStore.current = profile;
    vi.mocked(resolveProfileAttach).mockResolvedValue({ kind: 'choice', choice });

    renderHook(() => useDeepLinkRestore({
      pendingSessionId: session.session_id,
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [session],
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
      navigate,
    }));

    await waitFor(() => {
      expect(resolveProfileAttach).toHaveBeenCalledWith(session, profile, new Map());
      // Restore with a valid profile re-applies the saved choice; the default
      // persist refreshes the profile — no { persistProfile: false } opts.
      expect(confirmAttach).toHaveBeenCalledWith(session, choice);
    });
    expect(resolveDeepLinkAttachChoice).not.toHaveBeenCalled();
    expect(requestConfig).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the configure dialog for a stale profile instead of attaching', async () => {
    const session = makeSession();
    profileStore.current = makeProfile(session);
    vi.mocked(resolveProfileAttach).mockResolvedValue({ kind: 'dialog' });

    renderHook(() => useDeepLinkRestore({
      pendingSessionId: session.session_id,
      attachedSession: null,
      sessionsLoaded: true,
      loadingSessions: false,
      sessions: [session],
      probeResults: new Map(),
      confirmAttach,
      requestConfigForRestore: requestConfig,
      navigate,
    }));

    await waitFor(() => {
      expect(resolveProfileAttach).toHaveBeenCalledWith(session, profileStore.current, new Map());
      expect(requestConfig).toHaveBeenCalledTimes(1);
      expect(requestConfig).toHaveBeenCalledWith(session);
    });
    expect(confirmAttach).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
