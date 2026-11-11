import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useGithubRequest, type GithubRequestTarget } from '@/capabilities/git/hooks/useGithubRequest';

type Response = { state: 'ok'; value: string } | { state: 'error'; code: 'api_error'; message: string };

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('useGithubRequest', () => {
  it('drops a response from the previous Session/remote generation', async () => {
    const first = deferred();
    const second = deferred();
    const load = (target: GithubRequestTarget) =>
      target.session === 's1' ? first.promise : second.promise;
    const { result, rerender } = renderHook(
      ({ session }: { session: string }) =>
        useGithubRequest({ agentId: 'a1', sessionId: session, load }),
      { initialProps: { session: 's1' } },
    );

    rerender({ session: 's2' });
    second.resolve({ state: 'ok', value: 'new' });
    await waitFor(() => expect(result.current.data?.value).toBe('new'));

    first.resolve({ state: 'ok', value: 'old' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data?.value).toBe('new');
  });

  it('lets a manual refresh supersede an older in-flight read', async () => {
    const mounted = deferred();
    const refreshed = deferred();
    let calls = 0;
    const load = (_target: GithubRequestTarget, refresh: boolean) => {
      calls += 1;
      return refresh ? refreshed.promise : mounted.promise;
    };
    const { result } = renderHook(() =>
      useGithubRequest({ agentId: 'a1', sessionId: 's1', load }),
    );

    act(() => result.current.refresh());
    refreshed.resolve({ state: 'ok', value: 'fresh' });
    await waitFor(() => expect(result.current.data?.value).toBe('fresh'));

    mounted.resolve({ state: 'ok', value: 'stale' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data?.value).toBe('fresh');
    expect(calls).toBe(2);
  });

  it('keeps the provider error code instead of flattening it to a string', async () => {
    const { result } = renderHook(() =>
      useGithubRequest({
        agentId: 'a1',
        sessionId: 's1',
        load: async () => ({ state: 'error', code: 'not_authenticated', message: 'no token' }),
      }),
    );
    await waitFor(() => expect(result.current.error?.code).toBe('not_authenticated'));
    expect(result.current.data).toBeNull();
  });

  it('does not fetch when disabled or when the Session is missing', async () => {
    let calls = 0;
    renderHook(() =>
      useGithubRequest({
        agentId: 'a1',
        sessionId: undefined,
        load: async () => {
          calls += 1;
          return { state: 'ok', value: 'x' };
        },
      }),
    );
    await Promise.resolve();
    expect(calls).toBe(0);
  });
});
