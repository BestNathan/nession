/**
 * WebSocketServiceCoreImpl — core WebSocket infrastructure.
 *
 * Responsibilities:
 * - WebSocket connection lifecycle (connect, disconnect, reconnect)
 * - Client ID management (persisted in localStorage)
 * - Authentication handshake
 * - Message routing via typed handler map
 * - Request/response correlation with timeout
 *
 * Does NOT know about plugins. The facade installs plugins and passes
 * `this` (typed as WebSocketServiceCore) to each plugin's install().
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  WebSocketMessage,
  ConnectionStatus,
  AttachInfo,
  AuthResponse,
} from '../../types';
import type { WebSocketServiceCore } from './types';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketServiceCoreImpl implements WebSocketServiceCore {
  // ── WebSocket state ────────────────────────────────────────
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly authToken: string;
  private readonly clientId: string;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private authenticated = false;

  // ── Reconnection ───────────────────────────────────────────
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Message IDs ────────────────────────────────────────────
  private messageId = 0;

  // ── Request correlation ────────────────────────────────────
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestTimeout = 10_000; // 10 seconds

  // ── Callbacks ──────────────────────────────────────────────
  private readonly connectionChangeCallbacks: ConnectionChangeCallback[] = [];
  private readonly messageHandlers = new Map<string, Set<(payload: unknown) => void>>();

  // ── In-flight connect promise ──────────────────────────────
  // Lets concurrent callers await the same attempt (refs #71 #4).
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, authToken: string) {
    this.url = url;
    this.authToken = authToken;
    this.clientId = this.getOrCreateClientId();
  }

  // ──────────────────────────────────────────────────────────
  // Client ID management (persisted in localStorage)
  // ──────────────────────────────────────────────────────────

  private getOrCreateClientId(): string {
    const storageKey = 'nessioclientid';
    let clientId = localStorage.getItem(storageKey);

    if (!clientId) {
      // uuid v4 uses crypto.getRandomValues() for cryptographically secure IDs.
      // Works in both HTTP and HTTPS environments.
      clientId = uuidv4();
      localStorage.setItem(storageKey, clientId);
      console.log('Generated new client ID:', clientId);
    } else {
      console.log('Using existing client ID:', clientId);
    }

    return clientId;
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Already open — nothing to do.
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // CONNECTING — an earlier call is still in flight; await the same promise
    // so the caller's `await connect()` truly means "connected". (refs #71 #4)
    if (this.ws?.readyState === WebSocket.CONNECTING && this.connectPromise) {
      return this.connectPromise;
    }

    this.setConnectionStatus('connecting');

    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          this.setConnectionStatus('connected');

          // Authenticate immediately after connection
          this.authenticate()
            .then(() => {
              this.connectPromise = null;
              resolve();
            })
            .catch((err) => {
              this.connectPromise = null;
              reject(err);
            });
        };

        this.ws.onmessage = (event) => {
          this.handleRawMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.setConnectionStatus('disconnected');
          this.connectPromise = null;
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.onclose = () => {
          console.log('WebSocket closed');
          this.authenticated = false;
          this.rejectAllPendingRequests(new Error('Connection closed'));

          // Don't immediately broadcast 'disconnected' — if auto-reconnect
          // is still possible we keep the UI in a connecting state so the
          // router doesn't flip back to the login page.  Only signal
          // 'disconnected' when all reconnect attempts are exhausted.
          if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.setConnectionStatus('disconnected');
          } else {
            this.setConnectionStatus('connecting');
          }

          this.scheduleReconnect();
        };
      } catch (error) {
        this.setConnectionStatus('disconnected');
        this.connectPromise = null;
        reject(error);
      }
    });

    return this.connectPromise;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Null out ALL handlers before closing to prevent any async callback
      // (onerror, onmessage, onopen, onclose) from racing with teardown. (refs #71 #3)
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.authenticated = false;
    this.setConnectionStatus('disconnected');
    this.rejectAllPendingRequests(new Error('Disconnected'));
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected' || this.connectionStatus === 'authenticated';
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  getUrl(): string {
    return this.url;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  onConnectionChange(callback: ConnectionChangeCallback): () => void {
    this.connectionChangeCallbacks.push(callback);
    return () => {
      const index = this.connectionChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.connectionChangeCallbacks.splice(index, 1);
      }
    };
  }

  // ──────────────────────────────────────────────────────────
  // Authentication
  // ──────────────────────────────────────────────────────────

  async authenticate(): Promise<void> {
    const response = await this.request<AuthResponse>('client.auth', {
      auth_token: this.authToken,
      client_id: this.clientId,
    });

    if (response.status === 'success') {
      this.authenticated = true;
      this.setConnectionStatus('authenticated');
    } else {
      throw new Error(response.message || 'Authentication failed');
    }
  }

  // ──────────────────────────────────────────────────────────
  // Message sending
  // ──────────────────────────────────────────────────────────

  send(message: WebSocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  // ──────────────────────────────────────────────────────────
  // Message routing (handler registration + dispatch)
  // ──────────────────────────────────────────────────────────

  /**
   * Register a handler for a specific message type.
   * Returns an unsubscribe function.
   */
  onMessage(type: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.messageHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.messageHandlers.set(type, handlers);
    }
    handlers.add(handler);

    return () => {
      const set = this.messageHandlers.get(type);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.messageHandlers.delete(type);
        }
      }
    };
  }

  // ──────────────────────────────────────────────────────────
  // Request/response correlation
  // ──────────────────────────────────────────────────────────

  async request<T>(type: string, payload: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = this.generateMessageId();
    const message: WebSocketMessage = {
      msg_type: type,
      id,
      timestamp: Date.now(),
      payload: payload as Record<string, unknown>,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        timeout,
      });

      try {
        this.ws!.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to serialize message: ${msg}`));
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────────────────

  generateMessageId(): string {
    this.messageId++;
    // crypto.randomUUID() requires a secure context (HTTPS/localhost);
    // fall back to a counter + random suffix which is unique enough for
    // single-tab request correlation.
    const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `msg_${this.messageId}_${rnd}`;
  }

  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null {
    if (attachInfo.mode !== 'p2p' || !attachInfo.agent_address || !attachInfo.connection_token) {
      return null;
    }
    // agent_address is already a complete WebSocket URL (e.g. "ws://agent.example.com/ws")
    return {
      url: attachInfo.agent_address,
      token: attachInfo.connection_token,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Private — reconnection
  // ──────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      // Signal permanent disconnection so the UI can redirect to login.
      this.setConnectionStatus('disconnected');
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );

    console.log(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect().catch((err) => {
        console.error('Reconnection failed:', err);
      });
    }, delay);
  }

  // ──────────────────────────────────────────────────────────
  // Private — message dispatch
  // ──────────────────────────────────────────────────────────

  private handleRawMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data);

      // 1. Check if this is a response to a pending request
      if (this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        pending.resolve(message.payload);
        return;
      }

      // 2. Dispatch to registered handlers by msg_type
      const handlers = this.messageHandlers.get(message.msg_type);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.payload);
        }
        return;
      }

      // 3. Handle well-known ack / error types that no plugin registered for
      if (message.msg_type === 'error') {
        const errMsg = (message.payload as Record<string, unknown>)?.message as string | undefined;
        console.error('[relay] Server error:', errMsg ?? 'unknown error', message.payload);
        return;
      }
      if (message.msg_type === 'ok') {
        // Fire-and-forget acknowledgements — no action needed.
        return;
      }

      // 4. No handler — log a warning
      console.warn('Unhandled message type:', message.msg_type, message.payload);
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private — connection status
  // ──────────────────────────────────────────────────────────

  private setConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) {
      return;
    }
    this.connectionStatus = status;
    this.connectionChangeCallbacks.forEach((callback) => callback(status));
  }

  // ──────────────────────────────────────────────────────────
  // Private — pending request cleanup
  // ──────────────────────────────────────────────────────────

  private rejectAllPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }
}
