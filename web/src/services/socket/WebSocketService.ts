import { MessageRouterImpl } from './MessageRouter';
import type {
  CapabilityPlugin,
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

function reconnectDelayMs(attempt: number, baseDelay: number): number {
  return Math.min(baseDelay * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
}

/** Append a connection token to an agent WebSocket URL as a query parameter. */
export function buildAgentWsUrl(agentUrl: string, connectionToken?: string): string {
  if (!connectionToken) {
    return agentUrl;
  }
  return `${agentUrl}${agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(connectionToken)}`;
}

interface RegisteredPlugin {
  plugin: CapabilityPlugin;
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
 * make it the transport for capability plugins:
 *
 * 1. Readiness gate — when `options.handshake` is provided, the state stays
 *    'connecting' until the handshake succeeds; `connect()`/`waitForConnection()`
 *    only resolve post-handshake and `request()` waits behind the same gate.
 * 2. Plugin registry — `CapabilityPlugin`s install once per service lifetime
 *    (never on reconnect) and are torn down on `dispose()`.
 * 3. Envelope — `send(type, payload)` wraps the payload in the
 *    `SocketMessage` envelope instead of exposing raw frames.
 *
 * The handshake runs again for every physical socket (each reconnect), and is
 * given a {@link HandshakeSurface} whose `request()` bypasses the readiness
 * gate — the socket is already OPEN at that point.
 */
export class WebSocketService implements PluginSurface {
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
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

  constructor(
    private readonly url: string,
    plugins: CapabilityPlugin[] = [],
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

  /** Install a capability plugin; a same-name plugin is replaced (old teardown first). */
  use(plugin: CapabilityPlugin): void {
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
      this.reconnectAttempt = 0;
      const handshake = this.options.handshake;
      if (!handshake) {
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
        this.teardownSocket();
        this.handleSocketLoss();
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
        this.teardownSocket();
        this.router.failPending(error);
        this.rejectWaiters(error);
        this.setState('disconnected');
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

  private handleSocketLoss(): void {
    // A stale async callback (e.g. a handshake failing after a teardown) must
    // not schedule a reconnect or flip the state once the transport stopped.
    if (this.disposed || this.userClosed) {
      return;
    }
    const error = new Error('Connection lost');
    this.router.failPending(error);
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempt >= maxAttempts) {
      console.error('Max reconnection attempts reached');
      this.setState('disconnected');
      this.rejectWaiters(new Error('Connection lost'));
      return;
    }

    this.reconnectAttempt += 1;
    this.setState('reconnecting');
    const baseDelay = this.options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
    const delay = reconnectDelayMs(this.reconnectAttempt - 1, baseDelay);
    console.log(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
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
