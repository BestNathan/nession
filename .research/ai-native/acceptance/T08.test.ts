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

describe('research acceptance T08', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('exposes a typed socket-loss recovery cause and clears it after stable attach', () => {
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

    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    const socket = MockWebSocket.instances[0];
    socket.open();
    rt.attachController.dispatch({ type: 'ATTACH_OK' });

    socket.serverClose();
    expect((rt.getSnapshot() as { lastRecoveryCause?: string }).lastRecoveryCause).toBe('socket-loss');

    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    expect((rt.getSnapshot() as { lastRecoveryCause?: string | null }).lastRecoveryCause).toBeNull();
    rt.dispose();
  });
});
