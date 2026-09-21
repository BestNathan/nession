import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { createFilesApi } from '@/capabilities/files';
import { createTerminalAgentApi } from '@/product/terminal';
import { ATTACH_TIMEOUT_MS } from '@/platform/attach/AttachStateMachine';
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('research acceptance T10', () => {
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

  it('uses a per-runtime attach retry limit', async () => {
    const rt = new SessionRuntime({
      sessionId: 'agent:s1',
      sessionName: 's1',
      attachInfo: attachInfo(),
      orderedUrls: ['ws://a/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: { ready: true, urls: ['ws://a/ws'] },
      routeIntentEpoch: 0,
      transportReady: true,
      createFilesApi,
      createTerminalAgentApi,
      attachRetryLimit: 1,
    } as ConstructorParameters<typeof SessionRuntime>[0]);

    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    MockWebSocket.instances[0].open();

    vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
    await flush();
    expect(rt.attachState.reconnectCount).toBe(1);

    vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
    await flush();

    expect(rt.getAgentTerminalApi()).toBeNull();
    rt.dispose();
  });
});
