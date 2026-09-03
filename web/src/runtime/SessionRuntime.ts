import type { AttachInfo, ConnectionStatus } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';
import type { WebSocketService } from '@/services/websocket';
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
  serverConnection?: WebSocketService | null;
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
  private relayNeedsRebegin = false;

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
      }
      for (const listener of this.attachOutcomeListeners) {
        listener(result);
      }
    });
    this.syncAgentClient();
    this.wireRelayServerHandler();
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
    return this.getMirrorSnapshot();
  }

  private applyForceRelay(): void {
    if (this.config.forcedRelay) {
      return;
    }
    this.config = { ...this.config, forcedRelay: true };
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.transportGeneration += 1;
    this.syncAgentClient();
    this.wireRelayServerHandler();
    this.emitRuntimeEvent({ type: 'force-relay' });
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
      this.transportGeneration += 1;
      this.emitRuntimeEvent({ type: 'force-relay' });
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
      if (status === 'disconnected') {
        if (this.attachState.phase === 'attached') {
          this.relayNeedsRebegin = true;
          const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
          this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
        }
      } else if (status === 'authenticated' && this.relayNeedsRebegin) {
        this.relayNeedsRebegin = false;
        const resize = this.lastResize;
        conn.beginRelay(
          this.sessionId,
          undefined,
          resize?.cols,
          resize?.rows,
        );
        const result = this.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
        this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
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
