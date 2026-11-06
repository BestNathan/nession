import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGitRequest, type GitRequestTarget } from '../../hooks/useGitRequest';
import type { GitInvalidatedEvent } from '../../types';

// The hook subscribes to invalidations through the plugin singleton; keep the
// listener here so tests can drive reconnect/invalidation deterministically.
// `vi.hoisted` because the mock factory below runs before module initializers.
const harness = vi.hoisted(() => ({
  listeners: new Set<
    (event: { agent_id: string; session: string; epoch: number; reason?: string }) => void
  >(),
}));

vi.mock('../../GitPlugin', () => ({
  gitApi: {
    onInvalidated: (
      listener: (event: { agent_id: string; session: string; epoch: number; reason?: string }) => void,
    ) => {
      harness.listeners.add(listener);
      return () => {
        harness.listeners.delete(listener);
      };
    },
  },
}));

interface Snapshot {
  data: string | null;
  loading: boolean;
  error: string | null;
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
 * A `load` whose every call returns a Promise the test settles by hand. No
 * timers: completion order is exactly the order the test resolves the
 * deferreds in.
 */
function deferredLoad() {
  const requests: Deferred<string>[] = [];
  const load = vi.fn<(target: GitRequestTarget) => Promise<string>>(() => {
    const request = deferred<string>();
    requests.push(request);
    return request.promise;
  });
  return { load, requests };
}

/**
 * Render the hook and record every committed state. The transitions are the
 * evidence: a stale answer that lands late is a state the UI rendered, even if
 * a later commit hides it again.
 */
function renderGitRequest() {
  const { load, requests } = deferredLoad();
  const rendered: Snapshot[] = [];
  const view = renderHook(
    ({ agentId, sessionId }: { agentId: string | undefined; sessionId: string | undefined }) => {
      const state = useGitRequest({ agentId, sessionId, load });
      rendered.push({ data: state.data, loading: state.loading, error: state.error });
      return state;
    },
    { initialProps: { agentId: 'agent-1', sessionId: 'session-1' } },
  );
  return { ...view, load, requests, rendered };
}

function fireInvalidated(event: GitInvalidatedEvent) {
  act(() => {
    for (const listener of harness.listeners) {
      listener(event);
    }
  });
}

describe('useGitRequest request ordering', () => {
  beforeEach(() => {
    harness.listeners.clear();
  });

  it('keeps the newer manual refresh after the older mount read resolves late (SC-01)', async () => {
    const { result, load, requests, rendered } = renderGitRequest();
    // R1: the mount read, still in flight.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith({ agent_id: 'agent-1', session: 'session-1' });

    // R2: the user asks again before R1 answers. Same Session, same generation.
    act(() => result.current.refresh());
    expect(load).toHaveBeenCalledTimes(2);

    // R2 answers first with the state the user just asked for.
    await act(async () => {
      requests[1].resolve('B');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: 'B', loading: false, error: null });

    const publishedAt = rendered.findIndex((state) => state.data === 'B');
    expect(publishedAt).toBeGreaterThanOrEqual(0);

    // R1 answers later with the state that was already obsolete when R2
    // started. It must not win merely because it finished last.
    await act(async () => {
      requests[0].resolve('A');
      await requests[0].promise;
    });

    expect(result.current).toMatchObject({ data: 'B', loading: false, error: null });
    // No committed state after B's publication may show A again.
    expect(rendered.slice(publishedAt).map((state) => state.data)).not.toContain('A');
  });

  it('does not let an older failure clear the newer success (SC-02)', async () => {
    const { result, requests } = renderGitRequest();
    act(() => result.current.refresh());

    await act(async () => {
      requests[1].resolve('B');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: 'B', loading: false, error: null });

    // The mount read fails after the refresh already succeeded.
    await act(async () => {
      requests[0].reject(new Error('stale read failed'));
      await requests[0].promise.catch(() => undefined);
    });

    expect(result.current).toMatchObject({ data: 'B', loading: false, error: null });
  });

  it('does not let an older success replace the newer error (SC-02)', async () => {
    const { result, requests } = renderGitRequest();
    act(() => result.current.refresh());

    await act(async () => {
      requests[1].reject(new Error('newer read failed'));
      await requests[1].promise.catch(() => undefined);
    });
    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: 'newer read failed',
    });

    // The mount read succeeds after the refresh already failed; it must not
    // present itself as a recovery the user never saw complete.
    await act(async () => {
      requests[0].resolve('A');
      await requests[0].promise;
    });

    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: 'newer read failed',
    });
  });

  it('keeps the newest of two overlapping manual refreshes, including its loading state (SC-01/02)', async () => {
    const { result, load, requests } = renderGitRequest();
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    expect(load).toHaveBeenCalledTimes(3);

    // R2 (the middle read) answers while R3 is still in flight. It may neither
    // publish its data nor end the loading phase the newest read owns.
    await act(async () => {
      requests[1].resolve('B');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });

    // R3 answers with the newest state.
    await act(async () => {
      requests[2].resolve('C');
      await requests[2].promise;
    });
    expect(result.current).toMatchObject({ data: 'C', loading: false, error: null });

    // The mount read is older than both; it cannot rewind the view.
    await act(async () => {
      requests[0].resolve('A');
      await requests[0].promise;
    });
    expect(result.current).toMatchObject({ data: 'C', loading: false, error: null });
  });

  it('rejects the previous Session’s late response and still completes the new target’s read (SC-02)', async () => {
    const { result, rerender, load, requests } = renderGitRequest();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith({ agent_id: 'agent-1', session: 'session-1' });

    rerender({ agentId: 'agent-1', sessionId: 'session-2' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ agent_id: 'agent-1', session: 'session-2' });
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });

    // The old Session's answer arrives after the target moved on.
    await act(async () => {
      requests[0].resolve('old session state');
      await requests[0].promise;
    });
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });

    // The current target's own request is unaffected and finishes normally.
    await act(async () => {
      requests[1].resolve('new session state');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: 'new session state', loading: false, error: null });
  });

  it('rejects a response that was in flight across a reconnect and completes the post-reconnect read (SC-02)', async () => {
    const { result, load, requests } = renderGitRequest();
    expect(load).toHaveBeenCalledTimes(1);

    fireInvalidated({ agent_id: '', session: '', epoch: 0, reason: 'reconnect' });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      requests[0].resolve('before reconnect');
      await requests[0].promise;
    });
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });

    await act(async () => {
      requests[1].resolve('after reconnect');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: 'after reconnect', loading: false, error: null });
  });

  it('starts a fresh read on invalidation, ignores stale epochs and rejects the invalidated read (SC-02)', async () => {
    const { result, load, requests } = renderGitRequest();
    expect(load).toHaveBeenCalledTimes(1);

    fireInvalidated({ agent_id: 'agent-1', session: 'session-1', epoch: 1 });
    expect(load).toHaveBeenCalledTimes(2);

    // A repeated epoch and an invalidation for another Session are not new
    // reads for this target.
    fireInvalidated({ agent_id: 'agent-1', session: 'session-1', epoch: 1 });
    fireInvalidated({ agent_id: 'agent-1', session: 'session-other', epoch: 2 });
    expect(load).toHaveBeenCalledTimes(2);

    // The read started before the invalidation may not land over the new one.
    await act(async () => {
      requests[0].resolve('before invalidation');
      await requests[0].promise;
    });
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });

    await act(async () => {
      requests[1].resolve('after invalidation');
      await requests[1].promise;
    });
    expect(result.current).toMatchObject({ data: 'after invalidation', loading: false, error: null });
  });
});
