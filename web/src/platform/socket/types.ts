import type { ProtocolDirectory } from '@/platform/protocol';

export interface SocketMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/** Exact wire identity returned only after a tracked send succeeds. */
export interface SentSocketMessage {
  id: string;
  physicalGeneration: number;
}

export interface RequestOptions {
  timeoutMs?: number;
}

/** Transport-facing surface given to the post-open handshake (not readiness-gated). */
export interface HandshakeSurface {
  send(type: string, payload: Record<string, unknown>): void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

/** Plugin-facing surface — everything a plugin may do with the transport. */
export interface PluginSurface {
  readonly connectionState: ConnectionState;
  send(type: string, payload: Record<string, unknown>): void;
  /** Optional on legacy/test surfaces; does not fabricate a correlation ID. */
  sendTracked?(type: string, payload: Record<string, unknown>): SentSocketMessage;
  /** Changes for every new physical WebSocket, not merely at plugin installation. */
  readonly physicalGeneration?: number;
  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
  waitForConnection(timeoutMs?: number): Promise<void>;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  /**
   * What each reachable target advertises (`#678`, Phase 4).
   *
   * It hangs off the surface because the surface is the only thing two plugins
   * already share: `product/agent` fills it from `client.agents.list`, and
   * `capabilities/git` and `capabilities/claude-code` read it to resolve a
   * contract version per target before addressing a call. Routing it through
   * the service instead would make either the socket layer or one capability
   * depend on the other.
   *
   * One instance per service, so it is emptied with the connection — a manifest
   * outliving the socket it was learned on is a stale answer waiting to be
   * resolved against.
   */
  readonly protocols: ProtocolDirectory;
}

/**
 * A wire-protocol adapter bound to a connection.
 *
 * Named for what it plugs *into*, not for what it serves. Implementors are the
 * request/response families a connection speaks — `file.*`, `session.*`,
 * `claude-code.*` — installed once per service lifetime and never on
 * reconnect.
 *
 * It was called `CapabilityPlugin` until #801, which put one word on two
 * unrelated things. **Product Capability** is the discoverable/activatable
 * concept with a presence state that a user meets in the UI; a transport plugin
 * has no presence, is never activated, and is invisible to the user. Keeping a
 * single term for both made every sentence about capabilities ambiguous — which
 * is why this one is named after the layer it belongs to instead.
 */
export interface TransportPlugin {
  readonly name: string;
  install(connection: PluginSurface): () => void;
}

/**
 * A bounded, redacted transport fact for client diagnostics (#3358).
 *
 * Never carries a URL, auth token or credential: `generation` and `attempt`
 * identify the physical/logical connection, and `code`/`wasClean`/`reason` are
 * the browser's own close facts. The consumer decides where this goes.
 */
export interface TransportDiagnostic {
  event:
    | 'socket-open'
    | 'socket-error'
    | 'socket-close'
    | 'handshake-failure'
    | 'reconnect-scheduled';
  generation: number;
  attempt: number;
  /** Browser CloseEvent code and cleanliness, for `socket-close`. */
  code?: number;
  wasClean?: boolean;
  /** Server/peer close reason, bounded by the consumer, never a credential. */
  reason?: string;
  /** Distinguishes an explicit refusal from a timeout/transport failure. */
  failureClass?: 'auth-rejected' | 'transport';
  /** Delay of the scheduled retry, for `reconnect-scheduled`. */
  delayMs?: number;
}

export interface WebSocketServiceOptions {
  handshake?: (surface: HandshakeSurface) => Promise<void>;
  maxReconnectAttempts?: number; // default 10
  reconnectBaseDelay?: number;   // default 1_000, exp backoff, cap 30_000
  /**
   * Past `maxReconnectAttempts`, keep probing at a slow flat cadence instead of
   * settling on `disconnected`.
   *
   * For a route pinned to one address: there is no other candidate to rotate
   * to, so spending the budget is not the same as the endpoint being gone, and
   * stopping there hands recovery to a manual action the user has no reason to
   * expect (#1263). The transport also stays `reconnecting` rather than
   * reporting a loss, which is what keeps the route's own recovery from being
   * declared exhausted while it is still being attempted.
   *
   * Left off wherever rotation exists: those paths need the transport to reach
   * `disconnected` so the address policy can pick the next candidate.
   */
  persistentReconnect?: boolean;
  /**
   * Whether a spent budget is reported once as `disconnected` while the
   * persistent tail keeps probing (default `true`).
   *
   * The report is a verdict for callers whose policy rotates candidates away
   * from a spent route. A caller that has nothing to rotate to and whose UI
   * must keep its session surface mounted — the app's one Server connection —
   * sets this to `false`; the transport then stays `reconnecting` for the whole
   * tail, so the shell does not fall back to Login during a transient outage
   * (#3358).
   */
  reportExhaustion?: boolean;
  /**
   * Treat a failed **first** dial as recoverable instead of terminal.
   *
   * The default keeps the historical candidate-rotation semantics: a route
   * whose first socket cannot open is a dead candidate, and the address policy
   * must be allowed to advance immediately (#1926). The app's Server
   * connection has no next candidate and must recover from a cold start with
   * no network (#3358 SC-02).
   */
  reconnectOnInitialFailure?: boolean;
  /**
   * Classify a handshake rejection as the peer's **explicit refusal** (default
   * `true`), which stops retrying (#692), versus a timeout/unresponsive peer,
   * which is a loss that may be retried (#3358 SC-02).
   *
   * The handshake owner knows which errors are refusals; the transport cannot.
   * A default of `true` preserves the historical one-rejection-stops rule for
   * every existing caller.
   */
  isHandshakeRefusal?: (error: Error) => boolean;
  /** Redacted, bounded connection diagnostics (#3358 SC-05). */
  onDiagnostic?: (diagnostic: TransportDiagnostic) => void;
  onError?: (error: Error) => void;
  /** Called only when the live physical socket opens but its handshake rejects. */
  onHandshakeRejected?: (error: Error) => void;
}
