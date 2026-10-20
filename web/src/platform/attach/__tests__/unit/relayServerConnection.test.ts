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

  it('tracks the physical begin envelope and fences server proof/ACK after socket loss (#2103)', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const service = new WebSocketService('ws://server/ws', [terminalServerApi]);
    const handle = relayServerHandle(service, terminalServerApi);
    const pending = service.connect();
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    socket.open();
    await pending;

    const receipt = vi.fn();
    const unsub = handle.onRelayReady?.('work', receipt);
    const begin = handle.beginRelayTracked?.('agent:work');
    const actualWire = frames(socket).find((m) => m.msg_type === 'server.session.relay.begin');
    expect(begin).toEqual({ id: actualWire?.id, physicalGeneration: service.physicalGeneration });
    const proof = {
      session_name: 'work', browser_client_id: 'browser-a',
      relay_request_id: actualWire?.id,
      route_id: 'aabbccdd-1234-4000-8000-aabbccddeeff',
      subscriber_generation: 41, stream_epoch: 7,
    };
    socket.message(JSON.stringify({
      msg_type: 'server.session.relay.ready', id: 'server-notification', timestamp: Date.now(),
      payload: proof,
    }));
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(receipt.mock.calls[0]?.[1]).toBe(begin?.physicalGeneration);
    expect(handle.sendRelayOutputApplied?.('work', {
      subscriberGeneration: 41, streamEpoch: 7, rendererGeneration: 3, appliedThrough: 2,
    })).toBe(true);
    expect(frames(socket).at(-1)).toMatchObject({
      msg_type: 'agent.terminal.output.applied',
      payload: {
        session_name: 'work', subscriber_generation: 41, stream_epoch: 7,
        renderer_generation: 3, applied_through: 2,
      },
    });

    socket.serverClose();
    expect(handle.sendRelayOutputApplied?.('work', {
      subscriberGeneration: 41, streamEpoch: 7, rendererGeneration: 3, appliedThrough: 3,
    })).toBe(false);
    // Old socket may not supply further proof after loss, irrespective of id.
    socket.message(JSON.stringify({
      msg_type: 'server.session.relay.ready', id: 'late', timestamp: Date.now(), payload: proof,
    }));
    expect(receipt).toHaveBeenCalledTimes(1);
    unsub?.();
    service.dispose();
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
