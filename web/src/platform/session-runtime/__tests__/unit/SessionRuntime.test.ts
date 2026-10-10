import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFilesApi } from '@/capabilities/files';
import { createTerminalAgentApi } from '@/product/terminal';
import { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { ATTACH_TIMEOUT_MS, P2P_MAX_RECONNECT, type AttachTransitionResult } from '@/platform/attach/AttachStateMachine';
import { WebSocketService } from '@/platform/socket/WebSocketService';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';
import type { ConnectionState } from '@/platform/socket/types';
import type { ConnectionOptions } from '@/platform/terminal-runtime/types';
import type { TerminalInputSeed, TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { AttachInfo } from '@/types';

vi.mock('@/platform/socket/clientId', () => ({
  getOrCreateClientId: () => 'unit-client',
}));

const OriginalWebSocket = globalThis.WebSocket;

interface MockWs {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
}

let wsInstances: MockWs[] = [];

function lastWs(): MockWs {
  return wsInstances[wsInstances.length - 1];
}

/**
 * Drain a `client.auth` round trip's microtask chain — reply → router →
 * handshake → connection state → listener → attach. A loop rather than a timer
 * because some of this file's callers run on fake timers, and a loop rather
 * than `flushMicrotasks`' two hops because the chain is longer than the one
 * `requestRelayAttach` was measured for.
 */
async function drainHandshake(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Drive the latest mock ws to the open state and answer its `client.auth`
 * handshake — what the Agent does before any frame can be served by an
 * identity (#1429). Async because the handshake is a round trip: the
 * connection reaches 'connected' a microtask after the reply. Pass
 * `answerAuth: false` to leave the connection mid-handshake.
 */
async function openWs({ answerAuth = true }: { answerAuth?: boolean } = {}): Promise<void> {
  const ws = lastWs();
  ws.readyState = 1;
  ws.onopen?.(new Event('open'));
  if (answerAuth) {
    answerPending('client.auth', 'ok', {
      status: 'success',
      message: 'ok',
      client_id: 'unit-client',
    });
  }
  await drainHandshake();
}

/** Every frame the runtime sent, in send order, across all tracked sockets. */
function sentFrames(): { msg_type?: string; id?: string; payload?: unknown }[] {
  const frames: { msg_type?: string; id?: string; payload?: unknown }[] = [];
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      try {
        frames.push(JSON.parse(String(call[0])));
      } catch {
        // non-JSON (binary) frame — ignore
      }
    }
  }
  return frames;
}

/** Count client.attach messages sent on any tracked ws. */
function countClientAttach(): number {
  let count = 0;
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0]));
        if (parsed.msg_type === 'agent.attach') {
          count += 1;
        }
      } catch {
        // non-JSON (binary) frame — ignore
      }
    }
  }
  return count;
}


/**
 * The `needs_bootstrap` value of every `agent.attach` sent on any tracked ws,
 * in send order. `undefined` for a frame that omitted the field — which is a
 * different claim from `false` and the one an older client makes (#321).
 */
function clientAttachBootstrapFlags(): (boolean | undefined)[] {
  const flags: (boolean | undefined)[] = [];
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0]));
        if (parsed.msg_type === 'agent.attach') {
          flags.push(parsed.payload.needs_bootstrap);
        }
      } catch {
        // non-JSON (binary) frame — ignore
      }
    }
  }
  return flags;
}

/** Flush one or two microtask hops (requestRelayAttach defers relay attach). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:s1',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

/**
 * A transport the runtime can hand out in tests: records the options it was
 * built with (which agent API it binds is the whole point of #1309 SC-04)
 * and vi.fn-tracks the seed/flush surface the runtime applies on attach.
 */
interface MockTransport extends TerminalTransport {
  readonly builtWith: ConnectionOptions;
  seedInputCursor: ReturnType<typeof vi.fn<(seed: TerminalInputSeed | undefined) => void>>;
  seedStreamCursor: ReturnType<typeof vi.fn<(streamEpoch: number | undefined, streamCursor: number | undefined) => void>>;
  flushAllOutbound: ReturnType<typeof vi.fn<() => void>>;
}

function makeMockTransport(opts: ConnectionOptions): MockTransport {
  return {
    mode: opts.mode,
    builtWith: opts,
    onOutput: null,
    onResize: null,
    onError: null,
    send: vi.fn(),
    sendResize: vi.fn(),
    seedStreamCursor: vi.fn<(streamEpoch: number | undefined, streamCursor: number | undefined) => void>(),
    seedInputCursor: vi.fn<(seed: TerminalInputSeed | undefined) => void>(),
    flushInputBuffer: vi.fn(),
    flushPendingResize: vi.fn(),
    flushAllOutbound: vi.fn<() => void>(),
    dispose: vi.fn(),
  };
}

/** Every transport the runtime built, in build order. */
let builtTransports: MockTransport[] = [];

function lastTransport(): MockTransport {
  return builtTransports[builtTransports.length - 1];
}

function makeConfig(overrides: Partial<ConstructorParameters<typeof SessionRuntime>[0]> = {}) {
  return {
    sessionId: 'agent:s1',
    sessionName: 's1',
    attachInfo: makeAttachInfo(),
    orderedUrls: ['ws://a/ws', 'ws://b/ws'],
    manualOverride: null,
    forcedRelay: false,
    addressUrls: ['ws://a/ws', 'ws://b/ws'],
    routeIntentEpoch: 0,
    createFilesApi,
    createTerminalAgentApi,
    createTransport: (opts: ConnectionOptions) => {
      const transport = makeMockTransport(opts);
      builtTransports.push(transport);
      return transport;
    },
    ...overrides,
  };
}

function makeRelayServerConnection(initialState: ConnectionState = 'disconnected') {
  const listeners = new Set<(state: ConnectionState) => void>();
  let current: ConnectionState = initialState;
  const beginRelay = vi.fn();
  return {
    beginRelay,
    endRelay: vi.fn(),
    isReady: () => current === 'connected',
    emit(next: ConnectionState) {
      current = next;
      for (const cb of listeners) {
        cb(current);
      }
    },
    onConnectionStateChange(cb: (state: ConnectionState) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // The relay-I/O half of RelayServerTransport: the runtime never drives it —
    // that is the transport's half — so inert stubs are the faithful shape here.
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onRelayOutput: () => () => {},
    onRelayResize: () => () => {},
    onRelayInputAck: () => () => {},
  } satisfies RelayServerTransport & { emit(state: ConnectionState): void };
}

/** Ids already answered, so a helper cannot settle the same request twice. */
let answeredIds = new Set<string>();

/** How many `control.ping` requests have gone out on any tracked ws. */
function countPings(): number {
  let count = 0;
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      try {
        if (JSON.parse(String(call[0])).msg_type === 'control.ping') {
          count += 1;
        }
      } catch {
        // non-JSON (binary) frame — ignore
      }
    }
  }
  return count;
}

/**
 * Reply to every tracked request of `type` that has not been answered yet.
 *
 * Tracked by id rather than "always the first": answering an already-settled
 * request is a no-op, so a helper that re-answered the oldest ping would leave
 * every later one to time out and would make a healthy transport look dead.
 */
function answerPending(type: string, replyType: string, payload: unknown = {}): number {
  let answered = 0;
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      let parsed: { msg_type?: string; id?: string };
      try {
        parsed = JSON.parse(String(call[0]));
      } catch {
        continue;
      }
      if (parsed.msg_type !== type || !parsed.id || answeredIds.has(parsed.id)) {
        continue;
      }
      answeredIds.add(parsed.id);
      // The agent answers as `make_response(&self.id, …)` — the reply
      // carries the request's own id, which is what the request layer
      // matches on. Reproducing that is the point: a reply with a different
      // id would prove nothing about correlation.
      ws.onmessage?.({
        data: JSON.stringify({ msg_type: replyType, id: parsed.id, payload }),
      } as MessageEvent);
      answered += 1;
    }
  }
  return answered;
}

/** Ack every pending `agent.attach`: the difference between a runtime that
 * reaches `attached` and one that sits in `connecting` until it times out. */
function answerAttach(): number {
  return answerPending('agent.attach', 'ok');
}

function answerPings(): number {
  return answerPending('control.ping', 'control.pong');
}

describe('SessionRuntime', () => {
  beforeEach(() => {
    wsInstances = [];
    answeredIds = new Set();
    builtTransports = [];
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      url: string;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        wsInstances.push(this);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('selects its session at construction — idle promotes to connecting with no React driver (#1309 SC-01)', () => {
    const rt = new SessionRuntime(makeConfig());
    // The dispatch is synchronous in the constructor: a runtime that outlives
    // its React tree (registry lease) still attaches, because selection is a
    // construction fact rather than an effect noticing the runtime.
    expect(rt.attachState.phase).toBe('connecting');
    expect(rt.getSnapshot().phase).toBe('connecting');
    rt.dispose();
  });

  it('binds the browser identity on the P2P socket before anything depends on it (#1429)', async () => {
    // The Agent roles and authorizes every attach/control/input by the
    // connection's `client_id`, which only `client.auth` sets — without it the
    // connection is `unknown-client`, a different principal from the browser's
    // own id, and the two sides disagree about who controls the session.
    const rt = new SessionRuntime(makeConfig());
    rt.setTransportReady(true);
    await openWs();

    const frames = sentFrames();
    const authIndex = frames.findIndex((f) => f.msg_type === 'client.auth');
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(frames[authIndex].payload).toMatchObject({ client_id: 'unit-client' });
    // The attach's meaning depends on that identity, so the Agent must read it
    // after the auth: order on this one socket is what guarantees it.
    const attachIndex = frames.findIndex((f) => f.msg_type === 'agent.attach');
    expect(attachIndex).toBeGreaterThan(authIndex);
    rt.dispose();
  });

  it('holds the attach until the identity handshake is answered (#1429)', async () => {
    // The gate is the point: an identity sent *at some point* would still race
    // the attach, and the Agent would serve it as `unknown-client`.
    const rt = new SessionRuntime(makeConfig());
    rt.setTransportReady(true);
    await openWs({ answerAuth: false });

    expect(rt.connectionState).toBe('connecting');
    expect(countClientAttach()).toBe(0);

    answerPending('client.auth', 'ok', {
      status: 'success',
      message: 'ok',
      client_id: 'unit-client',
    });
    await drainHandshake();

    expect(rt.connectionState).toBe('connected');
    expect(countClientAttach()).toBe(1);
    rt.dispose();
  });

  it('dials the plan\'s first candidate at construction — no gate, no probe wait (#1430)', () => {
    // The issue's scenario, at the runtime's level: candidate A answers in
    // 30 ms and candidate B would time out at 3 s, but the runtime can see
    // neither measurement — the plan is the advertisement's own order and the
    // first entry is dialled synchronously, with no readiness signal to wait
    // for and no second socket.
    const rt = new SessionRuntime(makeConfig());
    expect(wsInstances).toHaveLength(1);
    expect(lastWs().url).toBe('ws://a/ws?token=tok');
    expect(rt.activeUrl).toBe('ws://a/ws');
    expect(rt.getAgentTerminalApi()).not.toBeNull();
    expect(rt.getFilesApi()).not.toBeNull();
    rt.dispose();
  });

  it('clears client when forced to relay', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.updateContext({ forcedRelay: true });
    expect(rt.activeUrl).toBeNull();
    expect(rt.getAgentTerminalApi()).toBeNull();
    expect(rt.getFilesApi()).toBeNull();
    rt.dispose();
  });

  it('advances candidate and reconfigures client on disconnect', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    rt.dispose();
  });

  it('builds no agent API when the plan carries no addresses (#1430)', () => {
    // An empty plan is a resolved answer now: there is no "not ready" state
    // left to wait in, so it means the advertisement named no candidate and
    // there is no legacy address either — nothing to dial.
    const rt = new SessionRuntime(makeConfig({ addressUrls: [] }));
    expect(rt.activeUrl).toBeNull();
    expect(rt.getAgentTerminalApi()).toBeNull();
    rt.dispose();
  });

  it('subscribeConnectionState returns noop when no client', () => {
    const rt = new SessionRuntime(makeConfig({ attachInfo: null }));
    const unsub = rt.subscribeConnectionState(() => {});
    expect(unsub).toBeTypeOf('function');
    unsub();
  });

  it('resets address index and attach phase when route epoch changes', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    rt.updateContext({ routeIntentEpoch: 1 });
    expect(rt.activeUrl).toBe('ws://a/ws');
    expect(rt.attachState.phase).toBe('connecting');
    rt.dispose();
  });

  it('route intent change emits route-intent-changed event', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    rt.updateContext({ routeIntentEpoch: 1, manualOverride: 'ws://a/ws' });
    expect(rt.attachState.phase).toBe('connecting');
    expect(events).toContain('route-intent-changed');
    rt.dispose();
  });

  it('emits runtime events on candidate advancement', () => {
    const rt = new SessionRuntime(makeConfig());
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    expect(events).toEqual(['next-candidate']);
    rt.dispose();
  });

  it('notifies connection state subscribers when socket connects', () => {
    const rt = new SessionRuntime(makeConfig());
    const states: string[] = [];
    const unsub = rt.subscribeConnectionState((s) => states.push(s));
    expect(rt.getAgentTerminalApi()).not.toBeNull();
    unsub();
    rt.dispose();
  });

  it('emits transport-exhausted for manual route disconnect', () => {
    const rt = new SessionRuntime(makeConfig({ manualOverride: 'ws://manual/ws' }));
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    expect(rt.onCandidateDisconnected()).toBe('transport-exhausted');
    expect(rt.attachState.phase).toBe('failed');
    expect(events).toEqual(['transport-exhausted']);
    rt.dispose();
  });

  it('clears client when attachInfo becomes unavailable', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.updateContext({ attachInfo: null });
    expect(rt.getAgentTerminalApi()).toBeNull();
    rt.dispose();
  });

  it('returns mirror snapshot from updateContext', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    const snapshot = rt.updateContext({ routeIntentEpoch: 1 });
    expect(snapshot.phase).toBe('connecting');
    expect(snapshot.transportGeneration).toBeGreaterThan(0);
    rt.dispose();
  });

  it('publishes a cached session snapshot for React external stores', () => {
    const rt = new SessionRuntime(makeConfig());
    const changes = vi.fn();
    const unsubscribe = rt.subscribe(changes);

    expect(rt.getSnapshot().activeUrl).toBe('ws://a/ws');
    rt.setTransportReady(true);
    rt.updateViewportSize({ cols: 120, rows: 40 });

    expect(changes).toHaveBeenCalledTimes(2);
    expect(rt.getSnapshot()).toMatchObject({
      transportReady: true,
      lastResize: { cols: 120, rows: 40 },
    });
    unsubscribe();
    rt.dispose();
  });

  it('leaves the published snapshot untouched when the context does not change', () => {
    const rt = new SessionRuntime(makeConfig());
    const published = rt.getSnapshot();
    const changes = vi.fn();
    const unsubscribe = rt.subscribe(changes);

    // Callers rebuild the context object on every render, so a value-equal
    // update has to be a no-op. Notifying here re-renders the external-store
    // subscriber, whose next render rebuilds the context again — the loop that
    // any extra render source above the terminal used to fall into.
    rt.updateContext({ forcedRelay: false });
    rt.updateContext({});
    // The plan arrives as a fresh array whenever the memo recomputes
    // (`attachInfo` is itself rebuilt per attach reply), so the same contents
    // in a new array must also be a no-op: no republish, no second socket.
    rt.updateContext({ addressUrls: ['ws://a/ws', 'ws://b/ws'] });

    expect(rt.getSnapshot()).toBe(published);
    expect(changes).not.toHaveBeenCalled();
    expect(wsInstances).toHaveLength(1);

    unsubscribe();
    rt.dispose();
  });

  it('still publishes when the context actually changes', () => {
    const rt = new SessionRuntime(makeConfig());
    const changes = vi.fn();
    const unsubscribe = rt.subscribe(changes);

    // forcedRelay flips the transport identity the snapshot publishes, so the
    // subscriber must hear about it.
    rt.updateContext({ forcedRelay: true });

    expect(changes).toHaveBeenCalledTimes(1);
    expect(rt.getSnapshot().activeUrl).toBeNull();

    unsubscribe();
    rt.dispose();
  });

  it('opens one socket when route changes with same URL (configure + forceReconnect)', async () => {
    let openCount = 0;
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        openCount += 1;
      }
    });

    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    const before = openCount;
    rt.updateContext({ routeIntentEpoch: 1 });
    expect(openCount - before).toBe(1);
    rt.dispose();
  });

  it('applies forceRelay internally without React subscriber', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
    expect(rt.getAgentTerminalApi()).toBeNull();
    rt.dispose();
  });




  describe('relay reconnect across intra-budget server-ws loss', () => {
    it('starts relay when the viewport is already ready before session lifecycle effects run', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({
        forcedRelay: true,
        serverConnection,
      }));

      rt.setTransportReady(true);
      await flushMicrotasks();

      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });

    it('re-begins exactly once across connected -> connecting -> connected (recoverable loss cycle)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ forcedRelay: true, serverConnection }));
      rt.setTransportReady(true);

      // Construction selected the session (#1309 SC-01), and the viewport's
      // ready push completed the attach — no React driver exists.
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');

      // Recoverable loss: state leaves 'connected' for 'connecting' (intra-budget
      // drop — the new transport surfaces it distinctly from 'disconnected').
      serverConnection.emit('connecting');
      expect(rt.attachState.phase).toBe('reconnecting');
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);

      // Post-handshake 'connected' (old 'authenticated') handoff re-drives relay.
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
      expect(rt.attachState.phase).toBe('attached');

      // A full second loss cycle re-begins once more.
      serverConnection.emit('connecting');
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(3);
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });

    it('ignores repeated connecting while already reconnecting (no double TRANSPORT_LOST)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ forcedRelay: true, serverConnection }));
      rt.setTransportReady(true);

      // Construction selected the session (#1309 SC-01) and the ready push
      // completed the attach.
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');

      const events: string[] = [];
      rt.subscribeRuntimeEvents((e) => events.push(e.type));
      serverConnection.emit('connecting');
      serverConnection.emit('connecting');
      expect(rt.attachState.phase).toBe('reconnecting');
      expect(events.filter((t) => t === 'route-intent-changed')).toHaveLength(1);

      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
      rt.dispose();
    });
  });

  describe('atomic P2P -> relay fallback (runtime-owned beginRelay)', () => {
    it('attach-error fallback begins relay immediately when the server ws is already connected', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await flushMicrotasks();
      // P2P transport active — no relay attach yet.
      expect(serverConnection.beginRelay).not.toHaveBeenCalled();
      expect(rt.attachState.phase).toBe('connecting');

      rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');
      expect(rt.activeUrl).toBeNull();
      expect(rt.getAgentTerminalApi()).toBeNull();
      rt.dispose();
    });

    it('defers beginRelay while the server ws is not ready, then begins exactly once on connected', async () => {
      const serverConnection = makeRelayServerConnection('connecting');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
      await flushMicrotasks();
      expect(serverConnection.beginRelay).not.toHaveBeenCalled();
      expect(rt.attachState.phase).toBe('connecting');

      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');

      // A second connected (no loss in between) must not re-begin.
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      rt.dispose();
    });

    it('candidate/address exhaustion routes through applyForceRelay (single force-relay event, p2p torn down)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      const events: string[] = [];
      rt.subscribeRuntimeEvents((e) => events.push(e.type));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      expect(rt.onCandidateDisconnected()).toBe('force-relay');
      await flushMicrotasks();

      expect(events.filter((t) => t === 'force-relay')).toHaveLength(1);
      expect(rt.activeUrl).toBeNull();
      expect(rt.getAgentTerminalApi()).toBeNull();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });
  });


  describe('relay fallback ownership (#1309 SC-02)', () => {
    /** Drive a default (two-candidate) runtime into its relay fallback. */
    function forceRelayNow(rt: InstanceType<typeof SessionRuntime>): void {
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      expect(rt.onCandidateDisconnected()).toBe('force-relay');
      expect(rt.getSnapshot().forcedRelay).toBe(true);
    }

    it('a steady-state config sync does not clobber the runtime-owned fallback', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      forceRelayNow(rt);
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');

      // The config channel carries the static intent only — `false` here is
      // what used to tear the fallback down on every registry.update.
      rt.updateContext({ sessionName: 's1', forcedRelay: false });
      expect(rt.getSnapshot().forcedRelay).toBe(true);
      expect(rt.attachState.phase).toBe('attached');
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);

      // And a re-allocated plan of equal contents — what a recomputed memo
      // sends — is the same statement: it is compared by content, so it must
      // not clear the fallback either (#1430), or every re-render would retry
      // P2P and flap back into the relay it just left.
      const socketsBefore = wsInstances.length;
      rt.updateContext({ addressUrls: ['ws://a/ws', 'ws://b/ws'] });
      expect(rt.getSnapshot().forcedRelay).toBe(true);
      expect(rt.activeUrl).toBeNull();
      expect(wsInstances).toHaveLength(socketsBefore);
      rt.dispose();
    });

    it('a route intent change clears the fallback and rebuilds P2P', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      forceRelayNow(rt);
      await flushMicrotasks();
      const wsBefore = wsInstances.length;

      rt.updateContext({ routeIntentEpoch: 1, manualOverride: 'ws://a/ws' });
      expect(rt.getSnapshot().forcedRelay).toBe(false);
      expect(rt.activeUrl).toBe('ws://a/ws');
      expect(wsInstances.length).toBeGreaterThan(wsBefore);
      rt.dispose();
    });

    it('a fresh address plan clears the fallback (the probe verdict it was based on is stale)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      forceRelayNow(rt);
      await flushMicrotasks();
      const wsBefore = wsInstances.length;

      rt.updateContext({
        orderedUrls: ['ws://c/ws'],
        addressUrls: ['ws://c/ws'],
      });
      expect(rt.getSnapshot().forcedRelay).toBe(false);
      expect(rt.activeUrl).toBe('ws://c/ws');
      expect(wsInstances.length).toBeGreaterThan(wsBefore);
      rt.dispose();
    });
  });


  describe('dispose ends the relay (#1309 SC-08)', () => {
    it('ends the server-side relay with the runtime that began it', () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection, forcedRelay: true }));
      rt.dispose();
      expect(serverConnection.endRelay).toHaveBeenCalledTimes(1);
      expect(serverConnection.endRelay).toHaveBeenCalledWith('agent:s1');
    });

    it('ends the relay after a dynamic fallback, not only a static relay intent', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      expect(rt.onCandidateDisconnected()).toBe('force-relay');
      await flushMicrotasks();
      rt.dispose();
      expect(serverConnection.endRelay).toHaveBeenCalledTimes(1);
    });

    it('does not end a relay the runtime never used', () => {
      const serverConnection = makeRelayServerConnection('connected');
      // P2P intent, no fallback: the relay handle was retained for a possible
      // fallback but nothing was ever begun on it.
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.dispose();
      expect(serverConnection.endRelay).not.toHaveBeenCalled();
    });

    it('does not end relay against a server connection that is not ready', () => {
      const serverConnection = makeRelayServerConnection('disconnected');
      const rt = new SessionRuntime(makeConfig({ serverConnection, forcedRelay: true }));
      rt.dispose();
      expect(serverConnection.endRelay).not.toHaveBeenCalled();
    });
  });


  describe('self-driving attach retry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('asks the agent for a bootstrap only when its Terminal says it has no history (#321)', async () => {
      const empty = new SessionRuntime(makeConfig({
        hasSessionOutput: () => false,
      }));
      empty.setTransportReady(true);
      empty.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      expect(clientAttachBootstrapFlags()).toEqual([true]);
      empty.dispose();

      wsInstances = [];
      const holding = new SessionRuntime(makeConfig({
        hasSessionOutput: () => true,
      }));
      holding.setTransportReady(true);
      holding.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      // `false`, not absent: this client *has* an opinion, and its opinion is
      // that re-sending the history would duplicate what is already on screen.
      expect(clientAttachBootstrapFlags()).toEqual([false]);
      holding.dispose();
    });

    it('asks for a bootstrap when no Terminal reader is wired at all', async () => {
      // The safe direction for a consumer with no Terminal to ask — the CLI's
      // own attach makes the same choice for the same reason, and the
      // alternative silently withholds history from whoever needed it.
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      expect(clientAttachBootstrapFlags()).toEqual([true]);
      rt.dispose();
    });

    it('asks for a bootstrap after the stream itself reports a hole (#1304)', async () => {
      // The second road to "my buffer is incomplete". A replay answer whose
      // window has passed this client's cursor leaves a Terminal that is
      // non-empty and wrong — `hasSessionOutput()` still says `true`, and
      // asking only that is what would carry the hole into the next session of
      // this buffer's life. The repair is the same snapshot a transport loss
      // asks for, which is why it is the same flag.
      //
      // No ack is sent for this attach — `openWs()` only opens the socket — so
      // the runtime never reaches `attached` here, and it is the *first
      // attach timing out* that drives the second `client.attach` (the same
      // setup the sibling timeout test asserts as `phase === 'connecting'`).
      // What this pins is the part that holds on that path too: a flag set
      // between two attempts reaches the next request. The production shape —
      // attached, then truncated, then a later attach — is the test below.
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig({
        hasSessionOutput: () => true,
      }));
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      // Attached, holding output, nothing lost yet: no history requested.
      expect(clientAttachBootstrapFlags()).toEqual([false]);

      rt.noteStreamTruncated();
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();

      expect(clientAttachBootstrapFlags()).toEqual([false, true]);
      rt.dispose();
      vi.useRealTimers();
    });

    it('holds the stream\'s hole across the next attach, and clears it once repaired (#1304)', async () => {
      // The production shape the test above cannot reach: a runtime that is
      // *attached* when the stream reports a hole, and stays attached — the
      // repair is deferred to the next attach by design (a snapshot cannot be
      // asked for on a live transport), so the flag has to survive the whole
      // interval between the two. A route switch stands in for that interval:
      // a fresh transport for the same session, and no loss, so nothing but
      // the truncation is setting the flag.
      const rt = new SessionRuntime(makeConfig({
        hasSessionOutput: () => true,
      }));
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();

      // Attached, holding output, nothing lost: no history requested.
      expect(rt.attachState.phase).toBe('attached');
      expect(clientAttachBootstrapFlags()).toEqual([false]);

      rt.noteStreamTruncated();

      rt.updateContext({ routeIntentEpoch: 1 });
      await openWs();
      await flushMicrotasks();

      // The hole is still there, and this attach is where the repair is asked
      // for: `hasSessionOutput()` still says `true`, and only the flag the
      // stream set can say the buffer is incomplete rather than non-empty.
      expect(clientAttachBootstrapFlags()).toEqual([false, true]);

      // This attach's bootstrap repairs the buffer, which is what clears the
      // flag. The clear is unobservable from the attach that performs it —
      // only from one that follows, and only because that one must *not* ask.
      answerAttach();
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');

      rt.updateContext({ routeIntentEpoch: 2 });
      await openWs();
      await flushMicrotasks();

      expect(clientAttachBootstrapFlags()).toEqual([false, true, false]);
      rt.dispose();
    });

    it('re-sends client.attach automatically after each attach timeout until the budget is exhausted (auto route)', async () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      expect(rt.attachState.phase).toBe('connecting');
      expect(countClientAttach()).toBe(1);

      // No React/manual re-invocation — each timeout must schedule the next
      // attach itself. The timeout now flows router timer → request rejection →
      // feature mapping → controller resolution, so flush microtasks after each
      // advance before the next attach can be counted.
      for (let i = 0; i < P2P_MAX_RECONNECT; i += 1) {
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
        await flushMicrotasks();
        expect(countClientAttach()).toBe(i + 2);
      }
      // Budget exhausted on the auto route: force-relay, P2P client torn down, no further attach.
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      expect(rt.attachState.phase).toBe('connecting');
      expect(rt.getAgentTerminalApi()).toBeNull();
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS * 2);
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      rt.dispose();
    });

    it('stops retrying with failed on a manual route after the budget is exhausted', async () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig({ manualOverride: 'ws://a/ws' }));
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      expect(countClientAttach()).toBe(1);

      for (let i = 0; i < P2P_MAX_RECONNECT; i += 1) {
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
        await flushMicrotasks();
      }
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('failed');
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS * 2);
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      rt.dispose();
    });

    it('updateContext churn during an in-flight attach neither cancels nor duplicates the attempt', async () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      expect(countClientAttach()).toBe(1);

      rt.updateContext({ sessionName: 's1' });
      rt.updateContext({});
      expect(countClientAttach()).toBe(1);

      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();
      expect(countClientAttach()).toBe(2);
      expect(rt.attachState.reconnectCount).toBe(1);
      rt.dispose();
    });
  });

  it('re-begins relay after server websocket reconnect', async () => {
    const serverConnection = makeRelayServerConnection('connected');
    const rt = new SessionRuntime(makeConfig({
      forcedRelay: true,
      serverConnection,
    }));

    // Relay attach needs no React driver (#1309 SC-01/02): construction
    // selects the session, and the viewport's ready report — a direct push,
    // not a config round-trip — lets the already-connected server WS begin.
    rt.setTransportReady(true);
    await flushMicrotasks();
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
    expect(rt.attachState.phase).toBe('attached');

    serverConnection.emit('disconnected');
    expect(rt.attachState.phase).toBe('reconnecting');
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);

    serverConnection.emit('connected');
    await flushMicrotasks();
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
    expect(rt.attachState.phase).toBe('attached');
    rt.dispose();
  });

  /**
   * A peer that goes silent leaves the browser socket *open*: no `close`, so
   * `WebSocketService`'s loss path never runs, `connectionState` stays
   * `'connected'`, and keystrokes are written into a socket nothing is reading
   * — with no error and nothing on screen (#1233). The liveness probe is the
   * only thing that can notice, so these tests are about it noticing, and about
   * it not firing when the peer is fine.
   */
  describe('P2P liveness probe (#1233)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('declares the transport lost when the agent stops answering', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');
      expect(rt.connectionState).toBe('connected');
      const socketsBefore = wsInstances.length;

      // Nothing answers: the probe fires, its request times out, and the
      // transport is declared gone. Deliberately a generous span rather than
      // `interval + timeout` — a test that restates the probe's constants would
      // break when they change for good reasons, and the claim here is only
      // "within a minute of a peer going silent, the user stops being lied to".
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();

      expect(countPings()).toBeGreaterThan(0);
      // Stated as the thing only the loss path does — it tears the socket down
      // and dials a replacement — rather than as a specific later state, since
      // by the time the timer span elapses the reconnect has already moved on
      // from `'reconnecting'`. Asserting the state *after* would be asserting
      // whichever phase the recovery happened to be in.
      expect(wsInstances.length).toBeGreaterThan(socketsBefore);
      expect(rt.connectionState).not.toBe('connected');
      expect(rt.attachState.phase).not.toBe('attached');
      rt.dispose();
    });

    it('leaves a healthy transport alone when the agent answers', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();

      // Answer every probe as it arrives, for well past several intervals.
      for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
        answerPings();
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();

      // The mutation this pins is treating "a ping was sent" as the signal.
      // A fire-and-forget probe would report `attached` here too, and the
      // assertion above would still pass — this one is what separates them.
      expect(countPings()).toBeGreaterThan(0);
      expect(rt.connectionState).toBe('connected');
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });

    it('foreground probes an attached healthy P2P peer without waiting for the interval (#1213)', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');
      const socketsBefore = wsInstances.length;
      const pingsBefore = countPings();

      rt.resumeOnForeground();
      rt.resumeOnForeground();
      await flushMicrotasks();
      expect(countPings()).toBe(pingsBefore + 1);
      answerPings();
      await flushMicrotasks();
      expect(wsInstances.length).toBe(socketsBefore);
      expect(rt.connectionState).toBe('connected');
      rt.dispose();
    });

    it('questions the link as soon as input is sent (#1264)', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');
      const before = countPings();

      // Deliberately **no** timer advance: the claim is that input asks now,
      // not that the probe happens to fire soon. Advancing would let the
      // interval probe answer and this would pass without the input path.
      rt.probeLivenessNow();
      await flushMicrotasks();

      expect(countPings()).toBe(before + 1);
      rt.dispose();
    });

    it('does not stack probes while the user keeps typing (#1264)', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();
      const before = countPings();

      // Typing is continuous; one answer at a time settles the question, and a
      // probe per keystroke would stack deadlines on the same socket.
      rt.probeLivenessNow();
      rt.probeLivenessNow();
      rt.probeLivenessNow();
      await flushMicrotasks();

      expect(countPings()).toBe(before + 1);
      rt.dispose();
    });

    it('ignores an input-triggered probe before the session is attached (#1264)', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      const before = countPings();

      // An unattached transport is already driven by the attach retry budget;
      // probing underneath it would race a mechanism that is mid-recovery —
      // the same reason the interval probe skips this phase.
      rt.probeLivenessNow();
      await flushMicrotasks();

      expect(countPings()).toBe(before);
      rt.dispose();
    });

    it('prefers retained P2P replay after transport loss when Terminal has output (#1213 SC-10)', async () => {
      const rt = new SessionRuntime(makeConfig({
        hasSessionOutput: () => true,
      }));
      rt.setTransportReady(true);
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerPending('agent.attach', 'ok', { stream_epoch: 1, stream_cursor: 2 });
      await flushMicrotasks();

      // Attached, Terminal non-empty, nothing lost: no history requested. The
      // fix must add nothing to the ordinary path.
      expect(clientAttachBootstrapFlags()).toEqual([false]);

      // The peer goes silent and the probe declares the transport lost — the
      // only thing that tells this client its buffer is suspect.
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();

      // The shared Session-scoped Agent stream (#1619) can keep recording
      // while another P2P observer remains connected. Reconnecting with a
      // nonempty local buffer must first replay from its applied cursor, not
      // immediately replace the buffer with a tmux snapshot. A confirmed
      // retention miss still calls noteStreamTruncated and requests bootstrap
      // on the following attach.
      await openWs();
      await flushMicrotasks();

      const flags = clientAttachBootstrapFlags();
      expect(flags.length).toBeGreaterThan(1);
      expect(flags[flags.length - 1]).toBe(false);

      rt.dispose();
    });

    // The flag being *cleared* on a successful attach used to be listed here
    // as uncovered — an assertion that could not fail, since this harness had
    // no way to start a second attach. It is covered now, by the route-switch
    // sequence in `holds the stream's hole across the next attach, and clears
    // it once repaired (#1304)` above: the third attach there is one that
    // follows a repair and must not ask. Not separately asserted: the same
    // clear on a loss-driven re-attach — the line is the same one, and it now
    // has a failing mutation behind it.

    // NOTE: there is deliberately no "stops probing once disposed" test here.
    // One was written and then deleted: removing `stopLivenessProbe()` from
    // `teardownConnectionHandler` — the mutation it was meant to catch — left
    // all 32 tests green, because two other guards already cover it (`dispose()`
    // nulls the agent api, and the tick returns early unless the phase is
    // 'attached'). A test that cannot fail is worse than no test: it is the
    // artefact a reviewer stops looking at.
  });

  describe('stale resolutions from an old generation (#1309 SC-10)', () => {
    it('a route change strands the in-flight attach: its disposal rejection is no spurious timeout', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.subscribeTransportSwap(() => {
        rt.buildTransport();
      });
      rt.buildTransport();
      // Construction selected the session; connecting starts the first attach.
      await openWs();
      await flushMicrotasks();
      expect(countClientAttach()).toBe(1);
      expect(rt.attachState.phase).toBe('connecting');

      const outcomes: AttachTransitionResult[] = [];
      rt.subscribeAttachOutcomes((r) => outcomes.push(r));

      // The route intent changes mid-attach. The teardown cancels the
      // in-flight request synchronously (epoch bump, in both
      // handleRouteIntentChange and the socket rebuild), so the disposal's
      // rejection of the pending client.attach — which settles a microtask
      // later — is a no-op. The mutation this pins is dropping those
      // cancels, which turns the rejection into a spurious ATTACH_TIMEOUT
      // that burns a reconnect-budget attempt on a route the user just
      // switched away from.
      rt.updateContext({ routeIntentEpoch: 1 });
      await flushMicrotasks();

      expect(rt.currentTransportGeneration).toBe(1);
      // The phase is the NEW selection's, the budget is untouched, and no
      // retry/force-relay outcome escaped the stranded attach.
      expect(rt.attachState.phase).toBe('connecting');
      expect(rt.attachState.reconnectCount).toBe(0);
      expect(outcomes.some((r) => r.retryAttach || r.forceRelay)).toBe(false);

      // The new generation's own attach proceeds untouched by the wreckage.
      await openWs();
      await flushMicrotasks();
      expect(countClientAttach()).toBe(2);
      answerPending('agent.attach', 'ok', { stream_epoch: 1, stream_cursor: 2 });
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');
      expect(lastTransport().seedStreamCursor).toHaveBeenCalledWith(1, 2, { preserveAppliedCursor: false });
      rt.dispose();
    });

    it('a probe left in flight by a transport swap cannot declare the replacement dead', async () => {
      const unresponsive = vi.spyOn(WebSocketService.prototype, 'reportUnresponsive');
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      await openWs();
      await flushMicrotasks();
      answerAttach();
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');

      // Input asks "is the link alive" — the question is now outstanding on
      // the first socket, with a deadline that has not elapsed.
      rt.probeLivenessNow();
      await flushMicrotasks();
      expect(countPings()).toBe(1);

      // The transport moves on before the answer comes back: candidate
      // rotation disposes the socket, which rejects the in-flight ping late.
      // That rejection belongs to the generation already being replaced;
      // acting on it would schedule a reconnect on top of the rotation (the
      // mutation this pins is deleting the probe-token guard).
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      await flushMicrotasks();

      expect(rt.currentTransportGeneration).toBe(1);
      expect(unresponsive).not.toHaveBeenCalled();
      rt.dispose();
    });
  });

  describe('transport binding (#1309)', () => {
    it('posts the swap only after the new generation is installed (SC-04)', () => {
      const rt = new SessionRuntime(makeConfig());
      const oldApi = rt.getAgentTerminalApi();
      const oldGeneration = rt.currentTransportGeneration;
      expect(oldApi).not.toBeNull();

      const seen: Array<{ api: unknown; boundApi: unknown; generation: number }> = [];
      rt.subscribeTransportSwap(() => {
        seen.push({
          api: rt.getAgentTerminalApi(),
          boundApi: (rt.buildTransport() as MockTransport).builtWith.agentApi,
          generation: rt.currentTransportGeneration,
        });
      });

      expect(rt.onCandidateDisconnected()).toBe('next-candidate');

      expect(seen).toHaveLength(1);
      // Everything read inside the notification is already the new
      // generation's: a binding rebuilt here binds the new agent api and
      // cannot capture the disposed socket's — #668's race closed by
      // construction, not by React effect ordering.
      expect(seen[0].api).not.toBeNull();
      expect(seen[0].api).not.toBe(oldApi);
      expect(seen[0].boundApi).toBe(seen[0].api);
      expect(seen[0].generation).toBe(oldGeneration + 1);
      rt.dispose();
    });

    it('posts the swap on both directions of the P2P ↔ relay flip', () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      const p2pApi = rt.getAgentTerminalApi();

      const builds: ConnectionOptions[] = [];
      rt.subscribeTransportSwap(() => {
        builds.push((rt.buildTransport() as MockTransport).builtWith);
      });

      rt.updateContext({ forcedRelay: true });
      expect(builds).toHaveLength(1);
      expect(builds[0].mode).toBe('relay');
      expect(builds[0].agentApi).toBeUndefined();
      expect(builds[0].serverConnection).toBe(serverConnection);

      rt.updateContext({ forcedRelay: false });
      expect(builds).toHaveLength(2);
      expect(builds[1].mode).toBe('p2p');
      // The P2P rebuild binds a fresh agent api — never the disposed one.
      expect(builds[1].agentApi).not.toBeUndefined();
      expect(builds[1].agentApi).not.toBe(p2pApi);
      expect(builds[1].agentApi).toBe(rt.getAgentTerminalApi());
      rt.dispose();
    });

    it('does not post a swap for a context echo that keeps the live socket', () => {
      const rt = new SessionRuntime(makeConfig());
      const swaps = vi.fn();
      rt.subscribeTransportSwap(swaps);

      // The product layer rebuilds the context object on every render; only an
      // identity change may rewire a binding — otherwise every render would
      // churn transports.
      rt.updateContext({});
      expect(swaps).not.toHaveBeenCalled();
      rt.dispose();
    });

    it('applies the attach seed to the live transport in reconcile → flush → seed order (#1094, #1307)', async () => {
      const rt = new SessionRuntime(makeConfig());
      rt.setTransportReady(true);
      rt.buildTransport();
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();

      answerPending('agent.attach', 'ok', {
        stream_epoch: 7,
        stream_cursor: 42,
        input_epoch: 3,
        input_applied_through: 11,
        control_generation: 2,
      });
      await flushMicrotasks();

      expect(rt.attachState.phase).toBe('attached');
      const transport = lastTransport();
      // The reply's snake_case wire fields land on the binding as one seed.
      expect(transport.seedInputCursor).toHaveBeenCalledWith({
        inputEpoch: 3,
        appliedThrough: 11,
        controlGeneration: 2,
      });
      expect(transport.seedStreamCursor).toHaveBeenCalledWith(7, 42, { preserveAppliedCursor: false });
      expect(transport.flushAllOutbound).toHaveBeenCalledTimes(1);
      // In the order the handoff requires: the input cursor is reconciled
      // BEFORE the flush (the flush is numbered against it), the stream cursor
      // is seeded AFTER it.
      const inputOrder = transport.seedInputCursor.mock.invocationCallOrder[0];
      const flushOrder = transport.flushAllOutbound.mock.invocationCallOrder[0];
      const streamOrder = transport.seedStreamCursor.mock.invocationCallOrder[0];
      expect(inputOrder).toBeLessThan(flushOrder);
      expect(flushOrder).toBeLessThan(streamOrder);
      rt.dispose();
    });

    it('retires the P2P seed with its transport — a relay attach applies no P2P cursors', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ serverConnection }));
      rt.setTransportReady(true);
      rt.buildTransport();
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await openWs();
      await flushMicrotasks();
      answerPending('agent.attach', 'ok', { stream_epoch: 7, stream_cursor: 42 });
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');
      // Sanity: the P2P binding took the seed this test is about to strand.
      expect(lastTransport().seedStreamCursor).toHaveBeenCalledWith(7, 42, { preserveAppliedCursor: false });

      // The controller's half of a swap: rebuild the binding on the new
      // identity. Subscribed now so it sees every swap below.
      rt.subscribeTransportSwap(() => {
        rt.buildTransport();
      });
      // First candidate drops: the replacement socket reports 'connecting',
      // which the connection handler surfaces as TRANSPORT_LOST — dispatched
      // directly here, since this harness drives the policy step synchronously.
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      rt.attachController.dispatch({ type: 'TRANSPORT_LOST' });
      // Second candidate drops: relay takes over.
      expect(rt.onCandidateDisconnected()).toBe('force-relay');
      await flushMicrotasks();

      expect(rt.attachState.phase).toBe('attached');
      const relayTransport = lastTransport();
      expect(relayTransport.builtWith.mode).toBe('relay');
      // Buffered output still drains — but cursors a different transport
      // stated must not land on this one.
      expect(relayTransport.flushAllOutbound).toHaveBeenCalledTimes(1);
      expect(relayTransport.seedInputCursor).not.toHaveBeenCalled();
      expect(relayTransport.seedStreamCursor).not.toHaveBeenCalled();
      rt.dispose();
    });
  });
});
