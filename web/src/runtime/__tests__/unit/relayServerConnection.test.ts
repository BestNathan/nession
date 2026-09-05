import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayServerHandle, type RelayServerTransport } from '@/runtime/relayServerConnection';
import { WebSocketService } from '@/services/socket/WebSocketService';
import { terminalServerApi } from '@/features/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/services/socket/types';

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

  it('delegates relay lifecycle and I/O while active; a disposed service turns the handle inert', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    // Bind the app-level terminal-server singleton to the service under test,
    // mirroring production (install at construction).
    const service = new WebSocketService('ws://server/ws', [terminalServerApi]);
    const handle: RelayServerTransport = relayServerHandle(service);

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;
    expect(handle.isReady()).toBe(true);

    handle.beginRelay('a:work', undefined, 120, 40);
    handle.sendRelayInput('work', 'hello');
    handle.sendRelayResize('work', 100, 30);
    handle.endRelay('a:work');

    const sent = frames(socket);
    expect(sent.map((m) => m.msg_type)).toEqual([
      'client.session.relay.begin',
      'terminal.input',
      'terminal.resize',
      'client.session.relay.end',
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
      handle.beginRelay('a:work', undefined, 120, 40);
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
