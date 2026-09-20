// Type definitions for nession Web UI

import type { ProtocolManifest } from '@/platform/protocol';

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
  /**
   * What this agent reported it can serve (`#678`).
   *
   * `null` — not absent — for an agent that advertised none, which the design
   * calls a **Legacy Peer** and relays to exactly as it did before manifests
   * existed. `undefined` here means the server did not say, which is the same
   * answer for the same reason; `ProtocolDirectory` collapses them, so nothing
   * downstream has to care which it got.
   *
   * Type-only import: `ProtocolManifest` is the wire shape of a peer's protocol
   * set, and this is the record that carries it. No runtime edge is created.
   */
  protocols?: ProtocolManifest | null;
}

export interface Session {
  session_id: string; // Format: "agent_id:session_name"
  agent_id: string;
  session_name: string;
  status: 'active' | 'detached' | 'zombie';
  window_count: number;
  attached_clients: number;
  /**
   * Foreground command of the session's active pane, as reported by the agent.
   * Absent when the agent does not report one (older agent, or no pane).
   */
  foreground_command?: string | null;
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
} from '@/capabilities/env';

export type {
  QuickCommandItem,
  CommandsListResponse,
  CommandsAddResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
} from '@/capabilities/commands';

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

/**
 * Attach lifecycle status of the local terminal connection.
 *
 * Lives here rather than beside the runtime that acts on it, because the state
 * atoms read it too and they sat in `atoms/`, which was the `shared` layer and
 * may not import `core`. `src/types.ts` is the documented home for core types,
 * and it sits outside the layer directories, so both sides can name it (#783).
 *
 * The actors have since moved — the readers are `product/session/state` and
 * `product/terminal/state` now, not `atoms/` — but the type stays here: it is a
 * root type by the rule above, and `platform/terminal-runtime` names it too.
 */
export type TerminalStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'attached'
  | 'reconnecting'
  | 'failed';
