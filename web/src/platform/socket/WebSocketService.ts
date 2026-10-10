import { ProtocolDirectory } from '@/platform/protocol';
import { MessageRouterImpl } from './MessageRouter';
import type {
  TransportPlugin,
  ConnectionState,
  HandshakeSurface,
  PluginSurface,
  RequestOptions,
  SocketMessage,
  WebSocketServiceOptions,
} from './types';

const MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_RECONNECT_BASE_DELAY = 1_000;
/**
 * Cadence of the long tail past `maxReconnectAttempts`, when the caller asked
 * for `persistentReconnect` (#1263).
 *
 * Matches the attach liveness probe's interval: a route that is being kept
 * alive on the user's behalf already questions a silent peer once every 15s, so
 * a manual route that keeps probing on the same cadence adds no new class of
 * background traffic.
 */
const PERSISTENT_RECONNECT_DELAY_MS = 15_000;

function reconnectDelayMs(attempt: number, baseDelay: number): number {
  return Math.min(baseDelay * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
}

// Moved to `shared/lib/agentWsUrl.ts` so `shared/lib/addressSelection.ts` can
// use it — `shared` may import nothing above it (#1091). Re-exported here
// because this module is where every existing importer looks for it.
export { buildAgentWsUrl } from '@/shared/lib/agentWsUrl';

interface RegisteredPlugin {
  plugin: TransportPlugin;
  teardown: () => void;
}

type ConnectionWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * The single WebSocket transport for the web UI.
 *
 * Lifecycle: reconnect with exponential backoff, generation guard for stale
 * socket events, request correlation via MessageRouterImpl. Three differences
 * make it the transport these plugins install on:
 *
 * 1. Readiness gate — when `options.handshake` is provided, the state stays
 *    'connecting' until the handshake succeeds; `connect()`/`waitForConnection()`
 *    only resolve post-handshake and `request()` waits behind the same gate.
 * 2. Plugin registry — `TransportPlugin`s install once per service lifetime
 *    (never on reconnect) and are torn down on `dispose()`.
 * 3. Envelope — `send(type, payload)` wraps the payload in the
 *    `SocketMessage` envelope instead of exposing raw frames.
 *
 * The handshake runs again for every physical socket (each reconnect), and is
 * given a {@link HandshakeSurface} whose `request()` bypasses the readiness
 * gate — the socket is already OPEN at that point.
 *
 * A handshake that *rejects* is a refusal, not a loss: the socket opened and
 * the peer answered it. The service settles at 'disconnected' and schedules no
 * reconnect, because replaying the same handshake would be refused again
 * (#692). The reconnect budget therefore covers only sockets lost from a live
 * connection, and is reset by each connection that actually gets established —
 * not by a socket that merely opened.
 */
export class WebSocketService implements PluginSurface {
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  /**
   * Whether the spent-budget verdict has been reported for the current loss
   * episode. Cleared by every connection that gets established, so a route that
   * comes back and fails again reports once more rather than never.
   */
  private reportedRouteExhaustion = false;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private userClosed = false;
  private disposed = false;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly waiters = new Set<ConnectionWaiter>();
  private idCounter = 0;
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly router: MessageRouterImpl;
  /**
   * What the targets reachable over *this* connection advertise (`#678`).
   *
   * Per service rather than per process: a manifest is a fact about a peer on
   * one socket, and the next connection may be to a different server whose
   * agents offer different versions. See {@link PluginSurface.protocols}.
   */
  readonly protocols = new ProtocolDirectory();

  constructor(
    private readonly url: string,
    plugins: TransportPlugin[] = [],
    private readonly options: WebSocketServiceOptions = {},
  ) {
    this.router = new MessageRouterImpl({
      send: (message) => this.sendRaw(message),
      generateId: () => this.generateMessageId(),
    });
    for (const plugin of plugins) {
      this.use(plugin);
    }
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get reconnectAttempts(): number {
    return this.reconnectAttempt;
  }

  /** Identity of the physical socket, for bounded probes and stale callbacks. */
  get physicalGeneration(): number {
    return this.generation;
  }

  /** Resume now instead of waiting for a throttled background backoff timer. */
  reconnectNow(): Promise<void> {
    if (this.state !== 'connected') {
      this.clearReconnectTimer();
    }
    return this.connect();
  }

  /** True once {@link dispose} ran — the service can never connect again. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  getUrl(): string {
    return this.url;
  }

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('WebSocketService disposed'));
    }
    if (this.userClosed) {
      return Promise.reject(new Error('WebSocketService is closed'));
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.state === 'connected') {
      return Promise.resolve();
    }

    this.setState('connecting');
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.rejectConnect = reject;
      try {
        this.openSocket(resolve, reject);
      } catch (error) {
        this.connectPromise = null;
        this.rejectConnect = null;
        this.setState('disconnected');
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.connectPromise;
  }

  /**
   * Stop the transport. This is terminal: `userClosed` is never cleared, so a
   * later `connect()` rejects with 'WebSocketService is closed' — rebuild the
   * service to connect again. Plugins stay registered (torn down only by
   * `dispose()`); an in-flight `connect()` is rejected so it cannot dangle.
   */
  disconnect(): void {
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.rejectPendingConnect(new Error('WebSocketService is closed'));
    const error = new Error('Connection lost');
    this.router.failPending(error);
    this.rejectWaiters(error);
    this.setState('disconnected');
  }

  /**
   * The peer has stopped answering on a socket the browser still reports OPEN.
   *
   * **A half-open socket fires no `close`, and that is the whole problem.**
   * `handleSocketLoss()` is the only reconnect scheduler and it is wired to
   * `onclose`, so a peer that goes silent — a replaced pod, a dropped NAT
   * mapping — leaves `state` at `'connected'` forever. Everything downstream
   * reads that state: the attach gate keeps letting input through, and
   * `sendRaw` checks only `readyState`, which is still 1, so keystrokes are
   * written into the void with no error and no UI signal (#1233).
   *
   * Called by the liveness probe layered above this class; this method makes no
   * judgement about liveness itself (see `web/CLAUDE.md` §2 — the transport is
   * shared by the relay singleton and every P2P service, so probing belongs to
   * the caller that knows what it is talking to).
   *
   * Deliberately routed through the ordinary loss path rather than a private
   * shortcut: reconnect budget, candidate rotation and force-relay all key off
   * the state transition this produces, so they apply unchanged.
   */
  reportUnresponsive(expectedGeneration?: number): void {
    if (this.disposed || this.userClosed || this.state !== 'connected'
      || (expectedGeneration !== undefined && expectedGeneration !== this.generation)) {
      return;
    }
    // `teardownSocket()` detaches `onclose` before closing, so this cannot
    // schedule a second reconnect through the event it is about to fire.
    this.teardownSocket();
    this.handleSocketLoss();
  }

  /**
   * Permanently stop the transport: plugins are torn down (each once), an
   * in-flight `connect()` is rejected with 'WebSocketService disposed', and
   * the state ends at 'disconnected' (never left frozen mid-connect).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.rejectPendingConnect(new Error('WebSocketService disposed'));
    this.router.dispose();
    this.rejectWaiters(new Error('WebSocketService disposed'));
    this.setState('disconnected');
    for (const entry of this.plugins.values()) {
      entry.teardown();
    }
    this.plugins.clear();
    this.stateListeners.clear();
  }

  /** Install a transport plugin; a same-name plugin is replaced (old teardown first). */
  use(plugin: TransportPlugin): void {
    this.unregister(plugin.name);
    const teardown = plugin.install(this);
    this.plugins.set(plugin.name, { plugin, teardown });
  }

  /** Uninstall a plugin by name; returns false when nothing was registered. */
  unregister(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) {
      return false;
    }
    this.plugins.delete(name);
    entry.teardown();
    return true;
  }

  /**
   * Envelope-send a message. Throws 'WebSocketService disposed' when the
   * service was disposed, and 'WebSocket not connected' when the physical
   * socket is gone or not yet OPEN.
   */
  send(type: string, payload: Record<string, unknown>): void {
    if (this.disposed) {
      throw new Error('WebSocketService disposed');
    }
    this.sendRaw({
      msg_type: type,
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload,
    });
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('WebSocketService disposed'));
    }
    const timeoutMs = options?.timeoutMs ?? 15_000;
    if (this.state === 'connected') {
      // not-protocol: the pass-through; callers name the wire.
      return this.router.request<T>(type, payload, { timeoutMs });
    }
    if (this.state === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }

    // Not ready yet: wait behind the readiness gate, then send with the
    // remaining time budget.
    const startedAt = Date.now();
    return this.waitForConnection(timeoutMs).then(() => {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return Promise.reject(new Error(`Request timeout: ${type}`));
      }
      // not-protocol: the pass-through; callers name the wire.
      return this.router.request<T>(type, payload, { timeoutMs: remaining });
    });
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    return this.router.subscribe(type, handler);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    return this.router.onBinary(handler);
  }

  waitForConnection(timeoutMs = 15_000): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('WebSocketService disposed'));
    }
    if (this.state === 'connected') {
      return Promise.resolve();
    }
    if (this.state === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }

    return new Promise((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('Connection timeout'));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  private sendRaw(message: SocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  private openSocket(resolve: () => void, reject: (error: Error) => void): void {
    const myGeneration = ++this.generation;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (this.generation !== myGeneration) {
        ws.close();
        return;
      }
      const handshake = this.options.handshake;
      if (!handshake) {
        // Nothing gates readiness, so the socket *is* the connection: open is
        // established, and only here may the reconnect budget reset.
        this.reconnectAttempt = 0;
        this.reportedRouteExhaustion = false;
        this.setState('connected');
        this.connectPromise = null;
        this.rejectConnect = null;
        resolve();
        return;
      }

      // Readiness gate: stay 'connecting' until the handshake completes.
      // The surface's request() bypasses the state gate — the socket is
      // already OPEN and waiting on 'connected' would self-deadlock.
      const surface: HandshakeSurface = {
        send: (type, payload) => {
          this.router.send({
            msg_type: type,
            id: this.generateMessageId(),
            timestamp: Date.now(),
            payload,
          });
        },
        request: <T>(type: string, payload: Record<string, unknown>, options?: RequestOptions) =>
          // not-protocol: the pass-through; callers name the wire.
          this.router.request<T>(type, payload, options),
      };
      handshake(surface).then(() => {
        // The socket that ran this handshake must still be the live one.
        // The generation guard covers a superseded physical socket; the
        // readyState guard covers a loss before the reconnect timer fired.
        if (
          this.generation !== myGeneration
          || this.ws !== ws
          || ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        // Established — the handshake is what proves it, so this is the only
        // place a reconnect budget may reset. Resetting in ws.onopen instead
        // let a socket that opened but never authenticated re-arm itself on
        // every retry, so the budget never ran out (#692).
        this.reconnectAttempt = 0;
        // The route is back, so the reported exhaustion is spent too: a later
        // loss may report again.
        this.reportedRouteExhaustion = false;
        this.connectPromise = null;
        this.rejectConnect = null;
        this.setState('connected');
        resolve();
      }).catch((error) => {
        if (this.generation !== myGeneration) {
          return;
        }
        this.connectPromise = null;
        this.rejectConnect = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        // Only a refusal from a socket that is still live settles here. If the
        // socket died while the handshake was in flight, its onclose already
        // ran the loss path — retrying there is legitimate, and overriding it
        // would strand the retry timer behind a 'disconnected' state.
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          this.options.onHandshakeRejected?.(error instanceof Error ? error : new Error(String(error)));
          // The owner may dispose the service on explicit auth rejection.
          if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
            this.teardownSocket();
            this.failConnection();
          }
        }
      });
    };

    ws.onmessage = (event) => {
      if (this.generation !== myGeneration) {
        return;
      }
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as SocketMessage;
          this.router.handleIncoming(message);
        } else if (event.data instanceof ArrayBuffer) {
          this.router.handleBinary(event.data);
        }
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.onerror = () => {
      if (this.generation !== myGeneration) {
        return;
      }
      const error = new Error('WebSocket connection failed');
      if (this.connectPromise) {
        this.connectPromise = null;
        this.rejectConnect = null;
        reject(error);
        // An initial dial error is terminal until the user explicitly retries.
        // An error on an *already scheduled reconnect*, however, is another
        // failed transport attempt. Without the same loss path as onclose, an
        // offline browser's onerror can silently cancel the entire backoff
        // chain before the network returns (#1213 SC-15).
        const retrying = this.reconnectAttempt > 0;
        this.teardownSocket(); // also detaches onclose: never double-count loss
        if (retrying) {
          this.handleSocketLoss();
        } else {
          this.router.failPending(error);
          this.rejectWaiters(error);
          this.setState('disconnected');
        }
      } else {
        this.options.onError?.(error);
      }
    };

    ws.onclose = () => {
      if (this.generation !== myGeneration || this.userClosed) {
        return;
      }
      if (this.connectPromise) {
        this.connectPromise = null;
        this.rejectConnect = null;
        reject(new Error('Connection lost'));
      }
      this.handleSocketLoss();
    };
  }

  /**
   * Settle a definitively failed connection: everything in flight fails the
   * way it would on a lost socket, but no reconnect is scheduled. Used when
   * the peer refused this client (a rejected handshake), where retrying the
   * same handshake can only be refused again.
   */
  private failConnection(): void {
    const error = new Error('Connection lost');
    this.router.failPending(error);
    this.setState('disconnected');
    this.rejectWaiters(error);
  }

  private handleSocketLoss(): void {
    // A stale async callback (e.g. a handshake failing after a teardown) must
    // not schedule a reconnect or flip the state once the transport stopped.
    if (this.disposed || this.userClosed) {
      return;
    }
    const error = new Error('Connection lost');
    this.router.failPending(error);
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const spent = this.reconnectAttempt >= maxAttempts;
    const persistent = this.options.persistentReconnect === true;

    if (spent && !persistent) {
      console.error('Max reconnection attempts reached');
      this.setState('disconnected');
      this.rejectWaiters(new Error('Connection lost'));
      return;
    }

    // A pinned route has nothing to rotate to, so a spent budget cannot *end*
    // the attempt: the tail below keeps probing, because the route may simply
    // be away. What it must not do is hide the verdict. Reported as
    // `reconnecting` for as long as the retries run, the caller's address
    // policy never reaches its no-candidate branch, the attach state machine
    // never reaches `failed`, and a client whose pinned route cannot complete a
    // WebSocket handshake shows a spinner over an empty terminal for as long as
    // it is left open — measured on staging as one attempt every 30 s for hours,
    // with nothing on screen saying so.
    //
    // So the exhaustion is *reported* — once per loss episode, so the tail does
    // not re-fire it — while the retries continue underneath. That is what the
    // caller reads as "this route is spent": `disconnected` is the state its
    // policy turns into `transport-exhausted`, and for a pinned route the state
    // machine already renders and recovers from it (`canStartAttach` accepts
    // `failed`, so the next successful handshake re-attaches on its own).
    // #1263 chose silence because `failed` was a one-way door then; it is not
    // one now, which is what makes reporting this safe.
    if (spent && !this.reportedRouteExhaustion) {
      this.reportedRouteExhaustion = true;
      this.setState('disconnected');
    }

    // `reconnectAttempt` stops climbing once the budget is spent, so the fast
    // phase stays bounded and the long tail runs on one flat delay — the fast
    // attempts are for an endpoint that blipped, this is for a peer that is
    // restarting or away.
    if (!spent) {
      this.reconnectAttempt += 1;
      // Only the fast phase is "reconnecting" once the verdict above is on
      // record: re-asserting it here would overwrite the report in the same
      // tick, which is the silence this exists to end (#1263).
      this.setState('reconnecting');
    }
    const baseDelay = this.options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
    const delay = spent
      ? PERSISTENT_RECONNECT_DELAY_MS
      : reconnectDelayMs(this.reconnectAttempt - 1, baseDelay);
    console.log(
      spent
        ? `Reconnect budget spent; still probing every ${delay}ms`
        : `Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && !this.userClosed) {
        void this.connect().catch(() => {});
      }
    }, delay);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
    if (next === 'connected') {
      const pending = [...this.waiters];
      this.waiters.clear();
      for (const waiter of pending) {
        waiter.resolve();
      }
    }
  }

  private rejectWaiters(error: Error): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const waiter of pending) {
      waiter.reject(error);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Reject the in-flight connect() promise, if any. disconnect()/dispose()
   * call this so a connect() still awaiting the socket open or its handshake
   * does not dangle once the transport stops — teardownSocket() nulls the
   * ws handlers that would otherwise settle it, and a handshake completing
   * after teardown trips the socket-identity guard and returns silently.
   */
  private rejectPendingConnect(error: Error): void {
    if (!this.connectPromise) {
      return;
    }
    this.connectPromise = null;
    const reject = this.rejectConnect;
    this.rejectConnect = null;
    reject?.(error);
  }

  private teardownSocket(): void {
    if (!this.ws) {
      return;
    }
    this.ws.onopen = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }

  private generateMessageId(): string {
    this.idCounter += 1;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `msg_${this.idCounter}_${random}`;
  }
}
