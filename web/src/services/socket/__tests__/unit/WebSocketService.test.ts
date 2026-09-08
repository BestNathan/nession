import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketService } from '@/services/socket/WebSocketService';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { CapabilityPlugin, HandshakeSurface, SocketMessage } from '@/services/socket/types';

const OriginalWebSocket = globalThis.WebSocket;

/** Advance the (faked) clock and let timer callbacks run. */
async function flushTimers(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

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

/** A handshake whose completion the test controls. */
function controlledHandshake(): {
  handshake: (surface: HandshakeSurface) => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolveHandshake!: () => void;
  let rejectHandshake!: (error: Error) => void;
  const handshake = () => new Promise<void>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  return {
    handshake,
    resolve: () => resolveHandshake(),
    reject: (error) => rejectHandshake(error),
  };
}

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

describe('WebSocketService', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('connects without a handshake: open promotes connecting → connected and resolves connect()/waiters', async () => {
    const service = new WebSocketService('ws://server/ws');
    expect(service.connectionState).toBe('disconnected');
    expect(service.getUrl()).toBe('ws://server/ws');

    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));

    const first = service.connect();
    expect(service.connectionState).toBe('connecting');
    const second = service.connect();
    expect(second).toBe(first); // concurrent connect reuses the in-flight attempt
    expect(MockWebSocket.instances).toHaveLength(1);

    const waiting = service.waitForConnection(5_000);
    let waitResolved = false;
    void waiting.then(() => { waitResolved = true; });
    await drainMicrotasks();
    expect(waitResolved).toBe(false);

    MockWebSocket.instances[0].open();
    await first;
    await second;
    await waiting;

    expect(service.connectionState).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('stays connecting until the handshake completes; connect()/waitForConnection() stay pending', async () => {
    const gate = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: gate.handshake,
    });

    const connected = service.connect();
    MockWebSocket.instances[0].open();
    expect(service.connectionState).toBe('connecting');

    let connectedFlag = false;
    void connected.then(() => { connectedFlag = true; });
    const waiting = service.waitForConnection(5_000);
    let waitResolved = false;
    void waiting.then(() => { waitResolved = true; });
    await drainMicrotasks();
    expect(connectedFlag).toBe(false);
    expect(waitResolved).toBe(false);

    gate.resolve();
    await connected;
    await waiting;
    expect(service.connectionState).toBe('connected');
  });

  it('queues requests behind the readiness gate but allows send() once the socket is OPEN', async () => {
    const gate = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: gate.handshake,
    });

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    // Socket is physically OPEN during the handshake: envelope send() passes.
    service.send('agent.ping', { n: 1 });
    expect(frameAt(socket, 0)).toMatchObject({
      msg_type: 'agent.ping',
      payload: { n: 1 },
    });

    // A request issued while not ready must not hit the wire yet.
    const request = service.request<{ ok: boolean }>('agents.list', { all: true });
    await drainMicrotasks();
    expect(socket.send).toHaveBeenCalledTimes(1);

    gate.resolve();
    await connected;
    await drainMicrotasks();

    // Only now does the queued request go out — with the same envelope shape.
    expect(socket.send).toHaveBeenCalledTimes(2);
    const frame = frameAt(socket, 1);
    expect(frame.msg_type).toBe('agents.list');
    expect(frame.payload).toEqual({ all: true });

    socket.message(JSON.stringify({
      msg_type: 'agents.list',
      id: frame.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('rejects the connection when the handshake fails with the budget exhausted; waiters and pending requests fail', async () => {
    const captured: { rejection: Error | null } = { rejection: null };
    const handshake = vi.fn(async (surface: HandshakeSurface) => {
      // In-flight correlated request on the surface: must be failed on loss.
      surface.request('auth.verify', { token: 'bad' }).catch((error: Error) => {
        captured.rejection = error;
      });
      throw new Error('auth failed');
    });
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 0,
    });

    const connected = service.connect();
    const waiting = service.waitForConnection(5_000);
    const request = service.request('agents.list', {});
    MockWebSocket.instances[0].open();

    await expect(connected).rejects.toThrow('auth failed');
    await expect(waiting).rejects.toThrow('Connection lost');
    await expect(request).rejects.toThrow('Connection lost');
    await drainMicrotasks();
    expect(captured.rejection?.message).toBe('Connection lost');
    expect(service.connectionState).toBe('disconnected');
  });

  it('re-runs the handshake per physical socket and recovers within the reconnect budget', async () => {
    let handshakeCount = 0;
    let resolveSecondHandshake!: () => void;
    const handshake = vi.fn(() => {
      handshakeCount += 1;
      if (handshakeCount === 1) {
        return Promise.reject(new Error('auth failed'));
      }
      return new Promise<void>((resolve) => {
        resolveSecondHandshake = resolve;
      });
    });
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await expect(connected).rejects.toThrow('auth failed');

    expect(service.connectionState).toBe('reconnecting');
    expect(service.reconnectAttempts).toBe(1);
    expect(handshakeCount).toBe(1);

    const recovered = service.waitForConnection(5_000);
    await flushTimers(50);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(handshakeCount).toBe(1); // handshake waits for the new socket to open

    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();
    expect(handshakeCount).toBe(2);
    expect(service.connectionState).toBe('connecting');

    resolveSecondHandshake();
    await recovered;
    expect(service.connectionState).toBe('connected');
  });

  it('correlates handshake requests via HandshakeSurface and still dispatches pushes during the handshake', async () => {
    let verified = false;
    const handshake = vi.fn(async (surface: HandshakeSurface) => {
      surface.send('auth.begin', { version: 1 });
      const result = await surface.request<{ ok: boolean }>('auth.verify', { token: 't' });
      verified = result.ok;
    });
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 0,
    });

    const notices: unknown[] = [];
    const unsubscribe = service.subscribe('server.notice', (payload) => {
      notices.push(payload);
    });

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await drainMicrotasks(); // let the handshake body reach its await

    expect(handshake).toHaveBeenCalledTimes(1);
    // Surface frames are enveloped: begin (plain send) then verify (request).
    expect(socket.send).toHaveBeenCalledTimes(2);
    const begin = frameAt(socket, 0);
    expect(begin.msg_type).toBe('auth.begin');
    expect(begin.id).toMatch(/^msg_\d+_/);
    expect(typeof begin.timestamp).toBe('number');
    const verify = frameAt(socket, 1);
    expect(verify.msg_type).toBe('auth.verify');

    // A push arriving mid-handshake still reaches the pre-open subscriber.
    socket.message(JSON.stringify({
      msg_type: 'server.notice',
      id: 'n-1',
      timestamp: Date.now(),
      payload: { hello: true },
    }));
    expect(notices).toEqual([{ hello: true }]);

    // The response to the surface request correlates by envelope id.
    socket.message(JSON.stringify({
      msg_type: 'auth.verify',
      id: verify.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));
    await connected;
    expect(verified).toBe(true);
    expect(service.connectionState).toBe('connected');

    unsubscribe();
  });

  it('does not reinstall plugins on reconnect and subscriptions do not duplicate across sockets', async () => {
    let teardownCalls = 0;
    const plugin: CapabilityPlugin = {
      name: 'probe',
      install: vi.fn(() => () => {
        teardownCalls += 1;
      }),
    };
    const service = new WebSocketService('ws://server/ws', [plugin], {
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 5,
    });

    const handler = vi.fn();
    service.subscribe('session.list', handler);

    const connected = service.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await connected;
    expect(plugin.install).toHaveBeenCalledTimes(1);

    firstSocket.message(JSON.stringify({
      msg_type: 'session.list',
      id: 'p-1',
      timestamp: Date.now(),
      payload: { name: 'one' },
    }));
    expect(handler).toHaveBeenCalledTimes(1);

    const recovered = service.waitForConnection(5_000);
    firstSocket.serverClose();
    expect(service.connectionState).toBe('reconnecting');

    await flushTimers(50);
    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.open();
    await recovered;
    expect(plugin.install).toHaveBeenCalledTimes(1); // reconnect never re-installs
    expect(teardownCalls).toBe(0);

    // A stale frame from the superseded socket is ignored (it is also closed).
    firstSocket.message(JSON.stringify({
      msg_type: 'session.list',
      id: 'p-2',
      timestamp: Date.now(),
      payload: { name: 'stale' },
    }));
    expect(handler).toHaveBeenCalledTimes(1);

    // The same subscription delivers exactly once per frame on the new socket.
    secondSocket.message(JSON.stringify({
      msg_type: 'session.list',
      id: 'p-3',
      timestamp: Date.now(),
      payload: { name: 'two' },
    }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('ignores a late handshake completion from a superseded socket', async () => {
    const completions: Array<() => void> = [];
    const handshake = vi.fn(() => new Promise<void>((resolve) => {
      completions.push(resolve);
    }));
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    expect(handshake).toHaveBeenCalledTimes(1);

    // The connection drops while the first handshake is still in flight.
    firstSocket.serverClose();
    await expect(connected).rejects.toThrow('Connection lost');

    await flushTimers(50);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();
    expect(handshake).toHaveBeenCalledTimes(2);
    expect(service.connectionState).toBe('connecting');

    // The stale socket's handshake completing later must not promote the state.
    completions[0]();
    await drainMicrotasks();
    expect(service.connectionState).toBe('connecting');

    const recovered = service.waitForConnection(5_000);
    completions[1]();
    await recovered;
    expect(service.connectionState).toBe('connected');
  });

  it('registry: installs constructor plugins, use() replaces same-name with old teardown first, unregister removes', () => {
    const events: string[] = [];
    const service = new WebSocketService(
      'ws://server/ws',
      [makePlugin('alpha', events), makePlugin('beta', events)],
    );
    expect(events).toEqual(['install:alpha', 'install:beta']);

    // Same-name use(): the old teardown runs before the new install.
    service.use(makePlugin('alpha', events));
    expect(events).toEqual([
      'install:alpha',
      'install:beta',
      'teardown:alpha',
      'install:alpha',
    ]);
    expect(service.connectionState).toBe('disconnected');

    expect(service.unregister('beta')).toBe(true);
    expect(events).toEqual([
      'install:alpha',
      'install:beta',
      'teardown:alpha',
      'install:alpha',
      'teardown:beta',
    ]);
    expect(service.unregister('nope')).toBe(false);
  });

  it('dispose() tears down each plugin once, is idempotent, and rejects waiters; later send()/request() throw disposed', async () => {
    const events: string[] = [];
    const service = new WebSocketService(
      'ws://server/ws',
      [makePlugin('alpha', events), makePlugin('beta', events)],
      { maxReconnectAttempts: 0 },
    );
    service.use(makePlugin('gamma', events));
    expect(events).toEqual(['install:alpha', 'install:beta', 'install:gamma']);

    // Handler attached at creation: dispose() settles this in-flight connect.
    const connected = service.connect();
    const connectOutcome = connected.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const waiting = service.waitForConnection(5_000);

    service.dispose();
    service.dispose();
    await expect(waiting).rejects.toThrow('WebSocketService disposed');
    await expect(connectOutcome).resolves.toBe('WebSocketService disposed');

    expect(events).toEqual([
      'install:alpha',
      'install:beta',
      'install:gamma',
      'teardown:alpha',
      'teardown:beta',
      'teardown:gamma',
    ]);
    expect(() => service.send('x.y', {})).toThrow('WebSocketService disposed');
    await expect(service.request('x.y', {})).rejects.toThrow('WebSocketService disposed');
    await expect(service.waitForConnection()).rejects.toThrow('WebSocketService disposed');
  });

  it('isDisposed is false until dispose() runs, then stays true', async () => {
    const service = new WebSocketService('ws://server/ws');
    expect(service.isDisposed).toBe(false);

    const connected = service.connect();
    MockWebSocket.instances[0].open();
    await connected;
    expect(service.connectionState).toBe('connected');
    expect(service.isDisposed).toBe(false);

    service.disconnect();
    // disconnect() is not terminal — only dispose() flags the service.
    expect(service.isDisposed).toBe(false);

    service.dispose();
    expect(service.isDisposed).toBe(true);
    service.dispose();
    expect(service.isDisposed).toBe(true);
  });

  it('dispose() rejects an in-flight connect() whose handshake is still pending', async () => {
    const gate = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: gate.handshake,
    });

    // Handler attached at creation: the rejection must not go unhandled.
    const connected = service.connect();
    const outcome = connected.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    MockWebSocket.instances[0].open();
    expect(service.connectionState).toBe('connecting');

    service.dispose();
    await expect(service.connect()).rejects.toThrow('WebSocketService disposed');
    await expect(outcome).resolves.toBe('WebSocketService disposed');

    // The handshake completing after dispose trips the socket-identity guard:
    // no late settle, and the state stays where dispose() left it.
    gate.resolve();
    await drainMicrotasks();
    expect(service.connectionState).toBe('disconnected');
  });

  it('disconnect() rejects an in-flight connect() and is terminal for later connect() calls', async () => {
    const gate = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: gate.handshake,
    });

    const connected = service.connect();
    const outcome = connected.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    MockWebSocket.instances[0].open();
    expect(service.connectionState).toBe('connecting');

    service.disconnect();
    await expect(outcome).resolves.toBe('WebSocketService is closed');
    expect(service.connectionState).toBe('disconnected');
    await expect(service.connect()).rejects.toThrow('WebSocketService is closed');

    // A handshake failing after disconnect must not schedule a reconnect or
    // flip the state back to 'reconnecting'.
    gate.reject(new Error('late failure'));
    await drainMicrotasks();
    expect(service.connectionState).toBe('disconnected');
  });

  it('rejects connect(), waiters and queued requests when the socket errors while connecting', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    const outcome = connected.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const waiting = service.waitForConnection(5_000);
    const request = service.request('agents.list', { all: true });

    const socket = MockWebSocket.instances[0];
    socket.error(); // attempt fails: onerror fires, no close event follows

    await expect(outcome).resolves.toBe('WebSocket connection failed');
    await expect(waiting).rejects.toThrow('WebSocket connection failed');
    await expect(request).rejects.toThrow('WebSocket connection failed');
    expect(socket.send).not.toHaveBeenCalled();
    expect(service.connectionState).toBe('disconnected');
    expect(service.reconnectAttempts).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not double-process an onerror followed by onclose while connecting', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    const outcome = connected.then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    const socket = MockWebSocket.instances[0];
    socket.error();
    // In the browser a close event may follow the error. The error path
    // already tore the socket down (handlers nulled), so the close must not
    // reject twice or schedule a reconnect — a second socket after the
    // backoff would betray double processing.
    socket.serverClose();
    await flushTimers(50);

    await expect(outcome).resolves.toBe('WebSocket connection failed');
    expect(service.connectionState).toBe('disconnected');
    expect(service.reconnectAttempts).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('envelopes send() frames with a unique id, timestamp and msg_type', async () => {
    const service = new WebSocketService('ws://server/ws');
    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;

    service.send('agent.ping', { n: 1 });
    service.send('agent.ping', { n: 2 });
    expect(socket.send).toHaveBeenCalledTimes(2);

    const first = frameAt(socket, 0);
    expect(first).toMatchObject({ msg_type: 'agent.ping', payload: { n: 1 } });
    expect(first.id).toMatch(/^msg_\d+_/);
    expect(typeof first.timestamp).toBe('number');

    const second = frameAt(socket, 1);
    expect(second.id).not.toBe(first.id);
    expect(second.msg_type).toBe('agent.ping');
  });

  it('correlates request() responses through the same envelope', async () => {
    const service = new WebSocketService('ws://server/ws');
    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;

    const request = service.request<{ ok: boolean }>('agents.list', { all: true });
    expect(socket.send).toHaveBeenCalledTimes(1);
    const frame = frameAt(socket, 0);
    expect(frame.msg_type).toBe('agents.list');
    expect(frame.payload).toEqual({ all: true });

    socket.message(JSON.stringify({
      msg_type: 'agents.list',
      id: frame.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('waitForConnection() times out, and rejects immediately when disconnected', async () => {
    const service = new WebSocketService('ws://server/ws');

    // Not connected at all: immediate rejects, nothing waits.
    await expect(service.waitForConnection()).rejects.toThrow('Connection lost');
    await expect(service.request('a.b', {})).rejects.toThrow('Connection lost');

    service.connect(); // socket created but never opened
    // Attach the handler at creation: the rejection fires inside the fake
    // timer tick (a macrotask boundary) and a later catch would be flagged.
    const outcome = service.waitForConnection(500).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await flushTimers(500);
    await expect(outcome).resolves.toBe('Connection timeout');
  });

  it('onBinary registers, dispatches ArrayBuffer frames and deregisters', async () => {
    const service = new WebSocketService('ws://server/ws');
    const handler = vi.fn();
    const unsubscribe = service.onBinary(handler);

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;

    const first = new ArrayBuffer(4);
    socket.message(first);
    expect(handler).toHaveBeenCalledWith(first);

    unsubscribe();
    const second = new ArrayBuffer(8);
    socket.message(second);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
