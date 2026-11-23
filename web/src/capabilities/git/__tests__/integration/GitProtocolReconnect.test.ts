// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitApi } from '@/capabilities/git';
import { WIRE as AGENT_LIST_WIRE } from '@/generated/protocol/core/server-agent-list/v1';
import { WIRE as GIT_STATUS_WIRE } from '@/generated/protocol/git/status/v2';
import { WebSocketService } from '@/platform/socket';
import type { SocketMessage } from '@/platform/socket/types';
import { agentsApi } from '@/product/agent';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { Agent } from '@/types';

/**
 * #3990 SC-02: a controlled reconnect with changed/removed Agent manifests
 * must not dispatch a Git call using the previous generation's contract
 * version.
 *
 * The socket loss empties the protocol directory, so the call refuses and
 * sends nothing until the replacement socket delivers its own Agent list. A
 * changed manifest then produces the truthful incompatibility, and a fresh
 * supported manifest lets the call execute normally. This is the consumer end
 * of the transport tests: those prove what the directory holds across
 * generations, this proves what a capability does with it.
 */

const OriginalWebSocket = globalThis.WebSocket;
const TEST_URL = 'ws://reconnect.test/ws';

const statusReq = { agent_id: 'a1', session: 'a1:work' } as const;

const statusResponse = {
  state: 'ok',
  status: {
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    modified: [],
    untracked: [],
    unmerged: [],
  },
  root: '/repo',
  snapshot: { token: 'token-1', head: 'head-1', root: '/repo' },
  truncated: false,
  truncated_bytes: 0,
} as const;

/** An agent list entry advertising exactly the given versions per unit. */
function makeAgent(protocols: Record<string, number[]>): Agent {
  return {
    agent_id: 'a1',
    hostname: 'host-a1',
    ip_address: '127.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 0,
    last_heartbeat: '2026-01-01T00:00:00Z',
    protocols: {
      provider: 'a1',
      protocols: Object.fromEntries(
        Object.entries(protocols).map(([unit, versions]) => [unit, { versions }]),
      ),
    },
  };
}

function sentFrames(socket: MockWebSocket): SocketMessage[] {
  return socket.send.mock.calls.map(
    (call) => JSON.parse(call[0] as string) as SocketMessage,
  );
}

function lastFrameOfType(
  socket: MockWebSocket,
  type: string,
): SocketMessage | undefined {
  return [...sentFrames(socket)].reverse().find((frame) => frame.msg_type === type);
}

/** Answer a request frame with a response echoing its type and envelope id. */
function reply(
  socket: MockWebSocket,
  request: SocketMessage,
  payload: Record<string, unknown>,
): void {
  socket.message(JSON.stringify({
    msg_type: request.msg_type,
    id: request.id,
    timestamp: Date.now(),
    payload,
  }));
}

describe('Git protocol across a physical reconnect (#3990)', () => {
  let service: WebSocketService;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    service = new WebSocketService(TEST_URL, [agentsApi, gitApi]);
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  async function connect(): Promise<MockWebSocket> {
    const connected = service.connect();
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    socket.open();
    await connected;
    expect(service.connectionState).toBe('connected');
    return socket;
  }

  /** Answer the next agent-list request with this single-agent snapshot. */
  async function listAgentsWith(socket: MockWebSocket, agent: Agent): Promise<void> {
    const listing = agentsApi.listAgents();
    const frame = lastFrameOfType(socket, AGENT_LIST_WIRE);
    expect(frame, 'the list request must reach this socket').toBeDefined();
    reply(socket, frame!, { agents: [agent] });
    await listing;
  }

  /** Lose the socket, open its replacement, and wait for it to be connected. */
  async function reconnect(previous: MockWebSocket): Promise<MockWebSocket> {
    previous.serverClose();
    expect(service.connectionState).toBe('reconnecting');

    const reconnected = service.reconnectNow();
    const replacement = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    replacement.open();
    await reconnected;
    expect(service.connectionState).toBe('connected');
    return replacement;
  }

  it('refuses a Git call after reconnect until the replacement socket delivers its own Agent list', async () => {
    const first = await connect();
    await listAgentsWith(first, makeAgent({ 'git.status': [2] }));

    // The same call works on the generation whose list named this target.
    const addressed = gitApi.gitStatus(statusReq);
    const firstStatus = lastFrameOfType(first, GIT_STATUS_WIRE);
    expect(firstStatus?.payload).toMatchObject({ contract_version: 2 });
    reply(first, firstStatus!, statusResponse);
    await expect(addressed).resolves.toEqual(statusResponse);

    const replacement = await reconnect(first);
    const before = sentFrames(replacement).length;

    await expect(gitApi.gitStatus(statusReq)).rejects.toThrow(
      '`a1` is not in the protocol directory yet',
    );
    // The refusal must happen locally. A frame on the replacement wire would
    // mean the obsolete manifest resolved a version and dispatched anyway.
    expect(sentFrames(replacement), 'nothing may reach the replacement wire')
      .toHaveLength(before);
  });

  it('uses only the replacement manifest: changed versions refuse, supported versions execute', async () => {
    const first = await connect();
    await listAgentsWith(first, makeAgent({ 'git.status': [2] }));
    const replacement = await reconnect(first);

    // The replacement connection's own snapshot superseded the old one.
    await listAgentsWith(replacement, makeAgent({ 'git.status': [1] }));
    await expect(gitApi.gitStatus(statusReq)).rejects.toThrow(
      '`a1` offers `git.status` at [v1], which this client cannot read',
    );

    await listAgentsWith(replacement, makeAgent({ 'git.status': [2] }));
    const addressed = gitApi.gitStatus(statusReq);
    const replacementStatus = lastFrameOfType(replacement, GIT_STATUS_WIRE);
    expect(replacementStatus?.payload).toMatchObject({ contract_version: 2 });
    reply(replacement, replacementStatus!, statusResponse);
    await expect(addressed).resolves.toEqual(statusResponse);
  });
});
