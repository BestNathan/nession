import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketCore } from '@/services/socket/SocketCore';
import { MockWebSocket } from '@/test/mockWebSocket';

describe('SocketCore', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('provides one request/message transport core for an endpoint', async () => {
    const core = new SocketCore({ url: 'ws://agent/ws?token=t', maxReconnectAttempts: 0 });
    const connected = core.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;

    const request = core.request<{ ok: boolean }>('client.attach', { session_name: 'demo' });
    const outbound = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1]?.[0] as string) as { id: string };
    socket.message(JSON.stringify({
      msg_type: 'ok',
      id: outbound.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));

    await expect(request).resolves.toEqual({ ok: true });
    expect(core.connectionState).toBe('connected');
  });

  it('does not resolve concurrent connect calls before the handshake completes', async () => {
    let finishHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => {
      finishHandshake = resolve;
    });
    const core = new SocketCore({ url: 'ws://server/ws', handshake: () => handshake });
    const first = core.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    let secondResolved = false;
    const second = core.connect().then(() => { secondResolved = true; });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    finishHandshake();
    await Promise.all([first, second]);
    expect(secondResolved).toBe(true);
  });
});
