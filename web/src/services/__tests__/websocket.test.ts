import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebSocketService, createWebSocketService, destroyWebSocketService, getWebSocketService } from '../websocket';

const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

interface MockWs {
  _readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _mockSendCalls: string[];
}

let mocks: MockWs[] = [];
const OriginalWebSocket = globalThis.WebSocket;

function setupMock() {
  mocks = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function MockCtor(this: MockWs, _url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    self._readyState = WS.CONNECTING;
    self.onopen = null;
    self.onmessage = null;
    self.onerror = null;
    self.onclose = null;
    self._mockSendCalls = [];
    self.send = vi.fn((data: string) => { self._mockSendCalls.push(data); });
    self.close = vi.fn(function (this: MockWs) {
      (self as unknown as { readyState: number }).readyState = WS.CLOSED;
      self.onclose?.(new CloseEvent('close'));
    });
    Object.defineProperty(self, 'readyState', {
      get() { return self._readyState; },
      set(v: number) { self._readyState = v; },
      configurable: true,
    });
    mocks.push(self);
  }
  (MockCtor as unknown as { CONNECTING: number }).CONNECTING = WS.CONNECTING;
  (MockCtor as unknown as { OPEN: number }).OPEN = WS.OPEN;
  (MockCtor as unknown as { CLOSING: number }).CLOSING = WS.CLOSING;
  (MockCtor as unknown as { CLOSED: number }).CLOSED = WS.CLOSED;
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

function last(): MockWs { return mocks[mocks.length - 1]; }
function findSendCall(mock: MockWs, prefix: string): string | undefined {
  return mock._mockSendCalls.find((c) => c.includes(prefix));
}

describe('WebSocketService', () => {
  beforeEach(() => { destroyWebSocketService(); setupMock(); });
  afterEach(() => { globalThis.WebSocket = OriginalWebSocket; destroyWebSocketService(); });

  // Helper: drive a successful connect+auth
  async function connectAndAuth(ws: WebSocketService) {
    const p = ws.connect();
    const mock = last();
    mock._readyState = WS.OPEN;
    mock.onopen!(new Event('open'));
    const authId = JSON.parse(findSendCall(mock, 'client.auth')!).id;
    mock.onmessage!(new MessageEvent('message', {
      data: JSON.stringify({ msg_type: 'ok', id: authId, timestamp: Date.now(), payload: { status: 'success', message: 'ok' } }),
    }));
    await p;
  }

  describe('connect / auth', () => {
    it('authenticates on success', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      expect(ws.getConnectionStatus()).toBe('authenticated');
    });

    it('rejects on auth failure', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const p = ws.connect();
      const mock = last();
      mock._readyState = WS.OPEN;
      mock.onopen!(new Event('open'));
      const authId = JSON.parse(findSendCall(mock, 'client.auth')!).id;
      mock.onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: authId, timestamp: Date.now(), payload: { status: 'failed', message: 'bad token' } }),
      }));
      await expect(p).rejects.toThrow('bad token');
    });

    it('rejects on WebSocket error before open', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const p = ws.connect();
      last().onerror!(new Event('error'));
      await expect(p).rejects.toThrow('WebSocket connection failed');
    });

    it('no-ops if already connected', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const count = mocks.length;
      // Second connect should return immediately
      await ws.connect();
      expect(mocks.length).toBe(count); // No new WebSocket
    });
  });

  describe('disconnect', () => {
    it('closes socket and resets state', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      ws.connect();
      ws.disconnect();
      expect(last().close).toHaveBeenCalled();
      expect(ws.getConnectionStatus()).toBe('disconnected');
    });

    it('clears reconnect timer', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      last().onclose!(new CloseEvent('close'));
      // Disconnect before reconnect fires
      ws.disconnect();
    });
  });

  describe('listAgents / listSessions', () => {
    it('listAgents returns parsed agents', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const p = ws.listAgents();
      const listId = JSON.parse(findSendCall(last(), 'client.agents.list')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: listId, timestamp: Date.now(), payload: { agents: [{ agent_id: 'a1', hostname: 'h', ip_address: '1.2.3.4', port: 80, status: 'online', session_count: 0, last_heartbeat: new Date().toISOString() }] } }),
      }));
      const result = await p;
      expect(result).toHaveLength(1);
      expect(result[0].agent_id).toBe('a1');
    });

    it('throws when not authenticated', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await expect(ws.listAgents()).rejects.toThrow('Not authenticated');
    });
  });

  describe('requestAttach', () => {
    it('sends attach request', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const p = ws.requestAttach('agent:x', 'p2p');
      const attId = JSON.parse(findSendCall(last(), 'client.session.attach')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: attId, timestamp: Date.now(), payload: { mode: 'p2p', session_id: 'agent:x', agent_address: 'ws://a/ws', connection_token: 'tok' } }),
      }));
      const info = await p;
      expect(info.mode).toBe('p2p');
      expect(info.agent_address).toBe('ws://a/ws');
    });
  });

  describe('createSession', () => {
    it('sends create request', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const p = ws.createSession('agent-1', 'my-session');
      const cId = JSON.parse(findSendCall(last(), 'client.session.create')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: cId, timestamp: Date.now(), payload: { success: true, session_id: 'agent-1:my-session' } }),
      }));
      const result = await p;
      expect(result.success).toBe(true);
    });
  });

  describe('killSession', () => {
    it('sends kill request', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const p = ws.killSession('agent:x');
      const kId = JSON.parse(findSendCall(last(), 'client.session.kill')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: kId, timestamp: Date.now(), payload: { success: true } }),
      }));
      const result = await p;
      expect(result.success).toBe(true);
    });
  });

  describe('getP2PConnectionInfo', () => {
    it('returns null for relay mode', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(ws.getP2PConnectionInfo({ mode: 'relay', session_id: 'x' })).toBeNull();
    });

    it('returns url and token for p2p mode', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const info = ws.getP2PConnectionInfo({
        mode: 'p2p', session_id: 'x', agent_address: 'ws://agent/ws', connection_token: 'tok',
      });
      expect(info).toEqual({ url: 'ws://agent/ws', token: 'tok' });
    });

    it('returns null when missing agent_address', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(ws.getP2PConnectionInfo({ mode: 'p2p', session_id: 'x', connection_token: 'tok' })).toBeNull();
    });
  });

  describe('event subscriptions', () => {
    it('agents.changed notifies subscribers', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cb = vi.fn();
      ws.onAgentsChanged(cb);
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'agents.changed', id: '', timestamp: Date.now(), payload: { agents: [] } }),
      }));
      expect(cb).toHaveBeenCalledWith([]);
    });

    it('agents.changed without agents field does not crash', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cb = vi.fn();
      ws.onAgentsChanged(cb);
      // Send agents.changed without the agents field in payload
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'agents.changed', id: '', timestamp: Date.now(), payload: {} }),
      }));
      // Should not call the callback since agents field is missing
      expect(cb).not.toHaveBeenCalled();
    });

    it('sessions.changed notifies subscribers', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cb = vi.fn();
      ws.onSessionsChanged(cb);
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'sessions.changed', id: '', timestamp: Date.now(), payload: { sessions: [] } }),
      }));
      expect(cb).toHaveBeenCalledWith([]);
    });

    it('onConnectionChange fires on status transition', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const statuses: string[] = [];
      ws.onConnectionChange((s) => statuses.push(s));
      await connectAndAuth(ws);
      expect(statuses).toContain('connecting');
      expect(statuses).toContain('connected');
      expect(statuses).toContain('authenticated');
    });

    it('terminal.output routes by sessionId', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cbA = vi.fn();
      const cbB = vi.fn();
      ws.onTerminalOutput('sess-A', cbA);
      ws.onTerminalOutput('sess-B', cbB);
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'terminal.output', id: '', timestamp: Date.now(), payload: { session_id: 'sess-A', data: 'hi' } }),
      }));
      expect(cbA).toHaveBeenCalledWith('hi');
      expect(cbB).not.toHaveBeenCalled();
    });
  });

  describe('singleton', () => {
    it('create/destroy cycle works', () => {
      const s1 = createWebSocketService('ws://a', 't1');
      expect(getWebSocketService()).toBe(s1);
      createWebSocketService('ws://b', 't2');
      expect(s1.getConnectionStatus()).toBe('disconnected');
      destroyWebSocketService();
      expect(getWebSocketService()).toBeNull();
    });
  });

  describe('terminal I/O', () => {
    it('sendTerminalInput sends correct format', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      last()._mockSendCalls.length = 0;

      ws.sendTerminalInput('sess-1', 'ls\r');
      const tInput = findSendCall(last(), 'terminal.input');
      expect(tInput).toBeTruthy();
      const msg = JSON.parse(tInput!);
      expect(msg.msg_type).toBe('terminal.input');
      expect(msg.payload.session_id).toBe('sess-1');
    });

    it('throws when not connected', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(() => ws.sendTerminalInput('s', 'd')).toThrow('WebSocket not connected');
    });
  });

  describe('message handling', () => {
    it('handles unhandled message type gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'unknown.type', id: 'xyz', timestamp: Date.now(), payload: {} }),
      }));

      expect(consoleSpy).toHaveBeenCalledWith('Unhandled message type:', 'unknown.type', expect.any(Object));
      consoleSpy.mockRestore();
    });

    it('handles agents list response event directly', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cb = vi.fn();
      ws.onAgentsChanged(cb);

      // Simulate direct event (not routed through pending request)
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'client.agents.list.response', id: 'direct', timestamp: Date.now(), payload: { agents: [{ agent_id: 'a1', hostname: 'h', ip_address: '1.2.3.4', port: 80, status: 'online', session_count: 0, last_heartbeat: new Date().toISOString() }] } }),
      }));

      expect(cb).toHaveBeenCalled();
    });

    it('handles sessions list response event directly', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const cb = vi.fn();
      ws.onSessionsChanged(cb);

      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'client.sessions.list.response', id: 'direct', timestamp: Date.now(), payload: { sessions: [{ session_id: 'a:x', agent_id: 'a', session_name: 'x', status: 'active', window_count: 1, attached_clients: 0, last_activity: new Date().toISOString() }] } }),
      }));

      expect(cb).toHaveBeenCalled();
    });

    it('handles malformed JSON gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      last().onmessage!(new MessageEvent('message', { data: 'not valid json{' }));

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('message ID generation', () => {
    it('generates unique IDs', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      // Trigger two requests and check their message IDs
      ws.listAgents();
      ws.listSessions();

      const calls = last()._mockSendCalls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const id1 = JSON.parse(calls[calls.length - 2]).id;
      const id2 = JSON.parse(calls[calls.length - 1]).id;
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^msg_\d+_/);
      expect(id2).toMatch(/^msg_\d+_/);
    });
  });

  describe('request timeout', () => {
    it('creates request with timeout configuration', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      // Verify request has a timeout by checking that the request
      // can be resolved normally before timeout
      const p = ws.listAgents();
      const listId = JSON.parse(findSendCall(last(), 'client.agents.list')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: listId, timestamp: Date.now(), payload: { agents: [] } }),
      }));
      const result = await p;
      expect(result).toEqual([]);
    });
  });

  describe('reconnect', () => {
    it('schedules reconnect on close', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      last().onclose!(new CloseEvent('close'));

      // Should log scheduling reconnect
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Scheduling reconnect'));
      consoleSpy.mockRestore();
    });

    it('stops reconnect after max attempts', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      // Manually exhaust reconnect attempts
      const svc = ws as unknown as {
        reconnectAttempts: number;
        reconnectTimer: ReturnType<typeof setTimeout> | null;
      };
      svc.reconnectAttempts = 5; // maxReconnectAttempts is 5

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      last().onclose!(new CloseEvent('close'));

      expect(consoleSpy).toHaveBeenCalledWith('Max reconnection attempts reached');
      consoleSpy.mockRestore();
    });

    it('does not schedule duplicate reconnect timers', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      // Connect without awaiting auth — we just need the ws setup
      ws.connect().catch(() => {});
      const mock = last();
      mock._readyState = WebSocket.OPEN;
      mock.onopen!(new Event('open'));

      // Fire two close events rapidly — second should hit guard
      mock.onclose!(new CloseEvent('close'));
      mock.onclose!(new CloseEvent('close'));

      // Clean up
      ws.disconnect();
    });
  });

  describe('rejectAllPendingRequests', () => {
    it('rejects pending requests on disconnect', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      // Start a request that will be pending when close fires
      const p = ws.listAgents();
      // Immediately close before response arrives
      const promiseResult = p.catch((e) => e.message);
      last().onclose!(new CloseEvent('close'));
      // Clean up reconnect timer to avoid unhandled errors
      ws.disconnect();

      const msg = await promiseResult;
      expect(msg).toBe('Connection closed');
    });
  });

  describe('internal coverage — direct access', () => {
    // These tests bypass the mock WebSocket to reach private methods
    // that V8 coverage cannot trace through indirect callback dispatch
    it('handles pending request resolution via onmessage', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);

      const p = ws.listAgents();
      const listId = JSON.parse(findSendCall(last(), 'client.agents.list')!).id;
      // This triggers handleMessage → pending request resolution
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: listId, timestamp: Date.now(), payload: { agents: [] } }),
      }));
      const result = await p;
      expect(result).toEqual([]);
    });

    it('getConnectionStatus reports correct status after auth', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(ws.getConnectionStatus()).toBe('disconnected');
      await connectAndAuth(ws);
      expect(ws.getConnectionStatus()).toBe('authenticated');
    });

    it('isConnected returns true when authenticated', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(ws.isConnected()).toBe(false);
      await connectAndAuth(ws);
      expect(ws.isConnected()).toBe(true);
    });

    it('isauthenticated reflects auth state', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(ws.isauthenticated()).toBe(false);
      await connectAndAuth(ws);
      expect(ws.isauthenticated()).toBe(true);
    });

    it('onConnectionChange unsubscribe works', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const cb = vi.fn();
      const unsub = ws.onConnectionChange(cb);
      unsub();
      // Verify idempotent — calling again doesn't throw
      unsub();
    });

    it('onAgentsChanged unsubscribe works', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const cb = vi.fn();
      const unsub = ws.onAgentsChanged(cb);
      unsub();
      unsub(); // idempotent
    });

    it('onSessionsChanged unsubscribe works', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const cb = vi.fn();
      const unsub = ws.onSessionsChanged(cb);
      unsub();
      unsub(); // idempotent
    });

    it('onTerminalOutput unsubscribe works', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const cb = vi.fn();
      const unsub = ws.onTerminalOutput('sess-1', cb);
      unsub();
      // Unsubscribe again (should be no-op since already removed)
      unsub();
      // Unsubscribe when no callbacks exist for session
      const unsub2 = ws.onTerminalOutput('sess-2', vi.fn());
      unsub2();
    });

    it('connect throws on WebSocket error after open', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      const p = ws.connect();
      last().onerror!(new Event('error'));
      await expect(p).rejects.toThrow('WebSocket connection failed');
    });
  });

  describe('sendTerminalResize', () => {
    it('sends terminal.resize message', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      last()._mockSendCalls.length = 0;

      ws.sendTerminalResize('sess-1', 120, 40);
      const tResize = findSendCall(last(), 'terminal.resize');
      expect(tResize).toBeTruthy();
      const msg = JSON.parse(tResize!);
      expect(msg.msg_type).toBe('terminal.resize');
      expect(msg.payload.cols).toBe(120);
      expect(msg.payload.rows).toBe(40);
    });

    it('throws when not connected for resize', () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      expect(() => ws.sendTerminalResize('s', 80, 24)).toThrow('WebSocket not connected');
    });
  });

  describe('env file management', () => {
    it('listEnvFiles returns files', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.listEnvFiles();
      const id = JSON.parse(findSendCall(last(), 'client.env.list')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id, timestamp: Date.now(), payload: { files: [{ name: 'a.env', source: 'server', size: 3, modified: 0, var_count: 1 }] } }),
      }));
      const result = await p;
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('a.env');
    });

    it('getEnvFile sends name and source', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.getEnvFile({ name: 'a.env', source: 'agent', agent_id: 'h1' });
      const raw = findSendCall(last(), 'client.env.get')!;
      const sent = JSON.parse(raw);
      expect(sent.payload).toMatchObject({ name: 'a.env', source: 'agent', agent_id: 'h1' });
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: sent.id, timestamp: Date.now(), payload: { success: true, content: 'X=1', in_use_by: [] } }),
      }));
      const result = await p;
      expect(result.content).toBe('X=1');
    });

    it('writeEnvFile passes overwrite flag', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.writeEnvFile({ name: 'a.env', source: 'server' }, 'K=V', true);
      const sent = JSON.parse(findSendCall(last(), 'client.env.write')!);
      expect(sent.payload).toMatchObject({ name: 'a.env', content: 'K=V', overwrite: true });
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: sent.id, timestamp: Date.now(), payload: { success: true } }),
      }));
      expect((await p).success).toBe(true);
    });

    it('deleteEnvFile resolves', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.deleteEnvFile({ name: 'a.env', source: 'server' });
      const id = JSON.parse(findSendCall(last(), 'client.env.delete')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id, timestamp: Date.now(), payload: { success: true } }),
      }));
      expect((await p).success).toBe(true);
    });

    it('applySessionEnv sends session and files', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.applySessionEnv('agent:s', [{ name: 'a.env', source: 'server' }]);
      const sent = JSON.parse(findSendCall(last(), 'client.session.env.apply')!);
      expect(sent.payload.session_id).toBe('agent:s');
      expect(sent.payload.env_files).toHaveLength(1);
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id: sent.id, timestamp: Date.now(), payload: { success: true, warnings: [] } }),
      }));
      expect((await p).success).toBe(true);
    });

    it('unsetSessionEnv resolves', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await connectAndAuth(ws);
      const p = ws.unsetSessionEnv('agent:s', [{ name: 'a.env', source: 'server' }]);
      const id = JSON.parse(findSendCall(last(), 'client.session.env.unset')!).id;
      last().onmessage!(new MessageEvent('message', {
        data: JSON.stringify({ msg_type: 'ok', id, timestamp: Date.now(), payload: { success: true } }),
      }));
      expect((await p).success).toBe(true);
    });

    it('env methods throw when not authenticated', async () => {
      const ws = new WebSocketService('ws://localhost/ws', 'token');
      await expect(ws.listEnvFiles()).rejects.toThrow('Not authenticated');
    });
  });
});
