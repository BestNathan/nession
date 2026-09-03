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
    expect(a).toBe(b);
    registry.release('s1');
    expect(registry.get('s1')).not.toBeNull();
    registry.release('s1');
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

    expect(rt.activeUrl).toBe('ws://owner/ws');
    registry.release('s1');
    registry.release('s1');
    vi.runAllTimers();
  });

  it('update applies config from designated owner', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    registry.acquire('s1', config);
    registry.update('s1', { ...config, manualOverride: 'ws://updated/ws' });
    expect(registry.get('s1')!.activeUrl).toBe('ws://updated/ws');
    registry.release('s1');
    vi.runAllTimers();
  });

  it('StrictMode replay re-acquire cancels deferred dispose', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    const first = registry.acquire('s1', config);
    registry.release('s1');
    expect(registry.get('s1')).not.toBeNull();
    const second = registry.acquire('s1', config);
    expect(first).toBe(second);
    vi.runAllTimers();
    expect(registry.get('s1')).not.toBeNull();
    registry.release('s1');
    vi.runAllTimers();
    expect(registry.get('s1')).toBeNull();
  });

  it('dispose removes runtime after final release', () => {
    const registry = new SessionRuntimeRegistry();
    const rt = registry.acquire('s1', makeConfig('s1'));
    const disposeSpy = vi.spyOn(rt, 'dispose');
    registry.release('s1');
    expect(disposeSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});
