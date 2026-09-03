import type { AttachInfo, ConnectionStatus } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';
import type { RelayServerConnection } from '@/runtime/relayServerConnection';
import { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import { createP2PConnectionAdapter } from '@/services/socket/P2PConnectionAdapter';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { ConnectionState } from '@/services/socket/types';
import { AddressAttachPolicy } from '@/runtime/AddressAttachPolicy';
import { AttachStateMachine, type AttachPhase, type AttachTransitionResult } from '@/runtime/AttachStateMachine';
import { FileCapability } from '@/runtime/FileCapability';
import { SessionAttachController } from '@/runtime/SessionAttachController';

export interface SessionRuntimeConfig {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  addressPlan: AddressPlan;
  transportFirst: boolean;
  /** User-initiated route identity (manual switch); resets candidate index when changed. */
  routeIntentEpoch: number;
  lastResize?: { cols: number; rows: number } | null;
  transportReady?: boolean;
  /** Relay-mode server WebSocket — runtime re-begins relay after server reconnect. */
  serverConnection?: RelayServerConnection | null;
}

export interface RuntimeMirrorSnapshot {
  phase: AttachPhase;
  transportGeneration: number;
  connectionState: ConnectionState;
  p2pConnection: P2PConnection | null;
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
  private agentClient: AgentSocketClient | null = null;
  private p2pAdapter: P2PConnection | null = null;
  private fileCapability: FileCapability | null = null;
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

  constructor(private config: SessionRuntimeConfig) {
    this.sessionId = config.sessionId;
    this.routeIntentEpoch = config.routeIntentEpoch;
    this.attachState = new AttachStateMachine({ transportFirst: config.transportFirst });
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
    });
    this.syncAgentClient();
    this.wireRelayServerHandler();
    this.driveRelayAttach();
  }

  get transportFirstMode(): boolean {
    return this.config.transportFirst;
  }

  getMirrorSnapshot(): RuntimeMirrorSnapshot {
    return {
      phase: this.attachState.phase,
      transportGeneration: this.transportGeneration,
      connectionState: this.agentClient?.connectionState ?? 'disconnected',
      p2pConnection: this.config.forcedRelay ? null : this.p2pAdapter,
    };
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

  getP2PConnection(): P2PConnection | null {
    return this.p2pAdapter;
  }

  getFileCapability(): FileCapability | null {
    return this.fileCapability;
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
      return this.getMirrorSnapshot();
    }

    this.syncAgentClient();
    this.wireRelayServerHandler();
    if (!prevTransportReady && this.transportReady) {
      this.maybeStartP2PAttach();
    }
    // A relay attach may be due now: forced-relay context just applied, or the
    // xterm viewport became ready while relay attach was pending.
    this.driveRelayAttach();
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
    this.syncAgentClient();
    this.wireRelayServerHandler();
    this.emitRuntimeEvent({ type: 'force-relay' });
    // The P2P → relay transport flip is complete; relay attach follows in the
    // same tick unless the server WS is not authenticated yet.
    this.requestRelayAttach();
  }

  private handleRouteIntentChange(): void {
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.attachController.dispatch({ type: 'DISCONNECT' });
    const result = this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.transportGeneration += 1;
    this.syncAgentClient({ forceReconnect: true });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  private maybeStartP2PAttach(): void {
    // Legacy TerminalWorkspace (transportFirst: false) owns client.attach via
    // useTerminalStateMachine — runtime only manages the socket here.
    if (!this.config.transportFirst) {
      return;
    }
    if (this.config.forcedRelay || !this.p2pAdapter) {
      return;
    }
    if (this.p2pAdapter.connectionState !== 'connected') {
      return;
    }
    const phase = this.attachState.phase;
    if (phase === 'attached' && this.attachedTransportGeneration === this.transportGeneration) {
      return;
    }
    if (phase === 'idle' || phase === 'failed') {
      return;
    }
    const ready = this.config.transportFirst ? this.transportReady : true;
    if (!this.attachController.canStartAttach(ready, true, false, 'p2p')) {
      return;
    }
    this.attachController.startP2PAttach({
      sessionName: this.config.sessionName,
      p2pConnection: this.p2pAdapter,
      manualRoute: this.config.manualOverride !== null,
      lastResize: this.lastResize,
      transportGeneration: this.transportGeneration,
    });
  }

  /** @deprecated Prefer internal handler; kept for unit tests. */
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
    this.agentClient?.dispose();
    this.agentClient = null;
    this.p2pAdapter = null;
    this.fileCapability = null;
    this.connectionStateListeners.clear();
    this.runtimeEventListeners.clear();
  }

  private emitConnectionState(state: ConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      listener(state);
    }
  }

  private emitRuntimeEvent(event: SessionRuntimeEvent): void {
    for (const listener of this.runtimeEventListeners) {
      listener(event);
    }
  }

  private applyCandidateDisconnect(): 'next-candidate' | 'force-relay' | 'transport-exhausted' | 'none' {
    const action = this.addressPolicy.onCandidateDisconnected();
    if (action.type === 'next-candidate') {
      this.attachedTransportGeneration = null;
      this.transportGeneration += 1;
      this.syncAgentClient();
      this.emitRuntimeEvent({ type: 'next-candidate', activeUrl: this.activeUrl });
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

    this.relayServerUnsub = conn.onConnectionChange((status: ConnectionStatus) => {
      // Recoverable loss is authenticated -> connecting (server core stays in
      // 'connecting' through its intra-budget reconnect; 'disconnected' only
      // fires once the budget is exhausted or on explicit disconnect). Either
      // ends the server-side relay forwarding loop.
      if (status === 'connecting' || status === 'disconnected') {
        if (this.attachState.phase === 'attached') {
          const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
          this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
        }
      } else if (status === 'authenticated') {
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
    if (!this.config.transportFirst) {
      return; // legacy React driver owns relay attach
    }
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
    if (conn.isAuthenticated()) {
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
    if (!this.agentClient) {
      return;
    }
    this.connectionUnsub = this.agentClient.onConnectionStateChange((next) => {
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

  private syncAgentClient(opts?: { forceReconnect?: boolean }): void {
    const url = this.addressPolicy.activeUrl;
    const token = this.config.attachInfo?.connection_token;

    if (!url || !this.config.attachInfo || this.config.forcedRelay) {
      this.teardownConnectionHandler();
      this.agentClient?.dispose();
      this.agentClient = null;
      this.p2pAdapter = null;
      this.fileCapability = null;
      return;
    }

    const maxAttempts = this.addressPolicy.maxReconnectAttempts();
    const isNewClient = !this.agentClient;

    if (isNewClient) {
      const client = new AgentSocketClient({
        agentUrl: url,
        connectionToken: token,
        maxReconnectAttempts: maxAttempts,
      });
      this.agentClient = client;
      client.connect();
      this.wireConnectionHandler();
    } else {
      const rebuilt = this.agentClient!.configure({
        agentUrl: url,
        connectionToken: token,
        maxReconnectAttempts: maxAttempts,
      });
      if (opts?.forceReconnect && !rebuilt) {
        this.agentClient!.forceReconnect();
      }
    }

    const client = this.agentClient;
    if (!client) {
      return;
    }
    this.p2pAdapter = createP2PConnectionAdapter(client);
    this.fileCapability = new FileCapability(client);
    if (client.connectionState === 'connected') {
      this.maybeStartP2PAttach();
    }
  }
}
