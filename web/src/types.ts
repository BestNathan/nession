// Type definitions for nession Web UI

export interface Agent {
  agent_id: string;
  hostname: string;
  ip_address: string;
  port: number;
  status: 'online' | 'offline' | 'degraded';
  session_count: number;
  active_sessions?: number;
  last_heartbeat: string; // ISO 8601 timestamp
  metadata?: {
    tmux_version: string;
    os_version: string;
    nession_version: string;
  };
}

export interface Session {
  session_id: string; // Format: "agent_id:session_name"
  agent_id: string;
  session_name: string;
  status: 'active' | 'detached' | 'zombie';
  window_count: number;
  attached_clients: number;
  last_activity: string; // ISO 8601 timestamp
}

export interface AttachInfo {
  mode: 'p2p' | 'relay';
  session_id: string;
  session_name?: string;
  // For P2P mode:
  agent_address?: string; // Complete WebSocket URL (e.g. "ws://agent.example.com/ws")
  connection_token?: string;
}

export interface WebSocketMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'authenticated';

export interface AuthResponse {
  status: 'success' | 'failed';
  message: string;
}

export interface AgentsListResponse {
  agents: Agent[];
}

export interface SessionsListResponse {
  sessions: Session[];
}

export interface CreateSessionResponse {
  success: boolean;
  session_id?: string;
  error?: string;
}

export interface KillSessionResponse {
  success: boolean;
  error?: string;
}

// --- Environment-variable file management ---

export type EnvSource = 'server' | 'agent';

export interface EnvFileInfo {
  name: string;
  source: EnvSource;
  agent_id?: string;
  size: number;
  modified: number; // unix seconds
  var_count: number;
}

export interface EnvFileRef {
  name: string;
  source: EnvSource;
  agent_id?: string;
}

export interface ActiveEnvFile {
  name: string;
  source: EnvSource;
  agent_id?: string;
  phase: string; // "create" | "attach"
  applied_by?: string;
}

export interface EnvListResponse {
  files: EnvFileInfo[];
  error?: string;
}

export interface EnvGetResponse {
  success: boolean;
  content?: string;
  in_use_by?: string[];
  error?: string;
}

export interface EnvWriteResponse {
  success: boolean;
  exists?: boolean;
  error?: string;
  warnings?: string[];
}

export interface EnvDeleteResponse {
  success: boolean;
  error?: string;
}

export interface SessionEnvResponse {
  success: boolean;
  error?: string;
  warnings?: string[];
}

export interface SessionEnvActiveResponse {
  active: ActiveEnvFile[];
  error?: string;
}
