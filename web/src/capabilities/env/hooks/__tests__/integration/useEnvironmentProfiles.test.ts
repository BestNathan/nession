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

interface ListAnswer {
  files: EnvFileInfo[];
  error?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Every list read is settled by the test. Completion order is exactly the
 * order the test resolves the deferreds in, so A-before-B and B-before-A are
 * both expressible without timers.
 */
function deferredLists(): Deferred<ListAnswer>[] {
  const requests: Deferred<ListAnswer>[] = [];
  envApi.listEnvFiles.mockImplementation(() => {
    const request = deferred<ListAnswer>();
    requests.push(request);
    return request.promise;
  });
  return requests;
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

  it('keeps the newest success when the superseded success settles later (SC-01)', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());
    expect(requests).toHaveLength(1);

    // B starts while A is still in flight, then B answers the new list.
    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);

    // A answers last with the snapshot it took before B. It is superseded.
    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps the newest success when the superseded request fails later (SC-01)', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });

    await act(async () => {
      requests[0].reject(new Error('stale failure'));
      await requests[0].promise.catch(() => {});
    });
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('loading belongs only to the newest list read (SC-01)', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());
    expect(requests).toHaveLength(1);

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    expect(requests).toHaveLength(2);

    // A settles while B is still pending: A must not clear B's loading state
    // or publish its older list.
    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.profiles).toEqual([]);

    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
  });

  it('keeps a newest empty result against a superseded non-empty answer (SC-01)', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[1].resolve({ files: [] });
      await b;
    });
    expect(result.current.profiles).toEqual([]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    expect(result.current.profiles).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('keeps the newest failure visible against a superseded success (SC-01)', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[1].reject(new Error('newest failed'));
      await b;
    });
    expect(result.current.error).toBe('newest failed');

    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    expect(result.current.error).toBe('newest failed');
    expect(result.current.profiles).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
