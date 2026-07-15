import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttachFlow } from '../useAttachFlow';
import type { Session, AttachInfo } from '../../types';
import type { AttachChoice } from '../env/AttachDialog';

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

function choice(mode: 'auto' | 'p2p', overrides: Partial<AttachChoice> = {}): AttachChoice {
  const attachInfo: AttachInfo = { mode: 'p2p', session_id: 'agent-1:dev', session_name: 'dev' };
  return {
    mode,
    attachInfo,
    orderedUrls: ['ws://a/ws'],
    latencies: [{ url: 'ws://a/ws', latencyMs: 10 }],
    selectedUrl: null,
    renderer: 'webgl',
    ...overrides,
  };
}

describe('useAttachFlow', () => {
  let navigate: ReturnType<typeof vi.fn>;
  let location: { pathname: string };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    navigate = vi.fn();
    location = { pathname: '/' };
  });

  const nav = () => navigate as unknown as Parameters<typeof useAttachFlow>[1];

  it('onAttach opens the dialog (does not attach immediately)', () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), location));
    act(() => result.current.onAttach(session()));
    expect(result.current.attachDialogSession).not.toBeNull();
    expect(result.current.attachedSession).toBeNull();
  });

  it('confirmAttach sets attachedSession and navigates to terminal route', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), location));
    await act(async () => {
      result.current.confirmAttach(session(), choice('p2p'));
    });
    await waitFor(() => expect(result.current.attachedSession).not.toBeNull());
    expect(result.current.attachedSession?.orderedUrls).toEqual(['ws://a/ws']);
    expect(navigate).toHaveBeenCalledWith('/terminal/agent-1%3Adev');
  });

  it('persists mode prefs on attach', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), location));
    await act(async () => {
      result.current.confirmAttach(session(), choice('auto'));
    });
    await waitFor(() => expect(result.current.attachedSession).not.toBeNull());
    const saved = JSON.parse(localStorage.getItem('nession_attach_prefs') ?? '{}');
    expect(saved.mode).toBe('auto');
  });

  it('carries a manual address override through to the attached session', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), location));
    await act(async () => {
      result.current.confirmAttach(session(), choice('p2p', { selectedUrl: 'ws://vpn/ws' }));
    });
    await waitFor(() => expect(result.current.attachedSession).not.toBeNull());
    expect(result.current.attachedSession?.selectedAddress).toBe('ws://vpn/ws');
  });

  it('backToDashboard clears attachedSession, navigates to root, and fetches sessions', () => {
    const fetchSessions = vi.fn();
    const { result } = renderHook(() => useAttachFlow(fetchSessions, nav(), location));
    // First, attach to have something to go back from.
    act(() => {
      result.current.confirmAttach(session(), choice('p2p'));
    });
    expect(result.current.attachedSession).not.toBeNull();

    act(() => result.current.backToDashboard());
    expect(result.current.attachedSession).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/');
    expect(fetchSessions).toHaveBeenCalled();
  });

  it('pendingTerminalSessionId is extracted from the location pathname', () => {
    const locWithSession = { pathname: '/terminal/agent-1%3Adev' };
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), locWithSession));
    expect(result.current.pendingTerminalSessionId).toBe('agent-1%3Adev');
  });

  it('pendingTerminalSessionId is null on the dashboard route', () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn(), nav(), location));
    expect(result.current.pendingTerminalSessionId).toBeNull();
  });
});
