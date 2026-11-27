// not-protocol-file: this file tests the transport — correlation, timeouts and
// disposal — and names wires like `agents.list` because which wire it is has no
// bearing on what it proves. The protocol gate prints this exemption on every
// run so it cannot spread unnoticed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_BUFFERED_SEND_BYTES,
  SocketSendBufferFullError,
  WebSocketService,
} from '@/platform/socket/WebSocketService';
import { InvalidSocketEnvelopeError } from '@/platform/socket/envelope';
import { MockWebSocket } from '@/test/mockWebSocket';
import type {
  TransportPlugin,
  HandshakeSurface,
  SocketMessage,
  WebSocketServiceOptions,
} from '@/platform/socket/types';

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

/** Fresh mock-socket + fake-timer setup for a self-contained describe block. */
function useMockSocket(): void {
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
}

/** A connected service and the mock socket it opened. */
async function connectedService(
  options: WebSocketServiceOptions = {},
): Promise<{ service: WebSocketService; socket: MockWebSocket }> {
  const service = new WebSocketService('ws://server/ws', [], options);
  const connected = service.connect();
  const socket = MockWebSocket.instances[0];
  socket.open();
  await connected;
  return { service, socket };
}

function makePlugin(name: string, events: string[]): TransportPlugin {
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

  it('rejects the connection when the handshake is refused; in-flight work fails and no reconnect is scheduled', async () => {
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
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 5,
    });

    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));

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
    // No 'reconnecting' in between: a refusal settles, it does not retry.
    expect(states).toEqual(['connecting', 'disconnected']);

    // A refused handshake is an answer, not a loss: the same credentials would
    // be refused again, so the budget is not spent on it (#692).
    await flushTimers(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(service.reconnectAttempts).toBe(0);
  });

  it('re-runs the handshake per physical socket and recovers within the reconnect budget', async () => {
    let handshakeCount = 0;
    let resolveSecondHandshake!: () => void;
    const handshake = vi.fn(() => {
      handshakeCount += 1;
      if (handshakeCount === 1) {
        // Never settles: the first socket is dropped mid-handshake. That is
        // the loss a reconnect is for — a *refusal* is terminal instead (#692).
        return new Promise<void>(() => {});
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
    expect(handshakeCount).toBe(1);

    firstSocket.serverClose();
    await expect(connected).rejects.toThrow('Connection lost');

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
    // Only an established connection resets the budget, and this one did.
    expect(service.reconnectAttempts).toBe(0);
  });

  it('stops at maxReconnectAttempts when sockets keep opening but never establish (regression #692)', async () => {
    // The reported loop: every retry opened a socket, and the open reset the
    // counter before the handshake ran, so the budget never ran out.
    const handshake = vi.fn(() => new Promise<void>(() => {}));
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    void connected.catch(() => {});

    /** Open the newest socket, then drop it while its handshake is pending. */
    const connectAndLose = (): void => {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      socket.open();
      socket.serverClose();
    };

    connectAndLose();
    expect(service.reconnectAttempts).toBe(1);

    await flushTimers(50);
    expect(MockWebSocket.instances).toHaveLength(2);
    connectAndLose();
    expect(service.reconnectAttempts).toBe(2);

    await flushTimers(50);
    expect(MockWebSocket.instances).toHaveLength(3);
    connectAndLose();

    // Exhausted: the counter holds at the budget instead of resetting to 1,
    // and the transport settles rather than scheduling another attempt.
    expect(service.reconnectAttempts).toBe(2);
    expect(service.connectionState).toBe('disconnected');

    await flushTimers(60_000);
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(handshake).toHaveBeenCalledTimes(3);
  });

  it('keeps probing past the budget when the route is pinned to one address (#1263)', async () => {
    // Same exhaustion as #692 above, with the one difference that matters: this
    // route has no next candidate, so a spent budget cannot mean "gone".
    const handshake = vi.fn(() => new Promise<void>(() => {}));
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      persistentReconnect: true,
    });

    const connected = service.connect();
    void connected.catch(() => {});

    const connectAndLose = (): void => {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      socket.open();
      socket.serverClose();
    };

    connectAndLose();
    await flushTimers(50);
    connectAndLose();
    await flushTimers(50);
    connectAndLose();

    // Held at the budget rather than climbing, and — the point of the test —
    // still attempting. The *state*, though, is `disconnected`: a spent budget
    // on a route with nothing to rotate to is a verdict the caller has to be
    // able to read (its address policy turns it into `transport-exhausted`, and
    // the attach machine renders that), so it is reported once even though the
    // tail below keeps probing. Reporting it as `reconnecting` for as long as
    // the retries run is what left a client whose pinned route cannot complete a
    // handshake spinning over an empty terminal indefinitely.
    expect(service.reconnectAttempts).toBe(2);
    expect(service.connectionState).toBe('disconnected');

    // Another attempt is made rather than the transport settling. Asserted on
    // the socket the service built, not on the handshake: the handshake only
    // runs once that socket opens (see the case above), so counting it here
    // would be asserting the harness rather than the cadence.
    await flushTimers(20_000);
    expect(MockWebSocket.instances).toHaveLength(4);

    // And it continues: the tail is a cadence, not one last try. Note what
    // carries the verdict — the retry below re-enters `connect()` and the state
    // reads `connecting` again while it tries, which is why the report is a
    // transition (`disconnected`, once) rather than a state held open. The case
    // after this one counts it; this one pins the cadence.
    connectAndLose();
    await flushTimers(20_000);
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  it('leaves a reported exhaustion behind when the pinned route comes back (#1263)', async () => {
    // The other half of the case above. The report is a verdict about a moment
    // rather than a latch: a route that heals has to say so, and one that fails
    // again after healing has to be able to report again — otherwise the second
    // outage is as silent as the first.
    const gate = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: gate.handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      persistentReconnect: true,
      // This case pins the reconnect-reporting cadence, not the dial deadline;
      // keep the dial window wide so the tail's CONNECTING socket survives the
      // 20s advance until the test opens it (#4618 dial deadline is tested below).
      dialTimeoutMs: 60_000,
    });
    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));
    void service.connect().catch(() => {});

    const newest = (): MockWebSocket =>
      MockWebSocket.instances[MockWebSocket.instances.length - 1];
    /** Open the newest socket, then drop it while its handshake is pending. */
    const loseNewest = (): void => {
      newest().open();
      newest().serverClose();
    };

    loseNewest();
    await flushTimers(50);
    loseNewest();
    await flushTimers(50);
    loseNewest();

    expect(service.reconnectAttempts).toBe(2);
    expect(service.connectionState).toBe('disconnected');
    expect(states.filter((state) => state === 'disconnected')).toHaveLength(1);

    // The tail is still a cadence, and its retries do not re-report.
    await flushTimers(20_000);
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(states.filter((state) => state === 'disconnected')).toHaveLength(1);

    // The route answers: the socket opens and its handshake completes.
    const healed = newest();
    healed.open();
    gate.resolve();
    await drainMicrotasks();
    expect(service.connectionState).toBe('connected');
    expect(service.reconnectAttempts).toBe(0);

    // A later outage starts a new episode: two fast losses, and the third
    // reports again rather than inheriting the previous silence.
    healed.serverClose();
    await flushTimers(50);
    loseNewest();
    await flushTimers(50);
    loseNewest();

    expect(service.connectionState).toBe('disconnected');
    expect(states.filter((state) => state === 'disconnected')).toHaveLength(2);
  });

  it('settles on disconnected past the budget without persistentReconnect', async () => {
    // The other direction, so the branch above cannot pass by never exhausting
    // at all: the same run without the flag must still settle.
    const handshake = vi.fn(() => new Promise<void>(() => {}));
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    void connected.catch(() => {});

    const connectAndLose = (): void => {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      socket.open();
      socket.serverClose();
    };

    connectAndLose();
    await flushTimers(50);
    connectAndLose();
    await flushTimers(50);
    connectAndLose();

    expect(service.reconnectAttempts).toBe(2);
    expect(service.connectionState).toBe('disconnected');

    await flushTimers(60_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('recovers a failed first dial when reconnectOnInitialFailure is set (#3358 SC-02)', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      reconnectOnInitialFailure: true,
    });
    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));

    const first = service.connect();
    void first.catch(() => {});
    MockWebSocket.instances[0].error();

    // Not a dead candidate: the logical connection is retained and retried.
    expect(service.connectionState).toBe('reconnecting');
    expect(states).not.toContain('disconnected');

    await flushTimers(20);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].open();
    await drainMicrotasks();
    expect(service.connectionState).toBe('connected');
  });

  it('reports the spent budget once but never leaves reconnecting when reportExhaustion is false (#3358 SC-01/04)', async () => {
    const handshake = vi.fn(() => new Promise<void>(() => {}));
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      persistentReconnect: true,
      reportExhaustion: false,
    });
    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));
    void service.connect().catch(() => {});

    const connectAndLose = (): void => {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      socket.open();
      socket.serverClose();
    };

    connectAndLose();
    await flushTimers(50);
    connectAndLose();
    await flushTimers(50);
    connectAndLose();
    await flushTimers(50);

    // The long tail keeps probing and the shell-visible state is recoverable;
    // it must never flip to the terminal `disconnected` state that is what
    // sends an already-authenticated workspace back to Login.
    expect(service.reconnectAttempts).toBe(2);
    expect(service.connectionState).toBe('reconnecting');
    expect(states).not.toContain('disconnected');
    await flushTimers(20_000);
    expect(MockWebSocket.instances).toHaveLength(4);
    // The tail attempt is in flight: `connecting` while it tries, never the
    // terminal `disconnected` that would unmount the workspace.
    expect(['connecting', 'reconnecting']).toContain(service.connectionState);
    expect(states).not.toContain('disconnected');
  });

  it('treats a handshake timeout as a recoverable loss when the caller classifies it so (#3358 SC-02)', async () => {
    const onHandshakeRejected = vi.fn();
    let attempts = 0;
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: async () => {
        attempts += 1;
        throw new Error('Request timeout: server.auth');
      },
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      isHandshakeRefusal: (error) => !error.message.includes('timeout'),
      onHandshakeRejected,
    });
    const states: string[] = [];
    service.onConnectionStateChange((state) => states.push(state));

    void service.connect().catch(() => {});
    MockWebSocket.instances[0].open();
    await drainMicrotasks();

    // The socket opened but never answered: this is a loss, not a refusal.
    expect(onHandshakeRejected).not.toHaveBeenCalled();
    expect(service.connectionState).toBe('reconnecting');
    expect(states).not.toContain('disconnected');

    await flushTimers(20);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].open();
    await drainMicrotasks();
    expect(attempts).toBe(2);
    expect(service.connectionState).toBe('reconnecting');
  });

  it('keeps an explicit handshake refusal terminal and reports it to the owner (#692)', async () => {
    const onHandshakeRejected = vi.fn();
    const service = new WebSocketService('ws://server/ws', [], {
      handshake: async () => {
        throw new Error('bad token');
      },
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
      isHandshakeRefusal: () => true,
      onHandshakeRejected,
    });
    void service.connect().catch(() => {});
    MockWebSocket.instances[0].open();
    await drainMicrotasks();

    expect(onHandshakeRejected).toHaveBeenCalledTimes(1);
    expect(service.connectionState).toBe('disconnected');
    await flushTimers(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('emits redacted close facts and never the URL or credential (#3358 SC-05)', async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const service = new WebSocketService('ws://server/ws?token=secret-token', [], {
      onDiagnostic: (diagnostic) => diagnostics.push({ ...diagnostic }),
    });
    void service.connect().catch(() => {});
    const socket = MockWebSocket.instances[0];
    socket.open();
    await drainMicrotasks();

    (socket.onclose as unknown as ((event: CloseEvent) => void) | null)?.({
      code: 1006,
      wasClean: false,
      reason: 'abnormal',
    } as CloseEvent);

    const close = diagnostics.find((entry) => entry.event === 'socket-close');
    expect(close).toMatchObject({ code: 1006, wasClean: false, reason: 'abnormal' });

    // A peer-supplied reason that could carry a URL or token is dropped, not
    // merely truncated.
    (socket.onclose as unknown as ((event: CloseEvent) => void) | null)?.({
      code: 1000,
      wasClean: true,
      reason: 'ws://server/ws?token=secret-token',
    } as CloseEvent);
    const closes = diagnostics.filter((entry) => entry.event === 'socket-close');
    expect(closes[closes.length - 1].reason).toBeUndefined();

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('ws://server/ws');
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
    const plugin: TransportPlugin = {
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

  it('keeps automatic recovery alive when a retry socket fails with onerror (#1213 SC-15)', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      maxReconnectAttempts: 3,
      reconnectBaseDelay: 5,
    });
    const initial = service.connect();
    const oldSocket = MockWebSocket.instances[0];
    oldSocket.open();
    await initial;

    oldSocket.serverClose();
    expect(service.connectionState).toBe('reconnecting');
    expect(service.reconnectAttempts).toBe(1);
    await flushTimers(5);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Chromium emits onerror during failed offline reconnect attempts. This
    // differs from the original dial: recovery must continue automatically
    // rather than stopping on "disconnected" with no remaining retry timer.
    const offlineRetry = MockWebSocket.instances[1];
    offlineRetry.error();
    offlineRetry.serverClose(); // close after error may not count the loss twice
    expect(service.connectionState).toBe('reconnecting');
    expect(service.reconnectAttempts).toBe(2);

    await flushTimers(10);
    expect(MockWebSocket.instances).toHaveLength(3);
    const healed = MockWebSocket.instances[2];
    healed.open();
    await drainMicrotasks();

    expect(service.connectionState).toBe('connected');
    expect(service.reconnectAttempts).toBe(0);
    await flushTimers(100);
    expect(MockWebSocket.instances).toHaveLength(3);
    service.dispose();
  });

  it('bounds retries after successive onerror reconnect failures (#1213 SC-14)', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });
    const initial = service.connect();
    MockWebSocket.instances[0].open();
    await initial;
    MockWebSocket.instances[0].serverClose();
    await flushTimers(5);

    const firstRetry = MockWebSocket.instances[1];
    firstRetry.error();
    firstRetry.serverClose();
    expect(service.reconnectAttempts).toBe(2);
    await flushTimers(10);

    const secondRetry = MockWebSocket.instances[2];
    secondRetry.error();
    secondRetry.serverClose();
    expect(service.connectionState).toBe('disconnected');
    expect(service.reconnectAttempts).toBe(2);
    await flushTimers(100);
    expect(MockWebSocket.instances).toHaveLength(3);
    service.dispose();
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

  // `reportUnresponsive` is how a liveness probe tells the transport its peer
  // went silent. Every assertion here is about it behaving *exactly* like a
  // real loss: downstream recovery (reconnect budget, candidate rotation,
  // force-relay) keys off the state transition and nothing else, so a special
  // path would silently skip all of it (#1233).
  // `ProtocolDirectory` hangs off the service but describes the peers on one
  // physical socket (#3990). The service outlives every socket, so unless the
  // directory is emptied at each generation boundary the next connection
  // resolves Git/Claude calls against the previous connection's Agent
  // snapshot — a manifest nobody on the new socket has vouched for.
  describe('protocol directory across physical sockets (#3990)', () => {
    const MANIFEST = {
      provider: 'agent-a',
      protocols: { 'git.status': { versions: [1] } },
    };

    it('empties the directory when a live socket is lost, before a replacement exists', async () => {
      const service = new WebSocketService('ws://server/ws', [], {
        maxReconnectAttempts: 0,
      });
      const connected = service.connect();
      MockWebSocket.instances[0].open();
      await connected;

      service.protocols.publish(new Map([['agent-a', MANIFEST]]));
      expect(service.protocols.targetProtocols('agent-a')).toEqual({
        kind: 'present',
        manifest: MANIFEST,
      });

      MockWebSocket.instances[0].serverClose();

      // The snapshot described the socket that just died. Until a fresh Agent
      // list arrives over a live connection, the honest answer — and the one
      // that refuses instead of resolving — is that this connection does not
      // know the target yet.
      expect(service.connectionState).toBe('disconnected');
      expect(service.protocols.targetProtocols('agent-a')).toEqual({ kind: 'unknown' });
    });

    it('starts every replacement socket with no manifests inherited from its predecessor', async () => {
      const service = new WebSocketService('ws://server/ws', [], {
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 5,
      });
      const connected = service.connect();
      MockWebSocket.instances[0].open();
      await connected;
      service.protocols.publish(new Map([['agent-a', MANIFEST]]));

      MockWebSocket.instances[0].serverClose();
      // A publication landing in the reconnect window — where a delayed G1
      // list response would settle — must not survive into G2 either. The next
      // generation starts empty and only its own list can fill it.
      service.protocols.publish(new Map([['agent-a', MANIFEST]]));

      await flushTimers(50);
      const replacement = MockWebSocket.instances[1];
      expect(replacement).toBeDefined();
      expect(service.protocols.targetProtocols('agent-a')).toEqual({ kind: 'unknown' });

      replacement.open();
      expect(service.connectionState).toBe('connected');
      expect(service.protocols.targetProtocols('agent-a')).toEqual({ kind: 'unknown' });
    });
  });

  describe('reportUnresponsive', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs the ordinary loss path, scheduling exactly one reconnect', async () => {
      const service = new WebSocketService('ws://agent/ws', [], {
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 5,
      });
      const connected = service.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(service.connectionState).toBe('connected');

      service.reportUnresponsive();

      // The mutation this pins: routing the teardown through the socket's own
      // `onclose` as well. `teardownSocket()` detaches that handler precisely
      // so the two cannot both fire — with both, this reads 2 and the caller
      // burns reconnect budget twice as fast as the network actually failed.
      expect(service.connectionState).toBe('reconnecting');
      expect(service.reconnectAttempts).toBe(1);

      await flushTimers(50);
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('leaves a socket that is already gone alone', async () => {
      const service = new WebSocketService('ws://agent/ws', [], {
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 5,
      });
      const connected = service.connect();
      MockWebSocket.instances[0].open();
      await connected;

      service.disconnect();
      expect(service.connectionState).toBe('disconnected');

      service.reportUnresponsive();

      // `disconnect()` is terminal by design; a stale probe must not resurrect
      // the transport or add reconnect attempts to a torn-down service.
      expect(service.connectionState).toBe('disconnected');
      expect(service.reconnectAttempts).toBe(0);
      await flushTimers(50);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});

// #4069: the generic transport owns byte-level outbound admission. A browser
// native send buffer is unbounded until the browser gives up on it; these
// fixtures keep the budget finite and observable without a real network.
describe('bounded outbound send admission (#4069)', () => {
  useMockSocket();

  it('refuses a message that would exceed the budget and does not enqueue it', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 100 });
    socket.bufferedAmount = 80;

    expect(() => service.send('agent.ping', { padding: 'x'.repeat(40) }))
      .toThrow(SocketSendBufferFullError);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('reports bounded-pressure facts on the typed error', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 100 });
    socket.bufferedAmount = 80;

    let caught: unknown;
    try {
      service.send('agent.ping', { padding: 'x'.repeat(40) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SocketSendBufferFullError);
    const error = caught as SocketSendBufferFullError;
    expect(error.bufferedBytes).toBe(80);
    expect(error.limitBytes).toBe(100);
    expect(error.messageBytes).toBeGreaterThan(20);
  });

  it('admits messages under the limit in order, exactly once each', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 10_000 });
    socket.bufferedAmount = 0;

    service.send('agent.ping', { n: 1 });
    service.send('agent.ping', { n: 2 });
    service.send('agent.ping', { n: 3 });

    expect(socket.send).toHaveBeenCalledTimes(3);
    expect(frameAt(socket, 0).payload).toEqual({ n: 1 });
    expect(frameAt(socket, 1).payload).toEqual({ n: 2 });
    expect(frameAt(socket, 2).payload).toEqual({ n: 3 });
  });

  it('uses a finite default budget when the caller configures none', async () => {
    const { service, socket } = await connectedService();
    expect(Number.isFinite(DEFAULT_MAX_BUFFERED_SEND_BYTES)).toBe(true);

    socket.bufferedAmount = DEFAULT_MAX_BUFFERED_SEND_BYTES;
    expect(() => service.send('agent.ping', {})).toThrow(SocketSendBufferFullError);

    socket.bufferedAmount = 0;
    service.send('agent.ping', {});
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('counts UTF-8 bytes, not JavaScript string length', async () => {
    // 40 CJK characters are 40 code units but 120 UTF-8 bytes. With this budget
    // a length-based check admits the frame (~160 bytes of text) while the
    // browser would actually queue ~240 bytes.
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 200 });
    socket.bufferedAmount = 0;

    expect(() => service.send('agent.ping', { text: '漢'.repeat(40) }))
      .toThrow(SocketSendBufferFullError);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('settles a request refused by admission without leaking a pending entry', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 500 });
    socket.bufferedAmount = 500;

    const refused = service.request('agents.list', {});
    await expect(refused).rejects.toBeInstanceOf(SocketSendBufferFullError);
    expect(socket.send).not.toHaveBeenCalled();

    // The pending slot is gone, so the next request correlates normally once
    // the socket drains.
    socket.bufferedAmount = 0;
    const accepted = service.request<{ ok: boolean }>('agents.list', {});
    const frame = frameAt(socket, 0);
    socket.message(JSON.stringify({
      msg_type: 'agents.list',
      id: frame.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));
    await expect(accepted).resolves.toEqual({ ok: true });
  });

  it('sendTracked claims no id or generation when admission refuses the frame', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 100 });
    socket.bufferedAmount = 100;

    expect(() => service.sendTracked('agent.ping', {})).toThrow(SocketSendBufferFullError);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('keeps bounded behaviour across repeated saturation', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 1_000 });
    socket.bufferedAmount = 1_000;

    for (let i = 0; i < 50; i += 1) {
      expect(() => service.send('agent.ping', { n: i }))
        .toThrow(SocketSendBufferFullError);
    }
    expect(socket.send).not.toHaveBeenCalled();

    socket.bufferedAmount = 0;
    service.send('agent.ping', { n: 50 });
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('resets with the physical socket: no refused message is replayed after reconnect', async () => {
    const { service, socket } = await connectedService({
      maxBufferedSendBytes: 1_000,
      reconnectBaseDelay: 5,
      maxReconnectAttempts: 5,
    });
    socket.bufferedAmount = 1_000;
    expect(() => service.send('agent.ping', { n: 1 })).toThrow(SocketSendBufferFullError);

    socket.serverClose();
    await flushTimers(10);
    expect(MockWebSocket.instances).toHaveLength(2);
    const next = MockWebSocket.instances[1];
    next.open();
    await drainMicrotasks();
    expect(service.connectionState).toBe('connected');

    next.bufferedAmount = 0;
    service.send('agent.ping', { n: 2 });
    expect(next.send).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('dispose() drops the saturated socket without replaying refused messages', async () => {
    const { service, socket } = await connectedService({ maxBufferedSendBytes: 100 });
    socket.bufferedAmount = 500;
    expect(() => service.send('agent.ping', { n: 1 })).toThrow(SocketSendBufferFullError);

    service.dispose();
    expect(socket.send).not.toHaveBeenCalled();
    expect(() => service.send('agent.ping', { n: 2 })).toThrow('WebSocketService disposed');
  });

  it('treats admission pressure during the handshake as a loss, not a refusal', async () => {
    const handshake = vi.fn(async (surface: HandshakeSurface) => {
      surface.send('auth.begin', {});
    });
    const service = new WebSocketService('ws://server/ws', [], {
      handshake,
      maxBufferedSendBytes: 50,
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 5,
    });

    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.bufferedAmount = 50;
    socket.open();

    await expect(connected).rejects.toBeInstanceOf(SocketSendBufferFullError);
    await drainMicrotasks();
    // Bounded pressure is not the peer's answer; it must stay recoverable.
    expect(service.connectionState).toBe('reconnecting');
    await flushTimers(10);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });
});

// #4070: TypeScript's `as SocketMessage` does not validate the wire. The
// generic transport is the one place every server frame crosses, so it owns
// the shared-envelope check; payload contracts stay with their plugins.
describe('inbound envelope validation (#4070)', () => {
  useMockSocket();

  it('rejects malformed frames before routing and emits bounded, redacted diagnostics', async () => {
    const onError = vi.fn();
    const onDiagnostic = vi.fn();
    const { service, socket } = await connectedService({ onError, onDiagnostic });
    const handler = vi.fn();
    service.subscribe('agent.ping', handler);
    const secret = 'super-secret-token-value';

    // Not JSON, and the raw text carries a credential that must not surface.
    socket.message(`{"msg_type":"agent.ping","id":"1","timestamp":1,"auth_token":"${secret}"`);

    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(InvalidSocketEnvelopeError);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'invalid-envelope',
      generation: 1,
      frameClass: 'malformed-json',
    }));
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(secret);
    const reported = onError.mock.calls[0]?.[0] as Error;
    expect(reported.message).not.toContain(secret);
  });

  it('rejects non-envelope JSON without reaching subscribers', async () => {
    const onError = vi.fn();
    const { service, socket } = await connectedService({ onError });
    const handler = vi.fn();
    service.subscribe('agent.ping', handler);

    for (const raw of ['"just-a-string"', 'null', '[]', '42',
      JSON.stringify({ msg_type: 'agent.ping', timestamp: 1, payload: {} }),
      JSON.stringify({ msg_type: 'agent.ping', id: 'i', timestamp: 1 }),
    ]) {
      socket.message(raw);
    }

    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(6);
  });

  it('does not settle an unrelated pending request from an invalid frame carrying its id', async () => {
    const { service, socket } = await connectedService();
    const request = service.request<{ ok: boolean }>('agents.list', {});
    const frame = frameAt(socket, 0);

    // Correct id, but not a canonical envelope: it must never reach the
    // pending map and settle a request it does not answer.
    socket.message(JSON.stringify({ id: frame.id, timestamp: Date.now(), payload: { ok: false } }));
    await drainMicrotasks();
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);

    socket.message(JSON.stringify({
      msg_type: 'agents.list',
      id: frame.id,
      timestamp: Date.now(),
      payload: { ok: true },
    }));
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('a malformed error frame cannot reject a pending request, while a valid error envelope still does', async () => {
    const { service, socket } = await connectedService();
    const request = service.request('agents.list', {});
    const frame = frameAt(socket, 0);

    socket.message(JSON.stringify({ msg_type: 'error', id: frame.id, timestamp: Date.now() }));
    await drainMicrotasks();
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);

    socket.message(JSON.stringify({
      msg_type: 'error',
      id: frame.id,
      timestamp: Date.now(),
      payload: { message: 'denied' },
    }));
    await expect(request).rejects.toThrow('denied');
  });

  it('delivers a valid unknown future wire exactly once', async () => {
    const { service, socket } = await connectedService();
    const handler = vi.fn();
    service.subscribe('future.subject.event', handler);

    socket.message(JSON.stringify({
      msg_type: 'future.subject.event',
      id: 'f-1',
      timestamp: Date.now(),
      payload: [1, 2],
    }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual([1, 2]);
  });
});

describe('WebSocketService dial deadline (#4618 SC-05)', () => {
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

  it('settles a CONNECTING dial with no browser callbacks at the deadline', async () => {
    const diags: { event: string }[] = [];
    const service = new WebSocketService('ws://server/ws', [], {
      dialTimeoutMs: 5_000,
      onDiagnostic: (d) => diags.push(d),
    });
    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    expect(socket.readyState).toBe(MockWebSocket.CONNECTING);
    const rejection = connected.catch((error: Error) => error);

    await flushTimers(5_000);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/dial timeout/i);
    expect(service.connectionState).toBe('disconnected');
    expect(diags.some((d) => d.event === 'dial-timeout')).toBe(true);
    service.dispose();
  });

  it('honors a configured dial deadline', async () => {
    const service = new WebSocketService('ws://server/ws', [], { dialTimeoutMs: 1_000 });
    const connected = service.connect();
    const rejection = connected.catch((error: Error) => error);
    await flushTimers(999);
    expect(service.connectionState).toBe('connecting');
    await flushTimers(1);
    await rejection;
    expect(service.connectionState).toBe('disconnected');
    service.dispose();
  });

  it('routes a dial timeout through recovery when reconnectOnInitialFailure is set', async () => {
    const service = new WebSocketService('ws://server/ws', [], {
      dialTimeoutMs: 5_000,
      reconnectOnInitialFailure: true,
      reconnectBaseDelay: 1_000,
    });
    const connected = service.connect();
    void connected.catch(() => {});
    await flushTimers(5_000);
    expect(service.connectionState).toBe('reconnecting');
    // The backoff timer dials a fresh physical socket.
    await flushTimers(1_000);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    service.dispose();
  });

  it('rejects waiters exactly once on dial timeout', async () => {
    const service = new WebSocketService('ws://server/ws', [], { dialTimeoutMs: 5_000 });
    void service.connect().catch(() => {});
    const waiter = service.waitForConnection(10_000);
    const rejection = waiter.catch((error: Error) => error);
    await flushTimers(5_000);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(service.connectionState).toBe('disconnected');
    service.dispose();
  });

  it('a late open after the dial deadline cannot resurrect the socket', async () => {
    const service = new WebSocketService('ws://server/ws', [], { dialTimeoutMs: 5_000 });
    const connected = service.connect();
    void connected.catch(() => {});
    const socket = MockWebSocket.instances[0];
    await flushTimers(5_000);
    expect(service.connectionState).toBe('disconnected');
    // The browser finally fires open on the torn-down socket — it must be inert.
    socket.open();
    await drainMicrotasks();
    expect(service.connectionState).toBe('disconnected');
    service.dispose();
  });

  it('dispose rejects the pending connect once and the deadline stays inert', async () => {
    const service = new WebSocketService('ws://server/ws', [], { dialTimeoutMs: 5_000 });
    const connected = service.connect();
    const rejection = connected.catch((error: Error) => error);
    service.dispose();
    const error = await rejection;
    expect((error as Error).message).toMatch(/disposed/i);
    // The dial timer must not double-settle or throw after dispose.
    await flushTimers(5_000);
    expect(service.connectionState).toBe('disconnected');
  });

  it('open clears the dial deadline; the handshake owns the post-open timeout', async () => {
    const diags: { event: string }[] = [];
    const hs = controlledHandshake();
    const service = new WebSocketService('ws://server/ws', [], {
      dialTimeoutMs: 5_000,
      handshake: hs.handshake,
      onDiagnostic: (d) => diags.push(d),
    });
    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open(); // clears the dial deadline
    await flushTimers(10_000); // well past the dial deadline
    expect(diags.some((d) => d.event === 'dial-timeout')).toBe(false);
    expect(service.connectionState).toBe('connecting'); // handshake still pending
    hs.resolve();
    await connected;
    expect(service.connectionState).toBe('connected');
    service.dispose();
  });
});
