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
    ...overrides,
  };
}

describe('useAttachFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('onAttach opens the dialog (does not attach immediately)', () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn()));
    act(() => result.current.onAttach(session()));
    expect(result.current.attachDialogSession).not.toBeNull();
    expect(result.current.view).toBe('dashboard');
  });

  it('confirmAttach switches to terminal with the resolved choice', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), choice('p2p'));
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(result.current.attachedSession?.orderedUrls).toEqual(['ws://a/ws']);
  });

  it('persists mode prefs on attach', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), choice('auto'));
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    const saved = JSON.parse(localStorage.getItem('nession_attach_prefs') ?? '{}');
    expect(saved.mode).toBe('auto');
  });

  it('carries a manual address override through to the attached session', async () => {
    const { result } = renderHook(() => useAttachFlow(vi.fn()));
    await act(async () => {
      result.current.confirmAttach(session(), choice('p2p', { selectedUrl: 'ws://vpn/ws' }));
    });
    await waitFor(() => expect(result.current.view).toBe('terminal'));
    expect(result.current.attachedSession?.selectedAddress).toBe('ws://vpn/ws');
  });

  it('backToDashboard resets view and fetches sessions', () => {
    const fetchSessions = vi.fn();
    const { result } = renderHook(() => useAttachFlow(fetchSessions));
    act(() => result.current.backToDashboard());
    expect(result.current.view).toBe('dashboard');
    expect(fetchSessions).toHaveBeenCalled();
  });
});
