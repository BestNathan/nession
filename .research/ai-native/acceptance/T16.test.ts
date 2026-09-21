import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { createFilesApi } from '@/capabilities/files';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { AttachResult, TerminalAgentApi } from '@/product/terminal';
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

describe('research acceptance T16', () => {
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

  it('uses the newest viewport size on attach after reconnect', async () => {
    const attach = vi.fn((): Promise<AttachResult> => Promise.resolve({ ok: true }));
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
      lastResize: { cols: 80, rows: 24 },
      transportReady: true,
      createFilesApi,
      createTerminalAgentApi: () => api,
    });

    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    MockWebSocket.instances[0].open();
    await flush();
    expect(attach).toHaveBeenCalledWith('s1', { cols: 80, rows: 24 }, expect.anything());

    MockWebSocket.instances[0].serverClose();
    rt.updateViewportSize({ cols: 120, rows: 40 });
    expect(rt.getSnapshot().lastResize).toEqual({ cols: 120, rows: 40 });

    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.instances[1].open();
    await flush();

    expect(attach).toHaveBeenLastCalledWith('s1', { cols: 120, rows: 40 }, expect.anything());
    rt.dispose();
  });
});
