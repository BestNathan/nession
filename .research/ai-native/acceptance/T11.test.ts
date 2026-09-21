import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { createFilesApi } from '@/capabilities/files';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { TerminalAgentApi } from '@/product/terminal';
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

describe('research acceptance T11', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('passes the runtime-specific attach timeout to every attach request', () => {
    const attach = vi.fn(() => new Promise(() => {}));
    const api = {
      attach,
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      onOutput: vi.fn(() => () => {}),
      onResize: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      ping: vi.fn(),
    } as unknown as TerminalAgentApi;

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
      createTerminalAgentApi: () => api,
      attachTimeoutMs: 321,
    } as ConstructorParameters<typeof SessionRuntime>[0]);

    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    MockWebSocket.instances[0].open();

    expect(attach).toHaveBeenCalledWith('s1', undefined, { timeoutMs: 321 });
    rt.dispose();
  });
});
