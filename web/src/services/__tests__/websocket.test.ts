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
});
