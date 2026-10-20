import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayServerHandle, type RelayServerTransport } from '@/platform/attach/relayServerConnection';
import { WebSocketService } from '@/platform/socket/WebSocketService';
import { terminalServerApi } from '@/product/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/platform/socket/types';

const OriginalWebSocket = globalThis.WebSocket;

/** Parse every JSON frame a mock socket sent over the wire. */
function frames(socket: MockWebSocket): SocketMessage[] {
  return socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as SocketMessage);
}

describe('relayServerHandle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('does not send or subscribe through a live but superseded service', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('localStorage', { getItem: () => 'browser-42', setItem: () => {} });
    MockWebSocket.instances = [];
    const previous = new WebSocketService('ws://old/ws', [terminalServerApi]);
    const oldHandle = relayServerHandle(previous, terminalServerApi);
    const c1 = previous.connect();
    MockWebSocket.instances[0].open();
    await c1;
    expect(oldHandle.isReady()).toBe(true);

    const current = new WebSocketService('ws://new/ws', [terminalServerApi]);
    const liveHandle = relayServerHandle(current, terminalServerApi);
    const c2 = current.connect();
    MockWebSocket.instances[1].open();
    await c2;
    expect(previous.isDisposed).toBe(false);
    expect(oldHandle.isReady()).toBe(false);

    const staleReady = vi.fn();
    oldHandle.onRelaySubscriptionReady?.('work', staleReady);
    oldHandle.beginRelay('agent:work');
    expect(frames(MockWebSocket.instances[0])).toHaveLength(0);

    const ready = vi.fn();
    liveHandle.onRelaySubscriptionReady?.('work', ready);
    liveHandle.beginRelay('agent:work');
    const requestId = frames(MockWebSocket.instances[1])[0]?.id;
    MockWebSocket.instances[1].message(JSON.stringify({
      msg_type: 'server.session.relay.ready',
      id: 'ready-1',
      timestamp: 0,
      payload: {
        session_name: 'work',
        relay_request_id: requestId,
        route_id: '123e4567-e89b-42d3-a456-426614174000',
        browser_client_id: 'browser-42',
        subscriber_generation: 21,
        stream_epoch: 31,
      },
    }));
    expect(staleReady).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    previous.dispose();
    current.dispose();
  });

  it('delegates relay lifecycle and I/O while active; a disposed service turns the handle inert', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    // Bind the app-level terminal-server singleton to the service under test,
    // mirroring production (install at construction).
    const service = new WebSocketService('ws://server/ws', [terminalServerApi]);
    const handle: RelayServerTransport = relayServerHandle(service, terminalServerApi);

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;
    expect(handle.isReady()).toBe(true);

    handle.beginRelay('a:work', { cols: 120, rows: 40 });
    handle.sendRelayInput('work', 'hello');
    handle.sendRelayResize('work', 100, 30);
    handle.endRelay('a:work');

    const sent = frames(socket);
    expect(sent.map((m) => m.msg_type)).toEqual([
      'server.session.relay.begin',
      'agent.terminal.input',
      'agent.terminal.resize',
      'server.session.relay.end',
    ]);
    expect(sent[0]?.payload).toEqual({ session_id: 'a:work', cols: 120, rows: 40 });
    expect(sent[1]?.payload).toMatchObject({ session_name: 'work' });

    const unsubOutput = handle.onRelayOutput('work', () => {});
    const unsubResize = handle.onRelayResize('work', () => {});

    service.dispose();
    expect(service.isDisposed).toBe(true);
    expect(handle.isReady()).toBe(false);

    // Stale handle: every outbound member no-ops (no throw, no wire frames —
    // the singleton would otherwise route these to a newer service binding),
    // and subscriptions return inert unsubscribes.
    expect(() => {
      handle.beginRelay('a:work', { cols: 120, rows: 40 });
      handle.sendRelayInput('work', 'hi');
      handle.sendRelayResize('work', 80, 24);
      handle.endRelay('a:work');
    }).not.toThrow();
    handle.onRelayOutput('work', () => {})();
    handle.onRelayResize('work', () => {})();

    expect(frames(socket)).toHaveLength(4);
    unsubOutput();
    unsubResize();
  });
});
