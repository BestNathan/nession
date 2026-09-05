import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';
import type { RelayServerHandle } from '@/runtime/relayServerConnection';
import { buildAgentWsUrl, WebSocketService } from '@/services/socket';
import type { ConnectionState } from '@/services/socket/types';
import { AddressAttachPolicy } from '@/runtime/AddressAttachPolicy';
import { AttachStateMachine, type AttachPhase, type AttachTransitionResult } from '@/runtime/AttachStateMachine';
import { SessionAttachController } from '@/runtime/SessionAttachController';
import { createFilesApi, type FilesPlugin } from '@/features/files';
import { createTerminalAgentApi, type TerminalAgentApi } from '@/features/terminal';

export interface SessionRuntimeConfig {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  addressPlan: AddressPlan;
  /** User-initiated route identity (manual switch); resets candidate index when changed. */
  routeIntentEpoch: number;
  lastResize?: { cols: number; rows: number } | null;
  transportReady?: boolean;
  /** Relay-mode server connection — runtime re-begins relay after server reconnect. */
  serverConnection?: RelayServerHandle | null;
}

export interface RuntimeMirrorSnapshot {
  phase: AttachPhase;
  transportGeneration: number;
  connectionState: ConnectionState;
  /** Agent terminal capability — null outside the P2P transport. */
  agentTerminalApi: TerminalAgentApi | null;
}

export interface SessionRuntimeSnapshot extends RuntimeMirrorSnapshot {
  sessionId: string;
  activeUrl: string | null;
  waitingForAddressPlan: boolean;
  transportReady: boolean;
  lastResize: { cols: number; rows: number } | null;
  reconnectCount: number;
}

export type SessionRuntimeEvent =
  | { type: 'next-candidate'; activeUrl: string | null }
  | { type: 'force-relay' }
  | { type: 'transport-exhausted'; manualRoute: boolean }
  | { type: 'route-intent-changed'; phase: AttachPhase };

export class SessionRuntime {
  readonly sessionId: string;
  readonly attachState: AttachStateMachine;
  readonly attachController: SessionAttachController;
  private addressPolicy: AddressAttachPolicy;
  /** Live P2P WebSocket service to the current agent candidate (or null in relay). */
  private agentWs: WebSocketService | null = null;
  private agentTerminalApi: TerminalAgentApi | null = null;
  /** Files capability of the live P2P transport — null outside it. */
  private filesApi: FilesPlugin | null = null;
  private routeIntentEpoch: number;
  private transportGeneration = 0;
  private lastResize: { cols: number; rows: number } | null = null;
  private transportReady = false;
  /** Transport generation for which client.attach succeeded. */
  private attachedTransportGeneration: number | null = null;
  private connectionUnsub: (() => void) | null = null;
  private readonly connectionStateListeners = new Set<(state: ConnectionState) => void>();
  private readonly runtimeEventListeners = new Set<(event: SessionRuntimeEvent) => void>();
  private readonly attachOutcomeListeners = new Set<(result: AttachTransitionResult) => void>();
  /** Guards against re-entrant / duplicate terminal-disconnect handling. */
  private disconnectHandling = false;
  private relayServerUnsub: (() => void) | null = null;
  private disposed = false;
  private snapshot: SessionRuntimeSnapshot;
  private readonly snapshotListeners = new Set<() => void>();

  constructor(private config: SessionRuntimeConfig) {
    this.sessionId = config.sessionId;
    this.routeIntentEpoch = config.routeIntentEpoch;
    // Every UI uses the same transport-first attach protocol: the state
    // machine gates attach on the terminal viewport being transport-ready.
    this.attachState = new AttachStateMachine({ transportFirst: true });
    this.attachController = new SessionAttachController(this.attachState);
    this.addressPolicy = new AddressAttachPolicy({
      attachInfo: config.attachInfo,
      orderedUrls: config.orderedUrls,
      manualOverride: config.manualOverride,
      forcedRelay: config.forcedRelay,
      addressPlan: config.addressPlan,
      addressIndex: 0,
    });
    this.lastResize = config.lastResize ?? null;
    this.transportReady = config.transportReady ?? false;
    this.snapshot = this.buildSnapshot();
    this.attachController.subscribeOutcomes((result) => {
      if (result.phase === 'attached') {
        this.attachedTransportGeneration = this.transportGeneration;
      }
      if (result.forceRelay) {
        this.applyForceRelay();
      } else if (result.retryAttach) {
        // Self-driving retry: an attach timeout with budget remaining must
        // schedule the next client.attach without any React/Jotai tick.
        this.maybeStartP2PAttach();
      } else if (result.phase === 'connecting' || result.phase === 'reconnecting') {
        // A relay attach opportunity appeared (SESSION_SELECTED, relay loss,
        // failed recovery). Deferred a tick: this listener runs inside the
        // controller's outcome emission, and RELAY_BEGIN_OK would otherwise be
        // delivered to React mirrors before the outcome being processed here.
        this.requestRelayAttach();
      }
      for (const listener of this.attachOutcomeListeners) {
        listener(result);
      }
      this.emitSnapshot();
    });
    this.syncAgentConnection();
    this.wireRelayServerHandler();
    this.driveRelayAttach();
    this.snapshot = this.buildSnapshot();
  }

  getMirrorSnapshot(): RuntimeMirrorSnapshot {
    return {
      phase: this.attachState.phase,
      transportGeneration: this.transportGeneration,
      connectionState: this.agentWs?.connectionState ?? 'disconnected',
      agentTerminalApi: this.config.forcedRelay ? null : this.agentTerminalApi,
    };
  }

  /** Cached external-store snapshot consumed by either terminal UI. */
  getSnapshot = (): SessionRuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  setTransportReady(ready: boolean): void {
    if (this.transportReady === ready) {
      return;
    }
    this.transportReady = ready;
    if (ready) {
      this.maybeStartP2PAttach();
      this.driveRelayAttach();
    }
    this.emitSnapshot();
  }

  updateViewportSize(size: { cols: number; rows: number }): void {
    if (this.lastResize?.cols === size.cols && this.lastResize?.rows === size.rows) {
      return;
    }
    this.lastResize = size;
    this.emitSnapshot();
  }

  subscribeAttachOutcomes(handler: (result: AttachTransitionResult) => void): () => void {
    this.attachOutcomeListeners.add(handler);
    return () => {
      this.attachOutcomeListeners.delete(handler);
    };
  }

  get activeUrl(): string | null {
    return this.addressPolicy.activeUrl;
  }

  get waitingForAddressPlan(): boolean {
    return this.addressPolicy.isP2P && !this.config.addressPlan.ready;
  }

  /** Bumps on internal candidate rotation; distinct from routeIntentEpoch. */
  get currentTransportGeneration(): number {
    return this.transportGeneration;
  }

  get currentRouteIntentEpoch(): number {
    return this.routeIntentEpoch;
  }

  /** Stable key for terminal viewport remount on route / transport change. */
  get transportKey(): string {
    return `${this.routeIntentEpoch}:${this.transportGeneration}:${this.activeUrl ?? ''}`;
  }

  getAgentTerminalApi(): TerminalAgentApi | null {
    return this.agentTerminalApi;
  }

  /** Live agent-transport connection state ('disconnected' outside the P2P transport). */
  get connectionState(): ConnectionState {
    return this.agentWs?.connectionState ?? 'disconnected';
  }

  getFilesApi(): FilesPlugin | null {
    return this.filesApi;
  }

  updateContext(next: Partial<SessionRuntimeConfig>): RuntimeMirrorSnapshot {
    const routeChanged =
      next.routeIntentEpoch !== undefined
      && next.routeIntentEpoch !== this.routeIntentEpoch;
    const prevTransportReady = this.transportReady;
    this.config = { ...this.config, ...next };
    if (next.routeIntentEpoch !== undefined) {
      this.routeIntentEpoch = next.routeIntentEpoch;
    }
    if (next.lastResize !== undefined) {
      this.lastResize = next.lastResize ?? null;
    }
    if (next.transportReady !== undefined) {
      this.transportReady = next.transportReady;
    }

    this.addressPolicy.update({
      attachInfo: this.config.attachInfo,
      orderedUrls: this.config.orderedUrls,
      manualOverride: this.config.manualOverride,
      forcedRelay: this.config.forcedRelay,
      addressPlan: this.config.addressPlan,
      addressIndex: this.addressPolicy.currentIndex,
    });

    if (routeChanged) {
      this.addressPolicy.resetIndex();
      this.handleRouteIntentChange();
      this.emitSnapshot();
      return this.getMirrorSnapshot();
    }

    this.syncAgentConnection();
    this.wireRelayServerHandler();
    if (!prevTransportReady && this.transportReady) {
      this.maybeStartP2PAttach();
    }
    // A relay attach may be due now: forced-relay context just applied, or the
    // xterm viewport became ready while relay attach was pending.
    this.driveRelayAttach();
    this.emitSnapshot();
    return this.getMirrorSnapshot();
  }

  private applyForceRelay(): void {
    if (this.config.forcedRelay) {
      return;
    }
    this.config = { ...this.config, forcedRelay: true };
    this.addressPolicy.update({ forcedRelay: true });
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.transportGeneration += 1;
    this.syncAgentConnection();
    this.wireRelayServerHandler();
    this.emitRuntimeEvent({ type: 'force-relay' });
    // The P2P → relay transport flip is complete; relay attach follows in the
    // same tick unless the server WS is not authenticated yet.
    this.requestRelayAttach();
    this.emitSnapshot();
  }

  private handleRouteIntentChange(): void {
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.attachController.dispatch({ type: 'DISCONNECT' });
    const result = this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.transportGeneration += 1;
    this.syncAgentConnection({ forceReconnect: true });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  private maybeStartP2PAttach(): void {
    if (this.config.forcedRelay || !this.agentWs || !this.agentTerminalApi) {
      return;
    }
    if (this.agentWs.connectionState !== 'connected') {
      return;
    }
    const phase = this.attachState.phase;
    if (phase === 'attached' && this.attachedTransportGeneration === this.transportGeneration) {
      return;
    }
    if (phase === 'idle' || phase === 'failed') {
      return;
    }
    if (!this.attachController.canStartAttach(this.transportReady, true, false, 'p2p')) {
      return;
    }
    this.attachController.startP2PAttach({
      sessionName: this.config.sessionName,
      agentApi: this.agentTerminalApi,
      manualRoute: this.config.manualOverride !== null,
      lastResize: this.lastResize,
      transportGeneration: this.transportGeneration,
    });
  }

  /**
   * Synchronously apply the address policy when the current P2P candidate
   * transport drops: advance to the next candidate, force relay, or exhaust.
   * The connection-loss handler routes through this under the re-entrancy
   * guard; kept public so tests can drive the policy step synchronously.
   */
  onCandidateDisconnected(): 'next-candidate' | 'force-relay' | 'transport-exhausted' | 'none' {
    return this.applyCandidateDisconnect();
  }

  subscribeConnectionState(handler: (state: ConnectionState) => void): () => void {
    this.connectionStateListeners.add(handler);
    return () => {
      this.connectionStateListeners.delete(handler);
    };
  }

  subscribeRuntimeEvents(handler: (event: SessionRuntimeEvent) => void): () => void {
    this.runtimeEventListeners.add(handler);
    return () => {
      this.runtimeEventListeners.delete(handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.teardownConnectionHandler();
    this.teardownRelayServerHandler();
    this.attachController.cancelActiveAttach();
    this.agentWs?.dispose();
    this.agentWs = null;
    this.agentTerminalApi = null;
    this.filesApi = null;
    this.connectionStateListeners.clear();
    this.runtimeEventListeners.clear();
    this.snapshotListeners.clear();
  }

  private emitConnectionState(state: ConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      listener(state);
    }
    this.emitSnapshot();
  }

  private emitRuntimeEvent(event: SessionRuntimeEvent): void {
    for (const listener of this.runtimeEventListeners) {
      listener(event);
    }
  }

  private buildSnapshot(): SessionRuntimeSnapshot {
    return {
      ...this.getMirrorSnapshot(),
      sessionId: this.sessionId,
      activeUrl: this.activeUrl,
      waitingForAddressPlan: this.waitingForAddressPlan,
      transportReady: this.transportReady,
      lastResize: this.lastResize,
      reconnectCount: this.attachState.reconnectCount,
    };
  }

  private emitSnapshot(): void {
    if (this.disposed) {
      return;
    }
    this.snapshot = this.buildSnapshot();
    for (const listener of this.snapshotListeners) {
      listener();
    }
  }

  private applyCandidateDisconnect(): 'next-candidate' | 'force-relay' | 'transport-exhausted' | 'none' {
    const action = this.addressPolicy.onCandidateDisconnected();
    if (action.type === 'next-candidate') {
      this.attachedTransportGeneration = null;
      this.transportGeneration += 1;
      this.syncAgentConnection();
      this.emitRuntimeEvent({ type: 'next-candidate', activeUrl: this.activeUrl });
      this.emitSnapshot();
      return 'next-candidate';
    }
    if (action.type === 'force-relay') {
      // Same atomic transition as attach-error fallback — policy flip, P2P
      // teardown, and relay attach all happen inside applyForceRelay.
      this.applyForceRelay();
      return 'force-relay';
    }
    if (action.type === 'transport-exhausted') {
      this.attachController.dispatch({
        type: 'TRANSPORT_EXHAUSTED',
        manualRoute: action.manualRoute,
      });
      this.emitRuntimeEvent({
        type: 'transport-exhausted',
        manualRoute: action.manualRoute,
      });
      this.emitSnapshot();
      return 'transport-exhausted';
    }
    return 'none';
  }

  private handleTerminalDisconnect(): void {
    if (this.disconnectHandling) {
      return;
    }
    this.disconnectHandling = true;
    try {
      this.onCandidateDisconnected();
    } finally {
      this.disconnectHandling = false;
    }
  }

  private teardownConnectionHandler(): void {
    this.connectionUnsub?.();
    this.connectionUnsub = null;
  }

  private teardownRelayServerHandler(): void {
    this.relayServerUnsub?.();
    this.relayServerUnsub = null;
  }

  private wireRelayServerHandler(): void {
    this.teardownRelayServerHandler();
    const conn = this.config.serverConnection;
    if (!this.config.forcedRelay || !conn || !this.config.attachInfo) {
      return;
    }

    this.relayServerUnsub = conn.onConnectionStateChange((state: ConnectionState) => {
      // Any loss of the server transport ends the server-side relay forwarding
      // loop: 'connecting' (first connect / handshake pending), 'reconnecting'
      // (recoverable intra-budget drop — the new transport surfaces this
      // distinctly), and 'disconnected' (budget exhausted or explicit
      // disconnect). The phase guard keeps this inert before the relay is live.
      if (state !== 'connected') {
        if (this.attachState.phase === 'attached') {
          const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
          this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
        }
      } else {
        // Server WS (re)established — begin (or re-begin) relay if attach is due.
        this.driveRelayAttach();
      }
    });
  }

  /**
   * Runtime-owned relay attach: begin relay when relay-capable, the viewport is
   * ready, and the attach phase is eligible. Called from updateContext,
   * applyForceRelay, the authenticated status event, and (deferred) outcome
   * transitions; phase guards make it idempotent per loss cycle.
   */
  private driveRelayAttach(): void {
    const conn = this.config.serverConnection;
    if (!conn || !this.config.attachInfo) {
      return;
    }
    if (!this.config.forcedRelay) {
      return; // P2P transport active — nothing to drive
    }
    if (!this.transportReady) {
      return; // session-first waits for the xterm viewport
    }
    const phase = this.attachState.phase;
    if (phase === 'attached' || phase === 'idle') {
      return;
    }
    if (phase === 'failed') {
      // Relay-context recovery: a failed session re-attaches through relay.
      this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    }
    if (conn.isReady()) {
      this.beginRelayOnce();
    }
  }

  private beginRelayOnce(): void {
    const conn = this.config.serverConnection;
    if (!conn || this.attachState.phase === 'attached') {
      return;
    }
    const resize = this.lastResize;
    conn.beginRelay(this.sessionId, undefined, resize?.cols, resize?.rows);
    const result = this.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  /**
   * Defer relay attach by one microtask. Outcome-driven callers run inside the
   * controller's outcome emission; dispatching RELAY_BEGIN_OK synchronously
   * would deliver the resulting 'attached' outcome to React mirrors before the
   * outcome being processed, leaving the mirror on the pre-transition phase.
   */
  private requestRelayAttach(): void {
    queueMicrotask(() => {
      if (!this.disposed) {
        this.driveRelayAttach();
      }
    });
  }

  private wireConnectionHandler(): void {
    this.teardownConnectionHandler();
    if (!this.agentWs) {
      return;
    }
    this.connectionUnsub = this.agentWs.onConnectionStateChange((next) => {
      this.emitConnectionState(next);
      if (next === 'connected') {
        this.maybeStartP2PAttach();
      } else if (
        (next === 'reconnecting' || next === 'connecting')
        && this.attachState.phase === 'attached'
      ) {
        this.attachedTransportGeneration = null;
        const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
        this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
      } else if (next === 'disconnected') {
        this.handleTerminalDisconnect();
      }
    });
  }

  /**
   * Keep or rebuild the P2P agent WebSocket.
   *
   * Rebuilds (and only rebuilds) when the agent endpoint changed — candidate
   * rotation, a manual route switch, or the first sync — or when
   * `forceReconnect` is requested. A rebuild disposes the old service and
   * constructs a fresh one bound to a fresh files plugin and terminal agent
   * API. Same-endpoint updates keep the live socket and its reconnect budget.
   *
   * Teardown order matters: the in-flight attach is canceled (epoch bump)
   * BEFORE the old service is disposed, so the disposal's router rejection of
   * the pending client.attach is a no-op instead of a spurious ATTACH_ERROR.
   */
  private syncAgentConnection(opts?: { forceReconnect?: boolean }): void {
    const url = this.addressPolicy.activeUrl;
    const token = this.config.attachInfo?.connection_token;

    if (!url || !this.config.attachInfo || this.config.forcedRelay) {
      this.teardownConnectionHandler();
      this.attachController.cancelActiveAttach();
      this.agentWs?.dispose();
      this.agentWs = null;
      this.agentTerminalApi = null;
      this.filesApi = null;
      return;
    }

    const builtUrl = buildAgentWsUrl(url, token);
    const live = this.agentWs;
    if (live && !opts?.forceReconnect && live.getUrl() === builtUrl) {
      // Same agent endpoint: keep the live socket. The reconnect budget was
      // fixed at construction; endpoint or token changes rebuild below.
      if (live.connectionState === 'connected') {
        this.maybeStartP2PAttach();
      }
      return;
    }

    this.teardownConnectionHandler();
    this.attachController.cancelActiveAttach();
    live?.dispose();
    this.agentWs = null;
    this.agentTerminalApi = null;
    this.filesApi = null;

    const files = createFilesApi();
    const ws = new WebSocketService(builtUrl, [files], {
      maxReconnectAttempts: this.addressPolicy.maxReconnectAttempts(),
    });
    this.agentWs = ws;
    this.filesApi = files;
    this.agentTerminalApi = createTerminalAgentApi(ws);
    // Fire-and-forget like the legacy client: transport failures surface via
    // onConnectionStateChange (the router rejects in-flight requests). A
    // teardown/dispose while the socket is still opening rejects this pending
    // connect — swallow so it cannot dangle as an unhandled rejection.
    void ws.connect().catch(() => {});
    this.wireConnectionHandler();
    if (ws.connectionState === 'connected') {
      this.maybeStartP2PAttach();
    }
  }
}
