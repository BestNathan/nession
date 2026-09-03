import { MessageRouterImpl } from './MessageRouter';
import type { P2PMessage } from './p2pTypes';
import {
  buildAgentWsUrl,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY,
  reconnectDelayMs,
  type AgentSocketClientConfig,
} from './agentSocketUtils';
import type { ConnectionState, RequestOptions, SocketClient, SocketMessage } from './types';

type ConnectionWaiter = { resolve: () => void; reject: (e: Error) => void };

export class AgentSocketClient implements SocketClient {
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly waiters = new Set<ConnectionWaiter>();
  private readonly legacyHandlers = new Set<(msg: P2PMessage) => void>();
  private idCounter = 0;
  /** User-initiated close — suppress auto-reconnect until endpoint reconfigured. */
  private userClosed = false;
  private readonly router: MessageRouterImpl;

  constructor(private config: AgentSocketClientConfig) {
    this.router = new MessageRouterImpl({
      send: (msg) => this.sendJson(msg),
      generateId: () => this.generateMessageId(),
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get reconnectAttempts(): number {
    return this.reconnectAttempt;
  }

  connect(): void {
    if (this.userClosed) {
      return;
    }
    this.openSocket();
  }

  close(): void {
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.setState('disconnected');
    this.router.failPending(new Error('Connection lost'));
    this.rejectWaiters(new Error('Connection lost'));
  }

  disconnect(): void {
    this.close();
  }

  /** Re-open the current endpoint (route-intent change with unchanged URL). */
  forceReconnect(): void {
    this.userClosed = false;
    this.reconnectAttempt = 0;
    this.router.failPending(new Error('Connection lost'));
    this.clearReconnectTimer();
    this.teardownSocket();
    this.setState('connecting');
    this.openSocket();
  }

  /**
   * Update endpoint identity. Bumps generation so stale socket events are ignored
   * and opens a fresh connection (mirrors the legacy url/token reconnect semantics).
   */
  configure(next: Partial<AgentSocketClientConfig>): boolean {
    const prevUrl = this.config.agentUrl;
    const prevToken = this.config.connectionToken;
    this.config = { ...this.config, ...next };

    const urlChanged = next.agentUrl !== undefined && next.agentUrl !== prevUrl;
    const tokenChanged =
      next.connectionToken !== undefined && next.connectionToken !== prevToken;
    if (!urlChanged && !tokenChanged) {
      return false;
    }

    this.userClosed = false;
    this.reconnectAttempt = 0;
    this.router.failPending(new Error('Connection lost'));
    this.rejectWaiters(new Error('Connection lost'));
    this.clearReconnectTimer();
    this.teardownSocket();
    this.setState('connecting');
    this.openSocket();
    return true;
  }

  send(message: SocketMessage): void {
    this.router.send(message);
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    return this.router.subscribe(type, handler);
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    if (this.state === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }
    const timeoutMs = options?.timeoutMs ?? 15_000;
    if (this.state === 'connected') {
      return this.router.request<T>(type, payload, { timeoutMs });
    }
    const start = Date.now();
    return this.waitForConnection(timeoutMs).then(() => {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        return Promise.reject(new Error(`Request timeout: ${type}`));
      }
      return this.router.request<T>(type, payload, { timeoutMs: remaining });
    });
  }

  failPending(error: Error): void {
    this.router.failPending(error);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    return this.router.onBinary(handler);
  }

  /** Fan-out for legacy P2PConnection.onMessage consumers (terminal, attach). */
  onLegacyMessage(handler: (msg: P2PMessage) => void): () => void {
    this.legacyHandlers.add(handler);
    return () => {
      this.legacyHandlers.delete(handler);
    };
  }

  private dispatchLegacy(msg: P2PMessage): void {
    for (const h of this.legacyHandlers) {
      try {
        h(msg);
      } catch (e) {
        console.error('[AgentSocketClient] Legacy handler error:', e);
      }
    }
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
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
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('Connection timeout'));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  dispose(): void {
    this.userClosed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.router.dispose();
    this.stateListeners.clear();
    this.legacyHandlers.clear();
    this.rejectWaiters(new Error('Connection lost'));
  }

  private openSocket(): void {
    this.generation += 1;
    const myGeneration = this.generation;
    const wsUrl = buildAgentWsUrl(this.config.agentUrl, this.config.connectionToken);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    if (this.reconnectAttempt === 0) {
      this.setState('connecting');
    }

    ws.onopen = () => {
      if (this.generation !== myGeneration) {
        ws.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.setState('connected');
    };

    ws.onmessage = (event) => {
      if (this.generation !== myGeneration) {
        return;
      }
      try {
        if (typeof event.data === 'string') {
          const msg: P2PMessage = JSON.parse(event.data);
          this.router.handleIncoming(msg);
          this.dispatchLegacy(msg);
        } else if (event.data instanceof ArrayBuffer) {
          this.router.handleBinary(event.data);
          this.dispatchLegacy({
            msg_type: '__binary__',
            id: '',
            timestamp: 0,
            payload: event.data,
          });
        }
      } catch (err) {
        console.error('[AgentSocketClient] Message parse error:', err);
      }
    };

    ws.onerror = () => {
      if (this.generation === myGeneration && this.reconnectAttempt === 0) {
        this.config.onError?.(new Error('P2P WebSocket connection error'));
      }
    };

    ws.onclose = () => {
      if (this.generation !== myGeneration) {
        return;
      }
      if (this.userClosed) {
        return;
      }

      this.router.failPending(new Error('Connection lost'));

      const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      const attempt = this.reconnectAttempt;
      if (attempt >= maxAttempts) {
        this.setState('disconnected');
        this.rejectWaiters(new Error('Connection lost'));
        return;
      }

      this.reconnectAttempt = attempt + 1;
      this.setState('reconnecting');

      const baseDelay = this.config.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
      const delay = reconnectDelayMs(attempt, baseDelay);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.generation === myGeneration && !this.userClosed) {
          this.openSocket();
        }
      }, delay);
    };
  }

  private sendJson(message: SocketMessage): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
    } catch {
      // Socket teardown races — close handler will settle waiters.
    }
  }

  private generateMessageId(): string {
    this.idCounter += 1;
    return `agent-${Date.now()}-${this.idCounter}`;
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
      this.resolveWaiters();
    } else if (next === 'disconnected') {
      this.rejectWaiters(new Error('Connection lost'));
    }
  }

  private resolveWaiters(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const w of pending) {
      w.resolve();
    }
  }

  private rejectWaiters(error: Error): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const w of pending) {
      w.reject(error);
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
}
