import { MessageRouterImpl } from './MessageRouter';
import {
  DEFAULT_RECONNECT_BASE_DELAY,
  reconnectDelayMs,
} from './agentSocketUtils';
import type { ConnectionState, RequestOptions, SocketClient, SocketMessage } from './types';

export interface SocketCoreConfig {
  url: string;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  handshake?: (core: SocketCore) => Promise<void>;
  onError?: (error: Error) => void;
  connectionLostMessage?: string;
}

type ConnectionWaiter = { resolve: () => void; reject: (error: Error) => void };

/**
 * The single browser WebSocket lifecycle implementation.
 *
 * Domain clients (server facade and agent facade) configure the endpoint and,
 * when needed, provide a post-open handshake. Message routing and request
 * correlation stay in this class for every WebSocket in the application.
 */
export class SocketCore implements SocketClient {
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private userClosed = false;
  private disposed = false;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly messageListeners = new Set<(message: SocketMessage) => void>();
  private readonly waiters = new Set<ConnectionWaiter>();
  private idCounter = 0;
  private readonly router: MessageRouterImpl;

  constructor(private config: SocketCoreConfig) {
    this.router = new MessageRouterImpl({
      send: (message) => this.send(message),
      generateId: () => this.generateMessageId(),
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get reconnectAttempts(): number {
    return this.reconnectAttempt;
  }

  /** Compatibility setter for server-core tests and diagnostics. */
  set reconnectAttempts(value: number) {
    this.reconnectAttempt = Math.max(0, value);
  }

  getUrl(): string {
    return this.config.url;
  }

  connect(): Promise<void> {
    if (this.disposed || this.userClosed) {
      return Promise.reject(new Error('SocketCore is closed'));
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.state === 'connected') {
      return Promise.resolve();
    }

    this.setState('connecting');
    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.openSocket(resolve, reject);
      } catch (error) {
        this.connectPromise = null;
        this.setState('disconnected');
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.connectPromise = null;
    const error = new Error(this.config.connectionLostMessage ?? 'Connection lost');
    this.router.failPending(error);
    this.rejectWaiters(error);
    this.setState('disconnected');
  }

  close(): void {
    this.disconnect();
  }

  reconnectNow(): void {
    if (this.disposed) {
      return;
    }
    this.userClosed = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.connectPromise = null;
    this.router.failPending(new Error('Connection reset'));
    this.setState('connecting');
    void this.connect().catch(() => {});
  }

  configure(next: Partial<SocketCoreConfig>): boolean {
    const urlChanged = next.url !== undefined && next.url !== this.config.url;
    this.config = { ...this.config, ...next };
    if (!urlChanged) {
      return false;
    }

    this.userClosed = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.connectPromise = null;
    this.router.failPending(new Error('Connection endpoint changed'));
    this.rejectWaiters(new Error('Connection lost'));
    this.setState('connecting');
    void this.connect().catch(() => {});
    return true;
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('SocketCore disposed'));
    }
    const timeoutMs = options?.timeoutMs ?? 15_000;
    if (this.state === 'connected') {
      return this.router.request<T>(type, payload, { timeoutMs });
    }
    if (this.state === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }

    const startedAt = Date.now();
    return this.waitForConnection(timeoutMs).then(() => {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return Promise.reject(new Error(`Request timeout: ${type}`));
      }
      return this.router.request<T>(type, payload, { timeoutMs: remaining });
    });
  }

  send(message: SocketMessage): void {
    if (this.disposed) {
      throw new Error('SocketCore disposed');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    return this.router.subscribe(type, handler);
  }

  failPending(error: Error): void {
    this.router.failPending(error);
  }

  waitForConnection(timeoutMs = 15_000): Promise<void> {
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

  /** Raw message tap for domain adapters that need response metadata. */
  onMessage(handler: (message: SocketMessage) => void): () => void {
    this.messageListeners.add(handler);
    return () => this.messageListeners.delete(handler);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    return this.router.onBinary(handler);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.connectPromise = null;
    this.router.dispose();
    this.rejectWaiters(new Error('SocketCore disposed'));
    this.stateListeners.clear();
    this.messageListeners.clear();
  }

  private openSocket(resolve: () => void, reject: (error: Error) => void): void {
    const myGeneration = ++this.generation;
    const ws = new WebSocket(this.config.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (this.generation !== myGeneration) {
        ws.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.setState('connected');
      const handshake = this.config.handshake?.(this);
      if (!handshake) {
        this.connectPromise = null;
        resolve();
        return;
      }
      handshake.then(() => {
        if (this.generation !== myGeneration) {
          return;
        }
        this.connectPromise = null;
        resolve();
      }).catch((error) => {
        if (this.generation !== myGeneration) {
          return;
        }
        this.connectPromise = null;
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
          for (const listener of this.messageListeners) {
            try {
              listener(message);
            } catch (error) {
              this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          }
          this.router.handleIncoming(message);
        } else if (event.data instanceof ArrayBuffer) {
          this.router.handleBinary(event.data);
        }
      } catch (error) {
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.onerror = () => {
      if (this.generation === myGeneration) {
        const error = new Error('WebSocket connection failed');
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(error);
          this.teardownSocket();
          this.router.failPending(error);
          this.rejectWaiters(error);
          this.setState('disconnected');
        } else {
          this.config.onError?.(error);
        }
      }
    };

    ws.onclose = () => {
      if (this.generation !== myGeneration || this.userClosed) {
        return;
      }
      if (this.connectPromise) {
        this.connectPromise = null;
        reject(new Error(this.config.connectionLostMessage ?? 'Connection lost'));
      }
      this.handleSocketLoss();
    };
  }

  private handleSocketLoss(): void {
    const error = new Error(this.config.connectionLostMessage ?? 'Connection lost');
    this.router.failPending(error);
    const maxAttempts = this.config.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempt >= maxAttempts) {
      console.error('Max reconnection attempts reached');
      this.setState('disconnected');
      this.rejectWaiters(new Error('Connection lost'));
      return;
    }

    this.reconnectAttempt += 1;
    this.setState('reconnecting');
    const baseDelay = this.config.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
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

  generateMessageId(): string {
    this.idCounter += 1;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `msg_${this.idCounter}_${random}`;
  }
}
