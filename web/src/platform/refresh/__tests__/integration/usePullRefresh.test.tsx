import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RefreshProvider } from '../../RefreshProvider';
import { RefreshSignalBus } from '../../RefreshSignalBus';
import { usePullRefresh } from '../../usePullRefresh';
import { useRefreshRuntime } from '../../useRefreshRuntime';
import type { PullRefreshPolicy } from '../../types';
import { FakeClock, deferred, flush } from '../helpers';

const POLICY: PullRefreshPolicy = {
  timeoutMs: 10_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
};

function setup() {
  const clock = new FakeClock();
  const signals = new RefreshSignalBus(() => clock.now());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RefreshProvider clock={clock} signals={signals}>{children}</RefreshProvider>
  );
  return { clock, signals, wrapper };
}

describe('usePullRefresh adapter (#4602 SC-02/SC-03)', () => {
  it('reads once on mount and publishes through apply', async () => {
    const { wrapper } = setup();
    const read = deferred<string[]>();
    const pull = vi.fn(() => read.promise);
    const apply = vi.fn();
    const { result } = renderHook(
      () => usePullRefresh<string[]>({ context: ['a'], pull, apply, policy: POLICY }),
      { wrapper },
    );
    expect(pull).toHaveBeenCalledTimes(1);
    expect(result.current.status.loading).toBe(true);

    await act(async () => { read.resolve(['row']); await flush(); });
    expect(apply).toHaveBeenCalledWith(['row']);
    expect(result.current.status.loading).toBe(false);
  });

  it('retires the previous context immediately when identity changes', async () => {
    const { wrapper } = setup();
    const reads = [deferred<string[]>(), deferred<string[]>()];
    let call = 0;
    const pull = vi.fn(() => reads[Math.min(call++, 1)].promise);
    const apply = vi.fn();
    const { result, rerender } = renderHook(
      ({ target }: { target: string }) => usePullRefresh<string[]>({
        context: [target], pull, apply, policy: POLICY,
      }),
      { wrapper, initialProps: { target: 'a' } },
    );
    rerender({ target: 'b' });
    expect(pull).toHaveBeenCalledTimes(2);

    // The retired context's late answer must never publish.
    await act(async () => { reads[0].resolve(['old']); await flush(); });
    expect(apply).not.toHaveBeenCalled();
    await act(async () => { reads[1].resolve(['new']); await flush(); });
    expect(apply).toHaveBeenCalledWith(['new']);
    expect(result.current.status.stale).toBe(false);
  });

  it('does not read while disabled and marks data stale', async () => {
    const { wrapper } = setup();
    const pull = vi.fn(() => Promise.resolve(['row']));
    const apply = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePullRefresh<string[]>({
        context: ['a'], pull, apply, policy: POLICY, enabled,
      }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(pull).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => { await flush(); });
    expect(pull).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    expect(result.current.status.stale).toBe(true);
  });

  it('refreshes active surfaces on a reconnect signal and dedupes foreground', async () => {
    const { clock, signals, wrapper } = setup();
    const pull = vi.fn(() => Promise.resolve(['row']));
    renderHook(
      () => usePullRefresh<string[]>({ context: ['a'], pull, apply: () => {}, policy: POLICY }),
      { wrapper },
    );
    await act(async () => { await flush(); });
    expect(pull).toHaveBeenCalledTimes(1);

    await act(async () => { signals.emit({ signal: 'reconnect', generation: 2 }); await flush(); });
    expect(pull).toHaveBeenCalledTimes(2);

    // A foreground resume covered by that reconnect must not add a read.
    clock.advance(200);
    await act(async () => { signals.emit({ signal: 'foreground' }); await flush(); });
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('settles waiters and leaves no registration behind on unmount', async () => {
    const { wrapper } = setup();
    const read = deferred<string[]>();
    const pull = vi.fn(() => read.promise);
    const { result, unmount } = renderHook(
      () => usePullRefresh<string[]>({ context: ['a'], pull, apply: () => {}, policy: POLICY }),
      { wrapper },
    );
    let outcome: string | undefined;
    void result.current.refresh('manual').then((value) => { outcome = value; });
    unmount();
    await flush();
    expect(outcome).toBe('cancelled');
  });

  it('exposes the shared runtime to consumers', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRefreshRuntime(), { wrapper });
    expect(result.current.scheduler).toBeDefined();
    expect(result.current.signals).toBeDefined();
  });
});