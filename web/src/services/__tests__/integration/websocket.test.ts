// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketService } from '@/services/socket';
import type { CapabilityPlugin, SocketMessage } from '@/services/socket/types';
import { agentsApi } from '@/features/agents';
import { sessionsApi } from '@/features/sessions';
import { serverApi } from '@/features/server';
import { envApi } from '@/features/env';
import { commandsApi } from '@/features/commands';
import { claudeCodeApi } from '@/features/claude-code';
import { terminalServerApi } from '@/features/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { Agent, AuthResponse, Session } from '@/types';

const OriginalWebSocket = globalThis.WebSocket;

const TEST_URL = 'ws://integration.test/ws';
const AUTH_PAYLOAD = { auth_token: 'test-token', client_id: 'test-client' };

/**
 * Transport + features integration suite.
 *
 * The legacy websocket integration suite drove the old singleton facade
 * (create/get/destroy cycle, 'authenticated' status) over a fake socket. The
 * singleton facade is gone; this file exercises the replacement — the
 * WebSocketService transport with the app's full capability set installed —
 * over the same fake WebSocket, proving the wire-level semantics the per-unit
 * suites assume: handshake-then-connected, request correlation, push fan-out
 * into the feature singletons' consumers, plugin replace/unregister, and the
 * re-login remount that keeps a newer service alive across a stale teardown.
 *
 * The plugin list mirrors useAppConnection's SERVER_CAPABILITIES (the module
 * singletons install into whichever service owns them); the handshake mirrors
 * the app's client.auth + auth_token/client_id flow. `maxReconnectAttempts: 0`
 * keeps failure paths deterministic — no timers ever get scheduled.
 */
const SERVER_CAPABILITIES = [
  agentsApi,
  sessionsApi,
  serverApi,
  envApi,
  commandsApi,
  claudeCodeApi,
  terminalServerApi,
];

/** Services created during the current test; disposed (idempotently) in afterEach. */
const activeServices = new Set<WebSocketService>();

/** Yield to the microtask queue a few times (promise chains settle in order). */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** Parse the nth JSON frame a mock socket sent over the wire. */
function frameAt(socket: MockWebSocket, index: number): SocketMessage {
  const raw = socket.send.mock.calls[index]?.[0] as string | undefined;
  return JSON.parse(raw ?? '') as SocketMessage;
}

/** Last frame a mock socket sent (auth frames and requests alike). */
function lastFrame(socket: MockWebSocket): SocketMessage {
  return frameAt(socket, socket.send.mock.calls.length - 1);
}

/** Encode a server → client frame (string payloads only in this suite). */
function encodeFrame(type: string, id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ msg_type: type, id, timestamp: Date.now(), payload });
}

/** Answer a request frame with a response that echoes type + envelope id. */
function reply(socket: MockWebSocket, request: SocketMessage, payload: Record<string, unknown>): void {
  socket.message(encodeFrame(request.msg_type, request.id, payload));
}

/** Build a service with the app's capability set and an auth handshake. */
function makeService(): WebSocketService {
  const service = new WebSocketService(TEST_URL, SERVER_CAPABILITIES, {
    maxReconnectAttempts: 0,
    handshake: (surface) =>
      surface.request<AuthResponse>('client.auth', AUTH_PAYLOAD).then((res) => {
        if (res.status !== 'success') {
          throw new Error(res.message || 'Authentication failed');
        }
      }),
  });
  activeServices.add(service);
  return service;
}

/**
 * Drive a full connect: open the socket, answer the client.auth handshake
 * frame, and wait for the transport to reach its post-handshake 'connected'.
 */
async function connectAndAuth(service: WebSocketService): Promise<MockWebSocket> {
  const connected = service.connect();
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  socket.open();

  const auth = frameAt(socket, 0);
  expect(auth.msg_type).toBe('client.auth');
  reply(socket, auth, { status: 'success' });

  await connected;
  expect(service.connectionState).toBe('connected');
  return socket;
}

/** Test fixture, shape-matched to the shared Agent type. */
function makeAgent(agentId: string): Agent {
  return {
    agent_id: agentId,
    hostname: `host-${agentId}`,
    ip_address: '127.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 0,
    last_heartbeat: '2026-01-01T00:00:00Z',
  };
}

/** Test fixture, shape-matched to the shared Session type. */
function makeSession(agentId: string, sessionName: string): Session {
  return {
    session_id: `${agentId}:${sessionName}`,
    agent_id: agentId,
    session_name: sessionName,
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
  };
}

/** Plugin whose install/teardown are recorded into a shared event log. */
function makePlugin(name: string, events: string[]): CapabilityPlugin {
  return {
    name,
    install: () => {
      events.push(`install:${name}`);
      return () => {
        events.push(`teardown:${name}`);
      };
    },
  };
}

describe('WebSocketService + feature singletons', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    activeServices.clear();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    for (const service of activeServices) {
      service.dispose();
    }
    activeServices.clear();
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  describe('connect lifecycle', () => {
    it('stays connecting through the auth handshake and only then reaches connected', async () => {
      const service = makeService();
      const states: string[] = [];
      service.onConnectionStateChange((state) => states.push(state));

      const connected = service.connect();
      expect(service.connectionState).toBe('connecting');
      expect(MockWebSocket.instances).toHaveLength(1);
      const socket = MockWebSocket.instances[0];
      expect(socket.url).toBe(TEST_URL);
      expect(socket.send).not.toHaveBeenCalled(); // nothing on the wire before open

      socket.open();
      const auth = frameAt(socket, 0);
      expect(auth.msg_type).toBe('client.auth');
      expect(auth.payload).toEqual(AUTH_PAYLOAD);

      // Handshake not acknowledged yet: connect() stays pending, state frozen.
      let resolved = false;
      void connected.then(() => {
        resolved = true;
      });
      await drainMicrotasks();
      expect(resolved).toBe(false);
      expect(service.connectionState).toBe('connecting');

      reply(socket, auth, { status: 'success' });
      await connected;
      expect(service.connectionState).toBe('connected');
      expect(states).toEqual(['connecting', 'connected']);
    });

    it('rejects the connection when the server refuses auth', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const service = makeService();
        const connected = service.connect();
        const socket = MockWebSocket.instances[0];
        socket.open();

        const auth = frameAt(socket, 0);
        reply(socket, auth, { status: 'failed', message: 'Bad token' });

        await expect(connected).rejects.toThrow('Bad token');
        expect(service.connectionState).toBe('disconnected');
        // The failed connection left the features bound but unusable — the
        // transport rejects at the 'disconnected' state gate.
        await expect(agentsApi.listAgents()).rejects.toThrow('Connection lost');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('feature requests over the wire', () => {
    it('listAgents sends client.agents.list and unwraps the response agents', async () => {
      const service = makeService();
      const socket = await connectAndAuth(service);

      const pending = agentsApi.listAgents();
      const request = frameAt(socket, 1); // frame 0 is the auth handshake
      expect(request.msg_type).toBe('client.agents.list');
      expect(request.payload).toEqual({});
      expect(typeof request.id).toBe('string');

      const agents = [makeAgent('agent-1'), makeAgent('agent-2')];
      reply(socket, request, { agents });
      await expect(pending).resolves.toEqual(agents);
    });

    it('fetchSessions wires agent_id/force onto the wire and surfaces stale_agents', async () => {
      const service = makeService();
      const socket = await connectAndAuth(service);

      const first = sessionsApi.fetchSessions();
      const request1 = frameAt(socket, 1);
      expect(request1.msg_type).toBe('client.sessions.list');
      expect(request1.payload).toEqual({});
      const sessions = [makeSession('agent-a', 'main')];
      reply(socket, request1, { sessions, stale_agents: ['agent-a'] });
      await expect(first).resolves.toEqual({ sessions, stale_agents: ['agent-a'] });

      const second = sessionsApi.fetchSessions({ agentId: 'agent-b', force: true });
      const request2 = frameAt(socket, 2);
      expect(request2.payload).toEqual({ agent_id: 'agent-b', force: true });
      reply(socket, request2, { sessions: [] });
      await expect(second).resolves.toEqual({ sessions: [], stale_agents: [] });
    });

    it('a wire-level error frame rejects the pending feature request with the remote message', async () => {
      const service = makeService();
      const socket = await connectAndAuth(service);

      const pending = agentsApi.deleteAgent('agent-1');
      const request = frameAt(socket, 1);
      expect(request.msg_type).toBe('client.agent.delete');
      expect(request.payload).toEqual({ agent_id: 'agent-1' });

      socket.message(
        encodeFrame('error', request.id, { message: 'Agent online' }),
      );
      await expect(pending).rejects.toThrow('Agent online');
    });
  });

  describe('push fan-out into feature subscribers', () => {
    it('agents.changed reaches onAgentsChanged consumers; unsubscribing stops delivery', async () => {
      const service = makeService();
      const socket = await connectAndAuth(service);

      const first = vi.fn();
      const second = vi.fn();
      agentsApi.onAgentsChanged(first);
      const unsubscribe = agentsApi.onAgentsChanged(second);

      const agents = [makeAgent('agent-1')];
      socket.message(encodeFrame('agents.changed', 'push-1', { agents }));
      expect(first).toHaveBeenCalledWith(agents);
      expect(second).toHaveBeenCalledWith(agents);

      unsubscribe();
      socket.message(encodeFrame('agents.changed', 'push-2', { agents: [makeAgent('agent-2')] }));
      expect(first).toHaveBeenCalledTimes(2); // still subscribed — push-2 delivered
      expect(first).toHaveBeenLastCalledWith([makeAgent('agent-2')]);
      expect(second).toHaveBeenCalledTimes(1); // unsubscribed — push-2 never delivered
    });

    it('sessions.changed and client.sessions.list.response both fan out to onSessionsChanged', async () => {
      const service = makeService();
      const socket = await connectAndAuth(service);

      const callback = vi.fn();
      sessionsApi.onSessionsChanged(callback);

      const pushed = [makeSession('agent-a', 'main')];
      socket.message(encodeFrame('sessions.changed', 'push-1', { sessions: pushed }));
      expect(callback).toHaveBeenCalledWith(pushed);

      const echoed = [makeSession('agent-a', 'work')];
      socket.message(encodeFrame('client.sessions.list.response', 'push-2', { sessions: echoed }));
      expect(callback).toHaveBeenCalledWith(echoed);
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('plugin registry', () => {
    it('use() replaces a same-name plugin (old teardown first); unregister removes it', () => {
      const service = makeService();
      const events: string[] = [];
      const first = makePlugin('dup', events);
      const second = makePlugin('dup', events);

      service.use(first);
      expect(events).toEqual(['install:dup']);

      service.use(second); // replace — no double registration, no throw
      expect(events).toEqual(['install:dup', 'teardown:dup', 'install:dup']);

      expect(service.unregister('dup')).toBe(true);
      expect(events).toEqual(['install:dup', 'teardown:dup', 'install:dup', 'teardown:dup']);
      expect(service.unregister('dup')).toBe(false); // nothing registered anymore
      expect(events).toHaveLength(4);
    });

    it('dispose tears down each plugin exactly once and the transport rejects further use', async () => {
      const service = makeService();
      const events: string[] = [];
      service.use(makePlugin('lifecycle', events));
      const socket = await connectAndAuth(service);

      // A live conversation before the teardown.
      const pending = agentsApi.listAgents();
      const request = frameAt(socket, 1);
      reply(socket, request, { agents: [makeAgent('agent-1')] });
      await expect(pending).resolves.toEqual([makeAgent('agent-1')]);

      service.dispose();
      service.dispose(); // idempotent — no second teardown
      expect(events.filter((event) => event === 'teardown:lifecycle')).toHaveLength(1);
      expect(service.connectionState).toBe('disconnected');

      await expect(service.connect()).rejects.toThrow('WebSocketService disposed');
      await expect(service.request('anything', {})).rejects.toThrow('WebSocketService disposed');
      await expect(service.waitForConnection()).rejects.toThrow('WebSocketService disposed');
      expect(() => service.send('anything', {})).toThrow('WebSocketService disposed');
      // Plugin teardown unbound the feature singletons from this service.
      await expect(agentsApi.listAgents()).rejects.toThrow('agents feature is not connected');
    });
  });

  describe('re-login remount', () => {
    it('a stale service teardown leaves the newer service and its consumers serving', async () => {
      // First login — service A owns the singletons and one consumer.
      const serviceA = makeService();
      const socketA = await connectAndAuth(serviceA);
      const staleConsumer = vi.fn();
      agentsApi.onAgentsChanged(staleConsumer);

      // Re-login: service B installs over A before A is torn down (the
      // registration between install and stale-release window). B's install
      // is a replace — A's teardown, when it runs, must only drop the
      // consumers that registered under A's generation.
      const serviceB = makeService();
      const socketB = await connectAndAuth(serviceB);
      const currentConsumer = vi.fn();
      agentsApi.onAgentsChanged(currentConsumer);

      serviceA.dispose(); // stale release from the old generation

      // Pushes over B's socket reach B's consumers only.
      const agents = [makeAgent('agent-1')];
      socketB.message(encodeFrame('agents.changed', 'push-1', { agents }));
      expect(currentConsumer).toHaveBeenCalledWith(agents);
      expect(staleConsumer).not.toHaveBeenCalled();

      // Feature requests route over B's socket only.
      const socketASendsBefore = socketA.send.mock.calls.length;
      const pending = agentsApi.listAgents();
      const request = lastFrame(socketB);
      expect(request.msg_type).toBe('client.agents.list');
      expect(request.payload).toEqual({});
      expect(socketA.send.mock.calls.length).toBe(socketASendsBefore); // A's socket stays silent
      reply(socketB, request, { agents: [makeAgent('agent-2')] });
      await expect(pending).resolves.toEqual([makeAgent('agent-2')]);

      // The final dispose detaches the singletons completely.
      serviceB.dispose();
      await expect(agentsApi.listAgents()).rejects.toThrow('agents feature is not connected');
    });
  });
});
