import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';
import { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import { createP2PConnectionAdapter } from '@/services/socket/P2PConnectionAdapter';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { ConnectionState } from '@/services/socket/types';
import { AddressAttachPolicy } from '@/runtime/AddressAttachPolicy';
import { AttachStateMachine } from '@/runtime/AttachStateMachine';
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
}

export type SessionRuntimeEvent =
  | { type: 'next-candidate'; activeUrl: string | null }
  | { type: 'force-relay' };

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
  private connectionUnsub: (() => void) | null = null;
  private readonly connectionStateListeners = new Set<(state: ConnectionState) => void>();
  private readonly runtimeEventListeners = new Set<(event: SessionRuntimeEvent) => void>();
  /** Guards against re-entrant / duplicate terminal-disconnect handling. */
  private disconnectHandling = false;

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
    this.syncAgentClient();
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

  updateContext(next: Partial<SessionRuntimeConfig>): void {
    const routeChanged =
      next.routeIntentEpoch !== undefined
      && next.routeIntentEpoch !== this.routeIntentEpoch;
    this.config = { ...this.config, ...next };
    if (next.routeIntentEpoch !== undefined) {
      this.routeIntentEpoch = next.routeIntentEpoch;
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
    }

    this.syncAgentClient();
  }

  /** @deprecated Prefer internal handler; kept for unit tests. */
  onCandidateDisconnected(): 'next-candidate' | 'force-relay' | 'none' {
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

  private applyCandidateDisconnect(): 'next-candidate' | 'force-relay' | 'none' {
    const action = this.addressPolicy.onCandidateDisconnected();
    if (action.type === 'next-candidate') {
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

  private wireConnectionHandler(): void {
    this.teardownConnectionHandler();
    if (!this.agentClient) {
      return;
    }
    this.connectionUnsub = this.agentClient.onConnectionStateChange((next) => {
      this.emitConnectionState(next);
      if (next === 'disconnected') {
        this.handleTerminalDisconnect();
      }
    });
  }

  private syncAgentClient(): void {
    const url = this.addressPolicy.activeUrl;
    const token = this.config.attachInfo?.connection_token;

    if (!url || !this.config.attachInfo) {
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
      this.agentClient!.configure({
        agentUrl: url,
        connectionToken: token,
        maxReconnectAttempts: maxAttempts,
      });
    }

    const client = this.agentClient;
    if (!client) {
      return;
    }
    this.p2pAdapter = createP2PConnectionAdapter(client);
    this.fileCapability = new FileCapability(client);
  }
}
