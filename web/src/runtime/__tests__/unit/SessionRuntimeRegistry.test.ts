import { describe, it, expect, vi, afterEach } from 'vitest';
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
    routeEpoch: 0,
  };
}

describe('SessionRuntimeRegistry', () => {
  afterEach(() => {
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
    expect(registry.get('s1')).toBeNull();
  });

  it('StrictMode double acquire/release keeps one runtime until both release', () => {
    const registry = new SessionRuntimeRegistry();
    const config = makeConfig('s1');
    const first = registry.acquire('s1', config);
    const second = registry.acquire('s1', config);
    expect(first).toBe(second);
    registry.release('s1');
    registry.release('s1');
    expect(registry.get('s1')).toBeNull();
  });

  it('dispose removes runtime after final release', () => {
    const registry = new SessionRuntimeRegistry();
    const rt = registry.acquire('s1', makeConfig('s1'));
    const disposeSpy = vi.spyOn(rt, 'dispose');
    registry.release('s1');
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});
