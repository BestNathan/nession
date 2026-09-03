import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import { buildAgentWsUrl, reconnectDelayMs } from '@/services/socket/agentSocketUtils';

const OriginalWebSocket = globalThis.WebSocket;
const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

interface MockWs {
  _readyState: number;
  binaryType: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let instances: MockWs[] = [];
let autoOpenCount = 0;

function setupMockWebSocket(autoOpenInstances = 1): void {
  instances = [];
  autoOpenCount = autoOpenInstances;

  function MockCtor(this: MockWs) {
    this._readyState = WS.CONNECTING;
    this.binaryType = 'arraybuffer';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this._readyState = WS.CLOSED;
      this.onclose?.(new CloseEvent('close'));
    });
    Object.defineProperty(this, 'readyState', {
      get: () => this._readyState,
      set: (v: number) => { this._readyState = v; },
      configurable: true,
    });
    instances.push(this);

    if (autoOpenCount > 0) {
      autoOpenCount -= 1;
      setTimeout(() => {
        this._readyState = WS.OPEN;
        this.onopen?.(new Event('open'));
      }, 0);
    }
  }
  (MockCtor as unknown as { CONNECTING: number }).CONNECTING = WS.CONNECTING;
  (MockCtor as unknown as { OPEN: number }).OPEN = WS.OPEN;
  (MockCtor as unknown as { CLOSING: number }).CLOSING = WS.CLOSING;
  (MockCtor as unknown as { CLOSED: number }).CLOSED = WS.CLOSED;
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

function lastWs(): MockWs {
  return instances[instances.length - 1];
}

async function flushTimers(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('buildAgentWsUrl', () => {
  it('appends token query param', () => {
    expect(buildAgentWsUrl('ws://agent/ws', 'tok')).toBe('ws://agent/ws?token=tok');
  });
});

describe('reconnectDelayMs', () => {
  it('caps exponential backoff at 30s', () => {
    expect(reconnectDelayMs(10, 1_000)).toBe(30_000);
  });
});

describe('AgentSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('starts disconnected until connect()', () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    expect(client.connectionState).toBe('disconnected');
  });

  it('transitions to connected after connect()', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    client.connect();
    expect(client.connectionState).toBe('connecting');
    await flushTimers();
    expect(client.connectionState).toBe('connected');
  });

  it('waitForConnection resolves once connected', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    client.connect();
    const waitPromise = client.waitForConnection(5_000);
    await flushTimers();
    await waitPromise;
  });

  it('waitForConnection rejects when permanently disconnected', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      maxReconnectAttempts: 0,
      reconnectBaseDelay: 50,
    });
    client.connect();
    await flushTimers();
    lastWs().onclose!(new CloseEvent('close'));
    await expect(client.waitForConnection()).rejects.toThrow('Connection lost');
  });

  it('reconnects after unexpected close', async () => {
    setupMockWebSocket(2);
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 100,
    });
    client.connect();
    await flushTimers();
    expect(client.connectionState).toBe('connected');

    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('reconnecting');
    expect(client.reconnectAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    await flushTimers();
    expect(client.connectionState).toBe('connected');
    expect(client.reconnectAttempts).toBe(0);
  });

  it('gives up after max reconnect attempts', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      maxReconnectAttempts: 1,
      reconnectBaseDelay: 50,
    });
    client.connect();
    await flushTimers();

    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('disconnected');
  });

  it('close prevents reconnection', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 100,
    });
    client.connect();
    await flushTimers();
    const countBefore = instances.length;
    client.close();
    expect(client.connectionState).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(instances.length).toBe(countBefore);
  });

  it('send delivers JSON when connected', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    client.connect();
    await flushTimers();
    client.send({ msg_type: 'test', id: '1', timestamp: 0, payload: {} });
    expect(lastWs().send).toHaveBeenCalledTimes(1);
  });

  it('ignores stale generation events after configure()', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      connectionToken: 'token-a',
    });
    client.connect();
    const stale = lastWs();

    client.configure({ connectionToken: 'token-b' });
    expect(client.connectionState).toBe('connecting');
    expect(lastWs()).not.toBe(stale);

    // Delayed open on the superseded socket must not promote to connected.
    stale._readyState = WS.OPEN;
    stale.onopen?.(new Event('open'));
    expect(client.connectionState).toBe('connecting');

    // New socket opens normally.
    lastWs()._readyState = WS.OPEN;
    lastWs().onopen?.(new Event('open'));
    expect(client.connectionState).toBe('connected');
  });

  it('routes binary via onBinary', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    const handler = vi.fn();
    client.onBinary(handler);
    client.connect();
    await flushTimers();

    const buf = new ArrayBuffer(4);
    lastWs().onmessage!(new MessageEvent('message', { data: buf }));
    expect(handler).toHaveBeenCalledWith(buf);
  });

  it('correlates request/response through the router', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({ agentUrl: 'ws://agent/ws' });
    client.connect();
    await flushTimers();

    const p = client.request<{ ok: boolean }>('file.list', { path: '/' });
    const sent = JSON.parse(lastWs().send.mock.calls[0][0] as string) as { id: string };
    lastWs().onmessage!(new MessageEvent('message', {
      data: JSON.stringify({
        msg_type: 'file.list',
        id: sent.id,
        timestamp: 0,
        payload: { ok: true },
      }),
    }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects pending request when socket closes before response', async () => {
    setupMockWebSocket();
    const client = new AgentSocketClient({
      agentUrl: 'ws://agent/ws',
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 100,
    });
    client.connect();
    await flushTimers();

    const p = client.request('file.read', { path: '/x' });
    lastWs().onclose!(new CloseEvent('close'));
    await expect(p).rejects.toThrow('Connection lost');
  });

  it('resets reconnect budget when endpoint identity changes', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({
      agentUrl: 'ws://a/ws',
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 50,
    });
    client.connect();
    await flushTimers();

    // Exhaust A's reconnect budget (attempt 0 → reconnecting, attempt 1 → reconnecting, attempt 2 → disconnected)
    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('disconnected');

    client.configure({ agentUrl: 'ws://b/ws' });
    expect(client.connectionState).toBe('connecting');
    expect(client.reconnectAttempts).toBe(0);

    lastWs().onclose!(new CloseEvent('close'));
    expect(client.connectionState).toBe('reconnecting');
    expect(client.reconnectAttempts).toBe(1);
  });

  it('rejects request from prior endpoint when configure switches URL', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({ agentUrl: 'ws://a/ws' });
    client.connect();
    await flushTimers();

    const p = client.request('file.read', { path: '/x' });
    client.configure({ agentUrl: 'ws://b/ws' });
    await expect(p).rejects.toThrow('Connection lost');
  });

  it('configure returns false when endpoint unchanged', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({ agentUrl: 'ws://a/ws', connectionToken: 'tok' });
    client.connect();
    await flushTimers();
    expect(client.configure({ agentUrl: 'ws://a/ws', connectionToken: 'tok' })).toBe(false);
  });

  it('forceReconnect after unchanged configure opens exactly one new socket', async () => {
    setupMockWebSocket(0);
    const client = new AgentSocketClient({ agentUrl: 'ws://a/ws', connectionToken: 'tok' });
    client.connect();
    await flushTimers();
    const countBefore = instances.length;
    expect(client.configure({ agentUrl: 'ws://a/ws', connectionToken: 'tok' })).toBe(false);
    client.forceReconnect();
    await flushTimers();
    expect(instances.length - countBefore).toBe(1);
  });
});
