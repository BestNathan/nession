import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { EnvFileInfo } from '@/types';

const envApi = vi.hoisted(() => ({
  listEnvFiles: vi.fn(),
}));

vi.mock('@/capabilities/env/envApi', () => ({ envApi }));

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

  // #4602 SC-03: one read per context. The #2878 hazard — an older answer
  // overwriting a newer one — is now structural: a second refresh is held
  // behind the first instead of racing it. These prove the held refresh still
  // lands its own answer, and that a late reply from a retired context cannot
  // publish at all.

  it('lands a queued refresh answer after the mount read, never before it', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());
    expect(requests).toHaveLength(1);

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    // Held, not concurrent.
    expect(requests).toHaveLength(1);

    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    expect(requests).toHaveLength(2);

    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps a newer success when the earlier read failed', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[0].reject(new Error('stale failure'));
      await requests[0].promise.catch(() => {});
    });
    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });

    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('reports a background refresh without raising the initial-load state', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());
    expect(result.current.loading).toBe(true);

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });

    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    // The first projection landed, so the page is no longer in initial load;
    // the held refresh is reported as refreshing, not as a blank list.
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.profiles.map((p) => p.name)).toEqual(['old.env']);

    await act(async () => {
      requests[1].resolve({ files: [info('new.env')] });
      await b;
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.profiles.map((p) => p.name)).toEqual(['new.env']);
  });

  it('keeps a newest empty result against an earlier non-empty answer', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    await act(async () => {
      requests[1].resolve({ files: [] });
      await b;
    });

    // An authoritative empty list is a result, not a failure.
    expect(result.current.profiles).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps the newest failure visible and retains the last known list', async () => {
    const requests = deferredLists();
    const { result } = renderHook(() => useEnvironmentProfiles());

    let b!: Promise<void>;
    act(() => { b = result.current.refresh(); });
    await act(async () => {
      requests[0].resolve({ files: [info('old.env')] });
      await requests[0].promise;
    });
    await act(async () => {
      requests[1].reject(new Error('newest failed'));
      await b;
    });

    expect(result.current.error).toBe('newest failed');
    // #4602 §3: a failure keeps the last successful data and marks it stale.
    expect(result.current.profiles.map((p) => p.name)).toEqual(['old.env']);
    expect(result.current.stale).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('never publishes a reply from a retired transport context', async () => {
    const requests = deferredLists();
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => useEnvironmentProfiles({ connectionRevision: revision }),
      { initialProps: { revision: 1 } },
    );
    expect(requests).toHaveLength(1);

    rerender({ revision: 2 });
    expect(requests).toHaveLength(2);

    // The replaced transport's answer arrives last and must not publish.
    await act(async () => {
      requests[1].resolve({ files: [info('current.env')] });
      await requests[1].promise;
    });
    await act(async () => {
      requests[0].resolve({ files: [info('retired.env')] });
      await requests[0].promise;
    });

    expect(result.current.profiles.map((p) => p.name)).toEqual(['current.env']);
  });
});
