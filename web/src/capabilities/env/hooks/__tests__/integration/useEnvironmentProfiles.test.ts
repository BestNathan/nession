import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { EnvFileInfo } from '@/types';

const envApi = vi.hoisted(() => ({
  listEnvFiles: vi.fn(),
  getSessionEnvActive: vi.fn(),
  applySessionEnv: vi.fn(),
  unsetSessionEnv: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';
import { useEnvironmentProfiles } from '@/capabilities/env/hooks/useEnvironmentProfiles';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

describe('useEnvironmentProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.listEnvFiles.mockResolvedValue({ files: [info('a.env'), info('b.env')] });
    envApi.getSessionEnvActive.mockResolvedValue({
      active: [{ name: 'a.env', source: 'server', phase: 'attach' }],
    });
    envApi.applySessionEnv.mockResolvedValue({ success: true });
    envApi.unsetSessionEnv.mockResolvedValue({ success: true });
  });

  it('loads the profile list', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles(null));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles.map((p) => p.name)).toEqual(['a.env', 'b.env']);
    expect(result.current.error).toBeNull();
  });

  it('resolves the active set for the current Session, by refKey', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.activeKeys.size).toBe(1));
    expect(result.current.activeKeys.has('server::a.env')).toBe(true);
    expect(result.current.activeKeys.has('server::b.env')).toBe(false);
  });

  it('has no active set without a Session', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(envApi.getSessionEnvActive).not.toHaveBeenCalled();
    expect(result.current.activeKeys.size).toBe(0);
  });

  it('separates create-phase usage from attach-phase into createKeys', async () => {
    envApi.getSessionEnvActive.mockResolvedValue({
      active: [
        { name: 'a.env', source: 'server', phase: 'create' },
        { name: 'b.env', source: 'server', phase: 'attach' },
      ],
    });
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.activeKeys.size).toBe(2));
    // Both read as "Active"…
    expect(result.current.activeKeys.has('server::a.env')).toBe(true);
    expect(result.current.activeKeys.has('server::b.env')).toBe(true);
    // …but only the create-phase one lands in createKeys — the detail hides
    // Remove for it, because the unset wire spares create-phase usage.
    expect(result.current.createKeys.has('server::a.env')).toBe(true);
    expect(result.current.createKeys.has('server::b.env')).toBe(false);
  });

  it('a usage-lookup failure never takes the list down with it', async () => {
    envApi.getSessionEnvActive.mockRejectedValue(new Error('agent gone'));
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles).toHaveLength(2);
    expect(result.current.activeKeys.size).toBe(0);
  });

  it('surfaces a list failure with a retry path', async () => {
    envApi.listEnvFiles.mockRejectedValueOnce(new Error('socket closed'));
    const { result } = renderHook(() => useEnvironmentProfiles(null));
    await waitFor(() => expect(result.current.error).toBe('socket closed'));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.profiles).toHaveLength(2);
  });

  it('apply refreshes the active set on success', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.activeKeys.size).toBe(1));

    envApi.getSessionEnvActive.mockResolvedValue({
      active: [
        { name: 'a.env', source: 'server' },
        { name: 'b.env', source: 'server' },
      ],
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.applyToSession(info('b.env'));
    });
    expect(ok).toBe(true);
    expect(envApi.applySessionEnv).toHaveBeenCalledWith('s1', [
      { name: 'b.env', source: 'server', agent_id: undefined },
    ]);
    expect(result.current.activeKeys.has('server::b.env')).toBe(true);
  });

  it('remove unsets the profile against the same Session', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.activeKeys.size).toBe(1));
    envApi.getSessionEnvActive.mockResolvedValue({ active: [] });
    let ok = false;
    await act(async () => {
      ok = await result.current.removeFromSession(info('a.env'));
    });
    expect(ok).toBe(true);
    expect(envApi.unsetSessionEnv).toHaveBeenCalledWith('s1', [
      { name: 'a.env', source: 'server', agent_id: undefined },
    ]);
    expect(result.current.activeKeys.size).toBe(0);
  });

  it('a failed apply toasts and returns false', async () => {
    envApi.applySessionEnv.mockResolvedValue({ success: false, error: 'read-only' });
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let ok = true;
    await act(async () => {
      ok = await result.current.applyToSession(info('a.env'));
    });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('read-only');
  });

  it('warnings from the session action surface as warning toasts', async () => {
    envApi.applySessionEnv.mockResolvedValue({ success: true, warnings: ['2 lines skipped'] });
    const { result } = renderHook(() => useEnvironmentProfiles('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.applyToSession(info('a.env'));
    });
    expect(toast.warning).toHaveBeenCalledWith('2 lines skipped');
  });
});
