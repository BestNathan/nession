// WebSocket service for nession Web UI
// Handles connection management, authentication, request/response, and event subscriptions

import {
  WebSocketMessage,
  ConnectionStatus,
  Agent,
  Session,
  AttachInfo,
  AuthResponse,
  AgentsListResponse,
  SessionsListResponse,
} from '../types';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;
type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type TerminalOutputCallback = (data: string) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private authToken: string;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;

  // Request correlation
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimeout = 10000; // 10 seconds

  // Event subscribers
  private connectionChangeCallbacks: ConnectionChangeCallback[] = [];
  private agentsChangeCallbacks: AgentsChangeCallback[] = [];
  private sessionsChangeCallbacks: SessionsChangeCallback[] = [];
  private terminalOutputCallbacks = new Map<string, TerminalOutputCallback[]>();

  // Authentication state
  private authenticated = false;

  constructor(url: string, authToken: string) {
    this.url = url;
    this.authToken = authToken;
  }

  // Connection Management

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.setConnectionStatus('connecting');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          this.setConnectionStatus('connected');

          // Send authentication immediately after connection
          this.authenticate()
            .then(() => {
              resolve();
            })
            .catch((err) => {
              reject(err);
            });
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.setConnectionStatus('disconnected');
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.onclose = () => {
          console.log('WebSocket closed');
          this.setConnectionStatus('disconnected');
          this.authenticated = false;
          this.rejectAllPendingRequests(new Error('Connection closed'));
          this.scheduleReconnect();
        };
      } catch (error) {
        this.setConnectionStatus('disconnected');
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
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

  isauthenticated(): boolean {
    return this.authenticated;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  onConnectionChange(callback: ConnectionChangeCallback): () => void {
    this.connectionChangeCallbacks.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.connectionChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.connectionChangeCallbacks.splice(index, 1);
      }
    };
  }

  // Request/Response API

  async authenticate(): Promise<void> {
    const response = await this.request<AuthResponse>('client.auth', {
      auth_token: this.authToken,
    });

    if (response.status === 'success') {
      this.authenticated = true;
      this.setConnectionStatus('authenticated');
    } else {
      throw new Error(response.message || 'Authentication failed');
    }
  }

  async listAgents(): Promise<Agent[]> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<AgentsListResponse>('client.agents.list', {});
    return response.agents;
  }

  async listSessions(agentId?: string): Promise<Session[]> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const payload = agentId ? { agent_id: agentId } : {};
    const response = await this.request<SessionsListResponse>('client.sessions.list', payload);
    return response.sessions;
  }

  async requestAttach(
    sessionId: string,
    mode: 'p2p' | 'relay' = 'p2p'
  ): Promise<AttachInfo> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<AttachInfo>('client.session.attach', {
      session_id: sessionId,
      preferred_mode: mode,
    });

    return response;
  }

  async request<T>(type: string, payload: any): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = this.generateMessageId();
    const message: WebSocketMessage = {
      msg_type: type,
      id,
      timestamp: Date.now(),
      payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.ws!.send(JSON.stringify(message));
    });
  }

  // Event Subscriptions

  onAgentsChanged(callback: AgentsChangeCallback): () => void {
    this.agentsChangeCallbacks.push(callback);
    return () => {
      const index = this.agentsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.agentsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onSessionsChanged(callback: SessionsChangeCallback): () => void {
    this.sessionsChangeCallbacks.push(callback);
    return () => {
      const index = this.sessionsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.sessionsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onTerminalOutput(sessionId: string, callback: TerminalOutputCallback): () => void {
    if (!this.terminalOutputCallbacks.has(sessionId)) {
      this.terminalOutputCallbacks.set(sessionId, []);
    }
    this.terminalOutputCallbacks.get(sessionId)!.push(callback);

    return () => {
      const callbacks = this.terminalOutputCallbacks.get(sessionId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          this.terminalOutputCallbacks.delete(sessionId);
        }
      }
    };
  }

  // Terminal I/O (for after attach)

  sendTerminalInput(sessionId: string, data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const message: WebSocketMessage = {
      msg_type: 'terminal.input',
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload: {
        session_id: sessionId,
        data,
      },
    };

    this.ws.send(JSON.stringify(message));
  }

  sendTerminalResize(sessionId: string, width: number, height: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const message: WebSocketMessage = {
      msg_type: 'terminal.resize',
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload: {
        session_id: sessionId,
        width,
        height,
      },
    };

    this.ws.send(JSON.stringify(message));
  }

  // P2P Support

  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null {
    if (attachInfo.mode !== 'p2p' || !attachInfo.agent_address || !attachInfo.connection_token) {
      return null;
    }

    // Convert agent_address (ip:port) to WebSocket URL
    const wsUrl = `ws://${attachInfo.agent_address}/ws`;

    return {
      url: wsUrl,
      token: attachInfo.connection_token,
    };
  }

  // Private Methods

  private handleMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data);

      // Check if this is a response to a pending request
      if (this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        pending.resolve(message.payload);
        return;
      }

      // Handle event messages
      switch (message.msg_type) {
        case 'client.agents.list.response':
          // This shouldn't happen (should be caught by pending request), but handle it anyway
          if (message.payload.agents) {
            this.notifyAgentsChange(message.payload.agents);
          }
          break;

        case 'client.sessions.list.response':
          // This shouldn't happen (should be caught by pending request), but handle it anyway
          if (message.payload.sessions) {
            this.notifySessionsChange(message.payload.sessions);
          }
          break;

        case 'terminal.output':
          this.handleTerminalOutput(message.payload);
          break;

        case 'agents.changed':
          if (message.payload.agents) {
            this.notifyAgentsChange(message.payload.agents);
          }
          break;

        case 'sessions.changed':
          if (message.payload.sessions) {
            this.notifySessionsChange(message.payload.sessions);
          }
          break;

        default:
          console.warn('Unhandled message type:', message.msg_type);
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  private handleTerminalOutput(payload: any): void {
    const sessionId = payload.session_id;
    const data = payload.data;

    const callbacks = this.terminalOutputCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  private notifyAgentsChange(agents: Agent[]): void {
    this.agentsChangeCallbacks.forEach((callback) => callback(agents));
  }

  private notifySessionsChange(sessions: Session[]): void {
    this.sessionsChangeCallbacks.forEach((callback) => callback(sessions));
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) {
      return;
    }

    this.connectionStatus = status;
    this.connectionChangeCallbacks.forEach((callback) => callback(status));
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
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

  private generateMessageId(): string {
    this.messageId++;
    return `msg_${this.messageId}_${Date.now()}`;
  }

  private rejectAllPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }
}

// Singleton instance for global access
let wsServiceInstance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService | null {
  return wsServiceInstance;
}

export function createWebSocketService(url: string, authToken: string): WebSocketService {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
  }

  wsServiceInstance = new WebSocketService(url, authToken);
  return wsServiceInstance;
}

export function destroyWebSocketService(): void {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
    wsServiceInstance = null;
  }
}
