import type { WebSocketService } from '@/services/socket';
import type { ConnectionState } from '@/services/socket/types';
import { terminalServerApi, type TerminalServerApi } from '@/features/terminal';

/**
 * Relay-mode lifecycle surface SessionRuntime needs from the server
 * connection. A {@link RelayServerHandle} is the narrow, dependency-free view
 * of the app's server WebSocket plus the server-side terminal capability;
 * injecting the raw service into the runtime would couple it to the transport
 * implementation. Handles are built by {@link relayServerHandle}.
 */
export interface RelayServerHandle {
  /**
   * Subscribe to server-connection state ('connecting' | 'connected' |
   * 'disconnected' | 'reconnecting'). 'connected' is the post-handshake
   * state. Returns an unsubscribe function.
   */
  onConnectionStateChange(cb: (state: ConnectionState) => void): () => void;
  /** True once the handshake completed — connectionState === 'connected'. */
  isReady(): boolean;
  /**
   * Ask the server to relay terminal traffic for a session (server →
   * agent direction). No-op when the connection is not ready; the caller
   * (terminal state machine) gates on {@link isReady}.
   */
  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void;
  /** Ask the server to stop relaying terminal traffic for a session. */
  endRelay(sessionId: string): void;
}

/**
 * The full relay surface shared by every relay consumer: the lifecycle
 * members above plus the per-session relay I/O of the server terminal
 * capability. `relayServerHandle` builds one object of this shape per
 * service, so SessionRuntime (which only needs {@link RelayServerHandle})
 * and ConnectionManager (which needs the I/O members) can share a single
 * handle — structural subtyping narrows it at each call site.
 */
export type RelayServerTransport = RelayServerHandle &
  Pick<
    TerminalServerApi,
    'sendRelayInput' | 'sendRelayResize' | 'onRelayOutput' | 'onRelayResize'
  >;

/**
 * Build a relay handle for a server WebSocket service. Transport state
 * (subscription + readiness) delegates to the service; the relay lifecycle
 * and terminal I/O delegate to the terminal-server capability singleton,
 * which binds to whichever service instance is currently installed.
 */
export function relayServerHandle(service: WebSocketService): RelayServerTransport {
  return {
    onConnectionStateChange: (cb) => service.onConnectionStateChange(cb),
    isReady: () => service.connectionState === 'connected',
    beginRelay: (sessionId, relayUrl, cols, rows) =>
      terminalServerApi.beginRelay(sessionId, relayUrl, cols, rows),
    endRelay: (sessionId) => terminalServerApi.endRelay(sessionId),
    sendRelayInput: (sessionName, data) => terminalServerApi.sendRelayInput(sessionName, data),
    sendRelayResize: (sessionName, cols, rows) =>
      terminalServerApi.sendRelayResize(sessionName, cols, rows),
    onRelayOutput: (sessionName, cb) => terminalServerApi.onRelayOutput(sessionName, cb),
    onRelayResize: (sessionName, cb) => terminalServerApi.onRelayResize(sessionName, cb),
  };
}
