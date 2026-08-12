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
  /** Agents that did not answer a force refresh, so their sessions above may
   *  be out of date. Absent on non-force requests. */
  stale_agents?: string[];
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

// Domain-specific types have been moved to their respective component folders.
// Re-exported here for backward compatibility.
export type {
  EnvSource,
  EnvFileInfo,
  EnvFileRef,
  EnvListResponse,
  EnvGetResponse,
  EnvWriteResponse,
  EnvDeleteResponse,
  ActiveEnvFile,
  SessionEnvActiveResponse,
  SessionEnvResponse,
  SessionEnvQueryResponse,
} from './components/env/types';

export type {
  QuickCommandItem,
  CommandsListResponse,
  CommandsAddResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
} from './components/quickCommands/types';

/** Server info returned by client.server.info. */
export interface ServerInfo {
  version: string;
  image_tag?: string;
  uptime_seconds: number;
  agent_count: number;
  online_agent_count: number;
  session_count: number;
  /** ISO 8601 timestamp when the binary was built. */
  build_time?: string;
}
