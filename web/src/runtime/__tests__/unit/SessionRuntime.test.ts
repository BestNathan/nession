import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionRuntime } from '@/runtime/SessionRuntime';
import type { AttachInfo } from '@/types';

const OriginalWebSocket = globalThis.WebSocket;

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:s1',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

function makeConfig(overrides: Partial<ConstructorParameters<typeof SessionRuntime>[0]> = {}) {
  return {
    sessionId: 'agent:s1',
    sessionName: 's1',
    attachInfo: makeAttachInfo(),
    orderedUrls: ['ws://a/ws', 'ws://b/ws'],
    manualOverride: null,
    forcedRelay: false,
    addressPlan: { ready: true, urls: ['ws://a/ws', 'ws://b/ws'] },
    transportFirst: true,
    routeEpoch: 0,
    ...overrides,
  };
}

describe('SessionRuntime', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('creates P2P connection and file capability when address plan is ready', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.activeUrl).toBe('ws://a/ws');
    expect(rt.getP2PConnection()).not.toBeNull();
    expect(rt.getFileCapability()).not.toBeNull();
    rt.dispose();
  });

  it('clears client when forced to relay', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.updateContext({ forcedRelay: true });
    expect(rt.activeUrl).toBeNull();
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('advances candidate and reconfigures client on disconnect', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    rt.dispose();
  });

  it('reports waitingForAddressPlan when plan is not ready', () => {
    const rt = new SessionRuntime(makeConfig({
      addressPlan: { ready: false, urls: [] },
    }));
    expect(rt.waitingForAddressPlan).toBe(true);
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('subscribeConnectionState returns noop when no client', () => {
    const rt = new SessionRuntime(makeConfig({ attachInfo: null }));
    const unsub = rt.subscribeConnectionState(() => {});
    expect(unsub).toBeTypeOf('function');
    unsub();
  });
});
