import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayServerHandle, type RelayServerTransport } from '@/platform/attach/relayServerConnection';
import { WebSocketService } from '@/platform/socket/WebSocketService';
import { terminalServerApi } from '@/product/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/platform/socket/types';

const OriginalWebSocket = globalThis.WebSocket;

// The page subscription every relay begin now carries. Fixed so the exact
// payload assertion below stays legible; the real id is a fresh uuid.
vi.mock('@/platform/socket/subscriptionId', () => ({
  getOrCreateSubscriptionId: () => 'this-subscription',
}));

/** Parse every JSON frame a mock socket sent over the wire. */
function frames(socket: MockWebSocket): SocketMessage[] {
  return socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as SocketMessage);
}

describe('relayServerHandle', () => {
  beforeEach(() => { MockWebSocket.instances = []; });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('rejects a live superseded service even when both physical generations equal 1 (#2102)', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const previous = new WebSocketService('ws://old/ws', [terminalServerApi]);
    const oldHandle = relayServerHandle(previous, terminalServerApi);
    const firstConnected = previous.connect();
    const oldSocket = MockWebSocket.instances[0];
    oldSocket.open();
    await firstConnected;
    expect(previous.isDisposed).toBe(false);
    expect(oldHandle.isReady()).toBe(true);
    const oldOutput = vi.fn();
    const oldResize = vi.fn();
    const oldInputAck = vi.fn();
    const oldState = vi.fn();
    // Registrations made WHILE A was owner must also become inert if A stays
    // physically connected but B takes over the singleton.
    oldHandle.onRelayOutput('work', oldOutput);
    oldHandle.onRelayResize('work', oldResize);
    oldHandle.onRelayInputAck('work', oldInputAck);
    oldHandle.onConnectionStateChange(oldState);

    // StrictMode/app instance swap can install the newer service before old
    // dispose; their local physical generations are BOTH 1.
    const current = new WebSocketService('ws://new/ws', [terminalServerApi]);
    const newHandle = relayServerHandle(current, terminalServerApi);
    const secondConnected = current.connect();
    const newSocket = MockWebSocket.instances[1];
    newSocket.open();
    await secondConnected;
    expect(previous.physicalGeneration).toBe(current.physicalGeneration);
    expect(previous.isDisposed).toBe(false);
    expect(oldHandle.isReady()).toBe(false);
    expect(newHandle.isReady()).toBe(true);

    const staleReady = vi.fn();
    oldHandle.onRelayReady?.('work', staleReady);
    oldHandle.beginRelay('agent:work');
    expect(oldHandle.beginRelayTracked?.('agent:work')).toBeNull();
    oldHandle.sendRelayInput('work', 'ignored');
    oldHandle.sendRelayResize('work', 80, 24);
    oldHandle.endRelay('agent:work');
    // After #2103 the same stale handle must also be unable to send a
    // parser-applied ACK into the *new* owner's Agent tunnel.
    expect(oldHandle.sendRelayOutputApplied?.('work', {
      subscriberGeneration: 9, streamEpoch: 11,
      rendererGeneration: 1, appliedThrough: 1,
    })).toBe(false);
    expect(frames(oldSocket)).toHaveLength(0);
    expect(frames(newSocket)).toHaveLength(0);

    const liveReady = vi.fn();
    newHandle.onRelayReady?.('work', liveReady);
    newHandle.beginRelay('agent:work');
    const begin = frames(newSocket)[0];
    expect(begin?.msg_type).toBe('server.session.relay.begin');
    newSocket.message(JSON.stringify({
      msg_type: 'server.session.relay.ready', id: 'ready-new',
      timestamp: 0,
      payload: {
        session_name: 'work',
        browser_client_id: 'client-1',
        relay_request_id: begin.id,
        route_id: '123e4567-e89b-42d3-a456-426614174000',
        subscriber_generation: 9,
        stream_epoch: 11,
      },
    }));
    expect(liveReady).toHaveBeenCalledTimes(1);
    expect(staleReady).not.toHaveBeenCalled();

    newSocket.message(JSON.stringify({
      msg_type: 'agent.terminal.output', id: 'out-1', timestamp: 0,
      payload: { session_name: 'work', data: 'aGk=' },
    }));
    newSocket.message(JSON.stringify({
      msg_type: 'agent.terminal.resize', id: 'resize-1', timestamp: 0,
      payload: { session_name: 'work', cols: 80, rows: 24 },
    }));
    newSocket.message(JSON.stringify({
      msg_type: 'agent.terminal.input.ack', id: 'ack-1', timestamp: 0,
      payload: { session_name: 'work', input_epoch: 1, applied_through: 1 },
    }));
    expect(oldOutput).not.toHaveBeenCalled();
    expect(oldResize).not.toHaveBeenCalled();
    expect(oldInputAck).not.toHaveBeenCalled();
    oldSocket.serverClose();
    expect(oldState).not.toHaveBeenCalled();
    current.dispose();
    previous.dispose();
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
    const sent = frames(socket);
    expect(sent[sent.length - 1]).toMatchObject({
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
    expect(sent[0]?.payload).toEqual({
      session_id: 'a:work', cols: 120, rows: 40, subscription_id: 'this-subscription',
    });
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
