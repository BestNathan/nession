import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { createFilesApi } from '@/capabilities/files';
import { createTerminalAgentApi } from '@/product/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { AttachInfo } from '@/types';

const OriginalWebSocket = globalThis.WebSocket;

function attachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:s1',
    agent_address: 'ws://same/ws',
    connection_token: 'tok',
    addresses: [{ url: 'ws://same/ws', label: 'same', network_type: 'lan', priority: 10, status: 'reachable' }],
  };
}

describe('research acceptance T15', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('same-URL route intent replacement creates exactly one new physical socket', () => {
    const rt = new SessionRuntime({
      sessionId: 'agent:s1',
      sessionName: 's1',
      attachInfo: attachInfo(),
      orderedUrls: ['ws://same/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: { ready: true, urls: ['ws://same/ws'] },
      routeIntentEpoch: 0,
      createFilesApi,
      createTerminalAgentApi,
    });

    const before = MockWebSocket.instances.length;
    rt.updateContext({ routeIntentEpoch: 1 });
    expect(MockWebSocket.instances.length - before).toBe(1);
    rt.dispose();
  });
});
