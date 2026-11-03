import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SessionEnvBindingResponse } from '@/capabilities/env/types';

const envApi = vi.hoisted(() => ({
  getSessionEnvBinding: vi.fn(),
  setSessionEnvBinding: vi.fn(),
  reapplySessionEnvBinding: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

import { useSessionEnvBinding } from '@/capabilities/env/hooks/useSessionEnvBinding';

function response(
  overrides: Partial<SessionEnvBindingResponse> = {},
): SessionEnvBindingResponse {
  return {
    success: true,
    binding: {
      session_id: 's1',
      desired_revision: 2,
      desired_profiles: [],
      observed: {
        applied_revision: 2,
        status: 'in_sync',
        profiles: [],
        managed_keys: ['A'],
      },
    },
    warnings: [],
    ...overrides,
  };
}

describe('useSessionEnvBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.getSessionEnvBinding.mockResolvedValue(response());
    envApi.setSessionEnvBinding.mockResolvedValue(response());
    envApi.reapplySessionEnvBinding.mockResolvedValue(response());
  });

  it('loads the current Session’s desired + observed state', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    expect(result.current.binding?.observed?.status).toBe('in_sync');
    expect(envApi.getSessionEnvBinding).toHaveBeenCalledWith('s1');
  });

  it('requests nothing without a Session', async () => {
    const { result } = renderHook(() => useSessionEnvBinding(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(envApi.getSessionEnvBinding).not.toHaveBeenCalled();
    expect(result.current.binding).toBeNull();
  });

  it('surfaces a failed read instead of pretending the binding is in sync', async () => {
    envApi.getSessionEnvBinding.mockResolvedValue(
      response({ success: false, binding: null, error: 'agent offline' }),
    );
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.error).toBe('agent offline'));
    expect(result.current.binding).toBeNull();
  });

  it('replace sends the whole ordered selection in one request', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    const refs = [
      { name: 'prod.env', source: 'server' as const },
      { name: 'staging.env', source: 'server' as const },
    ];
    envApi.setSessionEnvBinding.mockResolvedValue(
      response({
        binding: {
          session_id: 's1',
          desired_revision: 3,
          desired_profiles: refs.map((profile) => ({
            profile,
            phase: 'attach',
            outdated: false,
          })),
          observed: {
            applied_revision: 3,
            status: 'pending_shell',
            profiles: refs,
            managed_keys: ['A'],
          },
        },
      }),
    );

    let ok = false;
    await act(async () => {
      ok = (await result.current.replace(refs)).success;
    });
    expect(ok).toBe(true);
    expect(envApi.setSessionEnvBinding).toHaveBeenCalledWith('s1', refs);
    expect(result.current.binding?.observed?.status).toBe('pending_shell');
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it('keeps the returned desired binding when materialization fails, with the error', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    envApi.setSessionEnvBinding.mockResolvedValue(
      response({
        success: false,
        binding: {
          session_id: 's1',
          desired_revision: 3,
          desired_profiles: [],
          observed: {
            applied_revision: 2,
            status: 'error',
            profiles: [],
            managed_keys: ['A'],
            last_error: 'tmux refused',
          },
        },
        error: 'tmux refused',
      }),
    );

    let ok = true;
    await act(async () => {
      ok = (await result.current.replace([])).success;
    });
    expect(ok).toBe(false);
    expect(result.current.binding?.desired_revision).toBe(3);
    expect(result.current.error).toBe('tmux refused');
  });

  it('reapply re-resolves the desired profiles at a new revision', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    envApi.reapplySessionEnvBinding.mockResolvedValue(
      response({
        binding: {
          session_id: 's1',
          desired_revision: 4,
          desired_profiles: [],
          observed: {
            applied_revision: 4,
            status: 'in_sync',
            profiles: [],
            managed_keys: ['A'],
          },
        },
      }),
    );

    await act(async () => {
      await result.current.reapply();
    });
    expect(envApi.reapplySessionEnvBinding).toHaveBeenCalledWith('s1');
    expect(result.current.binding?.desired_revision).toBe(4);
  });

  it('a transport failure keeps the last valid binding and reports the error', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    const previous = result.current.binding;
    envApi.setSessionEnvBinding.mockRejectedValue(new Error('socket closed'));

    await act(async () => {
      await result.current.replace([]);
    });
    expect(result.current.binding).toEqual(previous);
    expect(result.current.error).toBe('socket closed');
    expect(result.current.pending).toBe(false);
  });

  it('refresh replaces the state after an apply', async () => {
    const { result } = renderHook(() => useSessionEnvBinding('s1'));
    await waitFor(() => expect(result.current.binding).not.toBeNull());

    envApi.getSessionEnvBinding.mockResolvedValue(
      response({
        binding: {
          session_id: 's1',
          desired_revision: 3,
          desired_profiles: [],
          observed: {
            applied_revision: 3,
            status: 'pending_shell',
            profiles: [],
            managed_keys: ['A'],
          },
        },
      }),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.binding?.observed?.status).toBe('pending_shell');
  });
});
