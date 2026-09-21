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
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses: [{ url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' }],
  };
}

describe('research acceptance T07', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('projects transport reconnect attempts separately from attach reconnect count', () => {
    const rt = new SessionRuntime({
      sessionId: 'agent:s1',
      sessionName: 's1',
      attachInfo: attachInfo(),
      orderedUrls: ['ws://a/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: { ready: true, urls: ['ws://a/ws'] },
      routeIntentEpoch: 0,
      createFilesApi,
      createTerminalAgentApi,
    });

    const initial = rt.getSnapshot() as typeof rt.getSnapshot extends () => infer T ? T & { transportReconnectAttempts?: number } : never;
    expect(initial.transportReconnectAttempts).toBe(0);

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.serverClose();

    const afterLoss = rt.getSnapshot() as typeof initial;
    expect(afterLoss.transportReconnectAttempts).toBe(1);
    expect(afterLoss.reconnectCount).toBe(0);
    rt.dispose();
  });
});
