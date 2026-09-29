import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const envApi = vi.hoisted(() => ({
  getEnvFile: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

import { useEnvProfileContent } from '@/capabilities/env/hooks/useEnvProfileContent';

describe('useEnvProfileContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.getEnvFile.mockResolvedValue({
      success: true,
      content: 'A=1\n',
      in_use_by: ['api'],
    });
  });

  it('loads content and usage for the handed ref', async () => {
    const { result } = renderHook(() =>
      useEnvProfileContent({ name: 'a.env', source: 'server' }),
    );
    await waitFor(() => expect(result.current.content).toBe('A=1\n'));
    expect(result.current.inUseBy).toEqual(['api']);
    expect(envApi.getEnvFile).toHaveBeenCalledWith({ name: 'a.env', source: 'server' });
  });

  it('a null ref loads nothing', async () => {
    const { result } = renderHook(() => useEnvProfileContent(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(envApi.getEnvFile).not.toHaveBeenCalled();
    expect(result.current.content).toBeNull();
    expect(result.current.inUseBy).toEqual([]);
  });

  it('a fresh-but-identical ref does not refetch; a different identity does', async () => {
    const { rerender } = renderHook(
      ({ ref }) => useEnvProfileContent(ref),
      { initialProps: { ref: { name: 'a.env', source: 'server' as const } } },
    );
    await waitFor(() => expect(envApi.getEnvFile).toHaveBeenCalledTimes(1));

    rerender({ ref: { name: 'a.env', source: 'server' as const } });
    expect(envApi.getEnvFile).toHaveBeenCalledTimes(1);

    rerender({ ref: { name: 'b.env', source: 'server' as const } });
    await waitFor(() => expect(envApi.getEnvFile).toHaveBeenCalledTimes(2));
  });

  it('surfaces a failed get as an error with empty content', async () => {
    envApi.getEnvFile.mockResolvedValue({ success: false, error: 'not found' });
    const { result } = renderHook(() =>
      useEnvProfileContent({ name: 'gone.env', source: 'server' }),
    );
    await waitFor(() => expect(result.current.error).toBe('not found'));
    expect(result.current.content).toBeNull();
  });

  it('a stale in-flight response cannot land after the identity changed', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    envApi.getEnvFile.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ ref }) => useEnvProfileContent(ref),
      { initialProps: { ref: { name: 'a.env', source: 'server' as const } } },
    );
    rerender({ ref: { name: 'b.env', source: 'server' as const } });
    await waitFor(() => expect(result.current.content).toBe('A=1\n'));

    resolveFirst?.({ success: true, content: 'STALE\n' });
    await waitFor(() => expect(result.current.content).toBe('A=1\n'));
  });
});
