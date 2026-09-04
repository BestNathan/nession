import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntimeConfig } from '@/runtime/SessionRuntime';
import type { AttachInfo } from '@/types';

function makeConfig(sessionId: string): SessionRuntimeConfig {
  const attachInfo: AttachInfo = {
    mode: 'p2p',
    session_id: sessionId,
    agent_address: 'ws://agent/ws',
    connection_token: 'tok',
  };
  return {
    sessionId,
    sessionName: 'sess',
    attachInfo,
    orderedUrls: ['ws://agent/ws'],
    manualOverride: null,
    forcedRelay: false,
    addressPlan: { ready: true, urls: ['ws://agent/ws'] },
    transportFirst: false,
    routeIntentEpoch: 0,
  };
}

describe('SessionRuntimeRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ref-counts acquire/release for the same session', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    const a = registry.acquire('s1', config);
    const b = registry.acquire('s1', config);
    expect(a.runtime).toBe(b.runtime);
    a.release();
    expect(registry.get('s1')).not.toBeNull();
    b.release();
    vi.runAllTimers();
    expect(registry.get('s1')).toBeNull();
  });

  it('secondary acquire does not mutate existing runtime config', () => {
    const registry = new SessionRuntimeRegistry();
    const ownerConfig = makeConfig('s1');
    ownerConfig.manualOverride = 'ws://owner/ws';
    const rt = registry.acquire('s1', ownerConfig);
    registry.update('s1', ownerConfig);

    const secondaryConfig = makeConfig('s1');
    secondaryConfig.manualOverride = 'ws://secondary/ws';
    registry.acquire('s1', secondaryConfig);

    expect(rt.runtime.activeUrl).toBe('ws://owner/ws');
    rt.release();
    registry.acquire('s1', secondaryConfig).release();
    vi.runAllTimers();
  });

  it('update applies config from designated owner', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    const lease = registry.acquire('s1', config);
    registry.update('s1', { ...config, manualOverride: 'ws://updated/ws' });
    expect(registry.get('s1')!.activeUrl).toBe('ws://updated/ws');
    lease.release();
    vi.runAllTimers();
  });

  it('StrictMode replay re-acquire cancels deferred dispose', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    const first = registry.acquire('s1', config);
    first.release();
    expect(registry.get('s1')).not.toBeNull();
    const second = registry.acquire('s1', config);
    expect(first.runtime).toBe(second.runtime);
    vi.runAllTimers();
    expect(registry.get('s1')).not.toBeNull();
    second.release();
    vi.runAllTimers();
    expect(registry.get('s1')).toBeNull();
  });

  it('dispose removes runtime after final release', () => {
    const registry = new SessionRuntimeRegistry();
    const lease = registry.acquire('s1', makeConfig('s1'));
    const disposeSpy = vi.spyOn(lease.runtime, 'dispose');
    lease.release();
    expect(disposeSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it('shares runtime when deprecated transportFirst mode changes', () => {
    const registry = new SessionRuntimeRegistry();
    const legacy = registry.acquire('s1', makeConfig('s1'));
    legacy.release();

    const sessionFirstConfig = makeConfig('s1');
    sessionFirstConfig.transportFirst = true;
    const sessionFirst = registry.acquire('s1', sessionFirstConfig);

    expect(sessionFirst.runtime).toBe(legacy.runtime);
    expect(sessionFirst.runtime.transportFirstMode).toBe(true);
    sessionFirst.release();
    vi.runAllTimers();
  });

  it('double release of the same lease is a no-op', () => {
    const registry = new SessionRuntimeRegistry();
    const lease = registry.acquire('s1', makeConfig('s1'));
    const disposeSpy = vi.spyOn(lease.runtime, 'dispose');
    lease.release();
    lease.release();
    vi.runAllTimers();
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(registry.get('s1')).toBeNull();
  });

  it('stale release from a pre-recreate lease cannot decrement the replacement runtime', () => {
    const registry = new SessionRuntimeRegistry();
    const stale = registry.acquire('s1', makeConfig('s1'));
    stale.release();
    // Deferred dispose still pending — entry exists with zero leases.

    const sessionFirstConfig = makeConfig('s1');
    sessionFirstConfig.transportFirst = true;
    const replacement = registry.acquire('s1', sessionFirstConfig);
    expect(replacement.runtime.transportFirstMode).toBe(true);

    // Old holder's cleanup fires late against the replacement entry.
    stale.release();
    vi.runAllTimers();
    expect(registry.get('s1')).not.toBeNull();

    replacement.release();
    vi.runAllTimers();
    expect(registry.get('s1')).toBeNull();
  });
});
