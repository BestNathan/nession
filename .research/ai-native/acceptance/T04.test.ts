import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { createFilesApi } from '@/capabilities/files';
import { createTerminalAgentApi } from '@/product/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
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
    ],
  };
}

describe('research acceptance T04', () => {
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

  it('one transport loss cycle emits one recovery transition', async () => {
    const rt = new SessionRuntime({
      sessionId: 'agent:s1',
      sessionName: 's1',
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: { ready: true, urls: ['ws://a/ws'] },
      routeIntentEpoch: 0,
      transportReady: false,
      createFilesApi,
      createTerminalAgentApi,
    });

    const socket = MockWebSocket.instances[0];
    socket.open();

    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    expect(rt.attachState.phase).toBe('attached');

    const events: string[] = [];
    rt.subscribeRuntimeEvents((event) => events.push(event.type));

    socket.serverClose();
    expect(rt.attachState.phase).toBe('reconnecting');
    expect(events.filter((type) => type === 'route-intent-changed')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_100);

    expect(events.filter((type) => type === 'route-intent-changed')).toHaveLength(1);
    rt.dispose();
  });
});
