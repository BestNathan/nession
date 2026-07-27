// Type definitions for nession Web UI

export interface Agent {
  agent_id: string;
  hostname: string;
  /** Human-readable display name. Falls back to hostname when absent. */
  display_name?: string;
  ip_address: string;
  port: number;
  status: 'online' | 'offline' | 'degraded';
  session_count: number;
  active_sessions?: number;
  last_heartbeat: string; // ISO 8601 timestamp
  registered_at?: string; // ISO 8601 timestamp (added for uptime display)
  metadata?: {
    tmux_version: string;
    os_version: string;
    nession_version: string;
    image_tag?: string;
  };
  /** Candidate P2P endpoints with server probe status (issue #51). Empty for
   *  legacy servers that don't yet send them in agents.list. */
  addresses?: ProbedAddress[];
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

/**
 * Network category of an advertised agent address (mirrors the Rust
 * `NetworkType` enum). Used for UI labelling and ordering.
 */
export type NetworkType = 'lan' | 'vpn' | 'tunnel' | 'public' | 'custom';

/** Server's latest TCP reachability probe result for an address. */
export type AddressStatus = 'unknown' | 'reachable' | 'unreachable';

/**
 * A single candidate P2P endpoint with the server's probe status. Flattened
 * wire shape: address fields + status/rtt at the top level.
 */
export interface ProbedAddress {
  url: string; // Complete WebSocket URL (e.g. "ws://192.168.1.5:8080/ws")
  label?: string;
  network_type: NetworkType;
  priority: number;
  status: AddressStatus;
  rtt_ms?: number; // Last successful probe round-trip, milliseconds
}

/** Result of the client's own latency test against one address. */
export interface AddressLatency {
  url: string;
  /** Handshake RTT in ms, or null when the test failed/timed out. */
  latencyMs: number | null;
}

export interface AttachInfo {
  mode: 'p2p' | 'relay';
  session_id: string;
  session_name?: string;
  // For P2P mode:
  agent_address?: string; // Legacy single URL (first/tunnel-preferred address)
  connection_token?: string;
  /** Full candidate list with probe status (issue #43). Empty for relay. */
  addresses?: ProbedAddress[];
}

/**
 * Connection mode the user requests when attaching.
 * - 'auto': try P2P, fall back to relay (default)
 * - 'p2p': force direct agent connection (error if unavailable)
 * - 'relay': force proxy through the server
 */
export type AttachMode = 'auto' | 'p2p' | 'relay';

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
  client_id?: string;
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

export interface ActiveEnvFile {
  name: string;
  source: EnvSource;
  agent_id?: string;
  phase: string; // "create" | "attach"
}

export interface SessionEnvActiveResponse {
  active: ActiveEnvFile[];
}
export interface SessionEnvResponse {
  success: boolean;
  error?: string;
  warnings?: string[];
}

export interface SessionEnvQueryResponse {
  sourced_files: EnvFileRef[];
  error?: string;
}

// Quick command (server-managed, issue #95, part 3).
export interface QuickCommandItem {
  id: string;
  label: string;
  command: string;
  raw?: boolean;
  sort_order?: number;
  created_at?: number;
}

export interface CommandsListResponse {
  commands: QuickCommandItem[];
}

export interface CommandsAddResponse {
  success: boolean;
  id?: string;
  error?: string;
}

export interface CommandsRemoveResponse {
  success: boolean;
  error?: string;
}

export interface CommandsUpdateResponse {
  success: boolean;
  error?: string;
}

/** Server info returned by client.server.info. */
export interface ServerInfo {
  version: string;
  image_tag?: string;
  uptime_seconds: number;
  agent_count: number;
  online_agent_count: number;
  session_count: number;
}
