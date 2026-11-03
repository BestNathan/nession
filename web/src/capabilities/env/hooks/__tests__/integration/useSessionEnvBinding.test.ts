import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SessionEnvBindingResponse } from '@/capabilities/env/types';

const envApi = vi.hoisted(() => ({
  getSessionEnvBinding: vi.fn(),
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
