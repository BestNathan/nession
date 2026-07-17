// WebSocket service for nession Web UI
// Handles connection management, authentication, request/response, and event subscriptions

import { v4 as uuidv4 } from 'uuid';
import {
  WebSocketMessage,
  ConnectionStatus,
  Agent,
  Session,
  AttachInfo,
  AuthResponse,
  AgentsListResponse,
  SessionsListResponse,
  CreateSessionResponse,
  KillSessionResponse,
  EnvFileRef,
  EnvListResponse,
  EnvGetResponse,
  EnvWriteResponse,
  EnvDeleteResponse,
  SessionEnvResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
} from '../types';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;
type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type TerminalOutputCallback = (data: string) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private authToken: string;
  private clientId: string;
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

  // In-flight connect promise — lets concurrent callers await the same attempt (#71 #4)
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, authToken: string) {
    this.url = url;
    this.authToken = authToken;
    this.clientId = this.getOrCreateClientId();
  }

  // Client ID management (persisted in localStorage)
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

  // Connection Management

  async connect(): Promise<void> {
    // Already open — nothing to do.
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // CONNECTING — an earlier call is still in flight; await the same promise
    // so the caller's `await connect()` truly means "connected". (#71 #4)
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

          // Send authentication immediately after connection
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
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.setConnectionStatus('disconnected');
          this.connectPromise = null;
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
      // (onerror, onmessage, onopen, onclose) from racing with teardown. (#71 #3)
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
      client_id: this.clientId,
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

  async createSession(
    agentId: string,
    name: string,
    envFiles: EnvFileRef[] = []
  ): Promise<CreateSessionResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<CreateSessionResponse>('client.session.create', {
      agent_id: agentId,
      name,
      env_files: envFiles,
    });

    return response;
  }

  // Environment-variable file management

  async listEnvFiles(): Promise<EnvListResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<EnvListResponse>('client.env.list', {});
  }

  async getEnvFile(ref: EnvFileRef): Promise<EnvGetResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<EnvGetResponse>('client.env.get', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  async writeEnvFile(
    ref: EnvFileRef,
    content: string,
    overwrite: boolean
  ): Promise<EnvWriteResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<EnvWriteResponse>('client.env.write', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
      content,
      overwrite,
    });
  }

  async deleteEnvFile(ref: EnvFileRef): Promise<EnvDeleteResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<EnvDeleteResponse>('client.env.delete', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  async applySessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[]
  ): Promise<SessionEnvResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<SessionEnvResponse>('client.session.env.apply', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  async unsetSessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[]
  ): Promise<SessionEnvResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<SessionEnvResponse>('client.session.env.unset', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  async getSessionEnvActive(sessionId: string): Promise<SessionEnvActiveResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<SessionEnvActiveResponse>('client.session.env.active', {
      session_id: sessionId,
    });
  }

  async queryAgentEnvState(sessionId: string): Promise<SessionEnvQueryResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }
    return this.request<SessionEnvQueryResponse>('client.session.env.query', {
      session_id: sessionId,
    });
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<KillSessionResponse>('client.session.kill', {
      session_id: sessionId,
    });

    return response;
  }

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
        reject(new Error(`Failed to serialize message: ${err instanceof Error ? err.message : String(err)}`));
      }
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

    // agent_address is already a complete WebSocket URL (e.g. "ws://agent.example.com/ws")
    const wsUrl = attachInfo.agent_address;

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
            this.notifyAgentsChange(message.payload.agents as Agent[]);
          }
          break;

        case 'client.sessions.list.response':
          // This shouldn't happen (should be caught by pending request), but handle it anyway
          if (message.payload.sessions) {
            this.notifySessionsChange(message.payload.sessions as Session[]);
          }
          break;

        case 'terminal.output':
          this.handleTerminalOutput(message.payload);
          break;

        case 'agents.changed':
          if (message.payload.agents) {
            this.notifyAgentsChange(message.payload.agents as Agent[]);
          }
          break;

        case 'sessions.changed':
          if (message.payload.sessions) {
            this.notifySessionsChange(message.payload.sessions as Session[]);
          }
          break;

        default:
          console.warn('Unhandled message type:', message.msg_type);
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  private handleTerminalOutput(payload: Record<string, unknown>): void {
    const sessionId = payload.session_id as string;
    const data = payload.data as string;

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
    // crypto.randomUUID() requires a secure context (HTTPS/localhost);
    // fall back to a counter + random suffix which is unique enough for
    // single-tab request correlation.
    const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `msg_${this.messageId}_${rnd}`;
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
