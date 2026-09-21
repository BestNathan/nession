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
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

describe('research acceptance T12', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('projects candidate-rotation recovery mode from existing runtime state', () => {
    const rt = new SessionRuntime({
      sessionId: 'agent:s1',
      sessionName: 's1',
      attachInfo: attachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: { ready: true, urls: ['ws://a/ws', 'ws://b/ws'] },
      routeIntentEpoch: 0,
      createFilesApi,
      createTerminalAgentApi,
    });

    expect((rt.getSnapshot() as { recoveryMode?: string }).recoveryMode).toBe('none');
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect((rt.getSnapshot() as { recoveryMode?: string }).recoveryMode).toBe('candidate-rotation');
    rt.dispose();
  });
});
