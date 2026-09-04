/**
 * Server WebSocket domain facade.
 *
 * SocketCore owns the browser WebSocket, reconnect, parsing and request
 * correlation lifecycle. This class only adds server authentication and maps
 * generic transport states to the historical server status contract consumed
 * by plugins and relay code.
 */
import { v4 as uuidv4 } from 'uuid';
import type { AttachInfo, AuthResponse, ConnectionStatus, WebSocketMessage } from '../../types';
import { SocketCore } from '../socket/SocketCore';
import type { SocketMessage } from '../socket/types';
import type { WebSocketServiceCore } from './types';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;

export class WebSocketServiceCoreImpl implements WebSocketServiceCore {
  private readonly clientId: string;
  private readonly core: SocketCore;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private authenticated = false;
  private readonly connectionChangeCallbacks = new Set<ConnectionChangeCallback>();

  constructor(private readonly url: string, private readonly authToken: string) {
    this.clientId = this.getOrCreateClientId();
    this.core = new SocketCore({
      url,
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 1_000,
      connectionLostMessage: 'Connection closed',
      onError: (error) => console.error('Failed to parse WebSocket message:', error),
      handshake: (socket) => this.authenticateWith(socket),
    });
    this.core.onConnectionStateChange((state) => {
      if (state === 'connecting') {
        this.setConnectionStatus('connecting');
      } else if (state === 'reconnecting') {
        this.authenticated = false;
        this.setConnectionStatus('connecting');
      } else if (state === 'disconnected') {
        this.authenticated = false;
        this.setConnectionStatus('disconnected');
      } else if (state === 'connected' && !this.authenticated) {
        this.setConnectionStatus('connected');
      }
    });
    this.core.onMessage((message) => {
      if (message.msg_type === 'error') {
        return;
      }
      if (message.msg_type === 'ok') {
        return;
      }
      // Plugin subscriptions are installed through onMessage below. Unknown
      // server events retain the old diagnostic without owning dispatch here.
      if (!this.subscribedTypes.has(message.msg_type)) {
        console.warn('Unhandled message type:', message.msg_type, message.payload);
      }
    });
  }

  private readonly subscribedTypes = new Set<string>();

  private getOrCreateClientId(): string {
    const key = 'nessioclientid';
    let id = localStorage.getItem(key);
    if (!id) {
      id = uuidv4();
      localStorage.setItem(key, id);
    }
    return id;
  }

  async connect(): Promise<void> {
    return this.core.connect();
  }

  disconnect(): void {
    this.authenticated = false;
    this.core.disconnect();
    this.setConnectionStatus('disconnected');
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
    this.connectionChangeCallbacks.add(callback);
    return () => this.connectionChangeCallbacks.delete(callback);
  }

  async authenticate(): Promise<void> {
    return this.authenticateWith(this.core);
  }

  private async authenticateWith(socket: SocketCore): Promise<void> {
    const response = await socket.request<AuthResponse>('client.auth', {
      auth_token: this.authToken,
      client_id: this.clientId,
    });
    if (response.status !== 'success') {
      throw new Error(response.message || 'Authentication failed');
    }
    this.authenticated = true;
    this.setConnectionStatus('authenticated');
  }

  send(message: WebSocketMessage): void {
    this.core.send(message as SocketMessage);
  }

  onMessage(type: string, handler: (payload: unknown) => void): () => void {
    this.subscribedTypes.add(type);
    const unsubscribe = this.core.subscribe(type, (payload) => handler(payload));
    return () => {
      unsubscribe();
      // Multiple plugins may subscribe to one event type.
      // Keep the diagnostic suppression until all handlers are gone.
    };
  }

  failPending(error: Error): void {
    this.core.failPending(error);
  }

  request<T>(type: string, payload: unknown, timeoutMs?: number): Promise<T> {
    return this.core.request<T>(type, payload as Record<string, unknown>, { timeoutMs });
  }

  generateMessageId(): string {
    return this.core.generateMessageId();
  }

  get reconnectAttempts(): number {
    return this.core.reconnectAttempts;
  }

  set reconnectAttempts(value: number) {
    this.core.reconnectAttempts = value;
  }

  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null {
    if (attachInfo.mode !== 'p2p' || !attachInfo.agent_address || !attachInfo.connection_token) {
      return null;
    }
    return { url: attachInfo.agent_address, token: attachInfo.connection_token };
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) {
      return;
    }
    this.connectionStatus = status;
    for (const callback of this.connectionChangeCallbacks) {
      callback(status);
    }
  }
}
