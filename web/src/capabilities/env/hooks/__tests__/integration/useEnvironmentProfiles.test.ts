import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { EnvFileInfo } from '@/types';

const envApi = vi.hoisted(() => ({
  listEnvFiles: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

import { useEnvironmentProfiles } from '@/capabilities/env/hooks/useEnvironmentProfiles';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

describe('useEnvironmentProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.listEnvFiles.mockResolvedValue({ files: [info('a.env'), info('b.env')] });
  });

  it('loads the reusable profile list without a Session', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles.map((p) => p.name)).toEqual(['a.env', 'b.env']);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a list failure with a retry path', async () => {
    envApi.listEnvFiles.mockRejectedValueOnce(new Error('socket closed'));
    const { result } = renderHook(() => useEnvironmentProfiles());
    await waitFor(() => expect(result.current.error).toBe('socket closed'));
    expect(result.current.profiles).toEqual([]);

    envApi.listEnvFiles.mockResolvedValueOnce({ files: [info('a.env')] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.profiles.map((p) => p.name)).toEqual(['a.env']);
  });

  it('keeps the list usable when a later refresh fails', async () => {
    const { result } = renderHook(() => useEnvironmentProfiles());
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    envApi.listEnvFiles.mockRejectedValueOnce(new Error('agent offline'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe('agent offline');
    expect(result.current.profiles).toHaveLength(2);
  });
});
