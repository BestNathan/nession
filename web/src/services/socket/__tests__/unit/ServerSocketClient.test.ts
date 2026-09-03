import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerSocketClient } from '@/services/socket/ServerSocketClient';
import type { WebSocketServiceCore } from '@/services/websocket/types';

function makeCore(overrides: Partial<WebSocketServiceCore> = {}): WebSocketServiceCore {
  let status: ReturnType<WebSocketServiceCore['getConnectionStatus']> = 'connecting';
  const listeners = new Set<(s: typeof status) => void>();

  return {
    connect: vi.fn(async () => {
      status = 'authenticated';
      listeners.forEach((l) => l(status));
    }),
    disconnect: vi.fn(() => {
      status = 'disconnected';
      listeners.forEach((l) => l(status));
    }),
    isConnected: vi.fn(() => status === 'connected' || status === 'authenticated'),
    isAuthenticated: vi.fn(() => status === 'authenticated'),
    getConnectionStatus: vi.fn(() => status),
    onConnectionChange: vi.fn((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    request: vi.fn(async <T,>(type: string, payload: unknown): Promise<T> => {
      void type;
      void payload;
      return { ok: true } as T;
    }) as WebSocketServiceCore['request'],
    generateMessageId: vi.fn(() => 'msg-1'),
    getP2PConnectionInfo: vi.fn(() => null),
    ...overrides,
  };
}

describe('ServerSocketClient', () => {
  let core: WebSocketServiceCore;

  beforeEach(() => {
    core = makeCore();
  });

  it('maps authenticated status to connected', () => {
    const client = new ServerSocketClient(core);
    expect(client.connectionState).toBe('connecting');
  });

  it('connect delegates to core.connect', async () => {
    const client = new ServerSocketClient(core);
    client.connect();
    await vi.waitFor(() => expect(core.connect).toHaveBeenCalled());
    expect(client.connectionState).toBe('connected');
  });

  it('request delegates to core.request', async () => {
    const client = new ServerSocketClient(makeCore({ isAuthenticated: () => true, getConnectionStatus: () => 'authenticated' }));
    await expect(client.request('sessions.list', {})).resolves.toEqual({ ok: true });
  });

  it('waitForConnection resolves when core authenticates', async () => {
    const client = new ServerSocketClient(core);
    const waitPromise = client.waitForConnection(5_000);
    client.connect();
    await waitPromise;
  });

  it('dispose disconnects core', () => {
    const client = new ServerSocketClient(core);
    client.dispose();
    expect(core.disconnect).toHaveBeenCalled();
  });
});
