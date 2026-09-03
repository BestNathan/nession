import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';
import { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import { createP2PConnectionAdapter } from '@/services/socket/P2PConnectionAdapter';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import { AddressAttachPolicy } from '@/runtime/AddressAttachPolicy';
import { AttachStateMachine } from '@/runtime/AttachStateMachine';
import { FileCapability } from '@/runtime/FileCapability';

export interface SessionRuntimeConfig {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  addressPlan: AddressPlan;
  transportFirst: boolean;
  routeEpoch: number;
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly attachState: AttachStateMachine;
  private addressPolicy: AddressAttachPolicy;
  private agentClient: AgentSocketClient | null = null;
  private p2pAdapter: P2PConnection | null = null;
  private fileCapability: FileCapability | null = null;
  private routeEpoch: number;

  constructor(private config: SessionRuntimeConfig) {
    this.sessionId = config.sessionId;
    this.routeEpoch = config.routeEpoch;
    this.attachState = new AttachStateMachine({ transportFirst: config.transportFirst });
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

  getP2PConnection(): P2PConnection | null {
    return this.p2pAdapter;
  }

  getFileCapability(): FileCapability | null {
    return this.fileCapability;
  }

  updateContext(next: Partial<SessionRuntimeConfig>): void {
    const routeChanged = next.routeEpoch !== undefined && next.routeEpoch !== this.routeEpoch;
    this.config = { ...this.config, ...next };
    if (next.routeEpoch !== undefined) {
      this.routeEpoch = next.routeEpoch;
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

  onCandidateDisconnected(): 'next-candidate' | 'force-relay' | 'none' {
    const action = this.addressPolicy.onCandidateDisconnected();
    if (action.type === 'next-candidate' || action.type === 'force-relay') {
      this.syncAgentClient();
    }
    return action.type === 'none' ? 'none' : action.type;
  }

  subscribeConnectionState(handler: (state: import('@/services/socket/types').ConnectionState) => void): () => void {
    if (!this.agentClient) {
      return () => {};
    }
    return this.agentClient.onConnectionStateChange(handler);
  }

  dispose(): void {
    this.agentClient?.dispose();
    this.agentClient = null;
    this.p2pAdapter = null;
    this.fileCapability = null;
  }

  private syncAgentClient(): void {
    const url = this.addressPolicy.activeUrl;
    const token = this.config.attachInfo?.connection_token;

    if (!url || !this.config.attachInfo) {
      this.agentClient?.dispose();
      this.agentClient = null;
      this.p2pAdapter = null;
      this.fileCapability = null;
      return;
    }

    const maxAttempts = this.addressPolicy.maxReconnectAttempts();

    if (!this.agentClient) {
      this.agentClient = new AgentSocketClient({
        agentUrl: url,
        connectionToken: token,
        maxReconnectAttempts: maxAttempts,
      });
      this.agentClient.connect();
    } else {
      this.agentClient.configure({
        agentUrl: url,
        connectionToken: token,
        maxReconnectAttempts: maxAttempts,
      });
    }

    this.p2pAdapter = createP2PConnectionAdapter(this.agentClient);
    this.fileCapability = new FileCapability(this.agentClient);
  }
}
