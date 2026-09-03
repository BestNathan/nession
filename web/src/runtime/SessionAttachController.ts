import type { P2PConnection } from '@/services/socket/p2pTypes';
import {
  ATTACH_TIMEOUT_MS,
  AttachStateMachine,
  P2P_MAX_RECONNECT,
  type AttachEvent,
  type AttachTransitionResult,
} from '@/runtime/AttachStateMachine';

let msgCounter = 0;
function generateAttachId(): string {
  return `web-${Date.now()}-${++msgCounter}`;
}

export interface AttachOutcomeListener {
  (result: AttachTransitionResult): void;
}

export interface StartP2PAttachParams {
  sessionName: string;
  p2pConnection: P2PConnection;
  manualRoute: boolean;
  lastResize: { cols: number; rows: number } | null;
  transportGeneration: number;
}

/**
 * Runtime-owned P2P attach protocol (client.attach, timeout, reconnect budget).
 * React adapters subscribe to outcomes and mirror into Jotai.
 */
export class SessionAttachController {
  private attachGeneration = 0;
  private inFlightTransportGen: number | null = null;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private messageUnsub: (() => void) | null = null;
  private readonly outcomeListeners = new Set<AttachOutcomeListener>();

  constructor(private readonly attachState: AttachStateMachine) {}

  subscribeOutcomes(listener: AttachOutcomeListener): () => void {
    this.outcomeListeners.add(listener);
    return () => {
      this.outcomeListeners.delete(listener);
    };
  }

  dispatch(event: AttachEvent): AttachTransitionResult {
    const result = this.attachState.dispatch(event);
    this.emitOutcome(result);
    return result;
  }

  reset(): void {
    this.cancelActiveAttach();
    this.attachState.reset();
  }

  startP2PAttach(params: StartP2PAttachParams): () => void {
    if (this.inFlightTransportGen === params.transportGeneration) {
      return () => {};
    }
    this.cancelActiveAttach();
    this.inFlightTransportGen = params.transportGeneration;
    const gen = ++this.attachGeneration;
    const attachId = generateAttachId();

    params.p2pConnection.sendMessage({
      msg_type: 'client.attach',
      id: attachId,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        session_name: params.sessionName,
        ...(params.lastResize
          ? { width: params.lastResize.cols, height: params.lastResize.rows }
          : {}),
      },
    });

    this.messageUnsub = params.p2pConnection.onMessage((msg) => {
      if (gen !== this.attachGeneration || msg.id !== attachId) {
        return;
      }
      if (msg.msg_type === 'ok') {
        this.inFlightTransportGen = null;
        this.dispatch({ type: 'ATTACH_OK' });
        this.cancelActiveAttach();
      } else if (msg.msg_type === 'error') {
        this.inFlightTransportGen = null;
        this.dispatch({ type: 'ATTACH_ERROR', manualRoute: params.manualRoute });
        this.cancelActiveAttach();
      }
    });

    this.attachTimer = setTimeout(() => {
      this.attachTimer = null;
      if (gen !== this.attachGeneration) {
        return;
      }
      this.cancelMessageSubscription();
      this.inFlightTransportGen = null;
      const attempt = this.attachState.reconnectCount + 1;
      this.dispatch({
        type: 'ATTACH_TIMEOUT',
        manualRoute: params.manualRoute,
        attempt,
      });
      if (this.attachState.phase !== 'failed') {
        // Retry attach on next driver tick unless failed or forced relay.
        return;
      }
    }, ATTACH_TIMEOUT_MS);

    return () => {
      if (gen === this.attachGeneration) {
        this.cancelActiveAttach();
      }
    };
  }

  cancelActiveAttach(): void {
    this.attachGeneration += 1;
    this.inFlightTransportGen = null;
    this.cancelMessageSubscription();
    if (this.attachTimer) {
      clearTimeout(this.attachTimer);
      this.attachTimer = null;
    }
  }

  get reconnectCount(): number {
    return this.attachState.reconnectCount;
  }

  get maxReconnect(): number {
    return P2P_MAX_RECONNECT;
  }

  canStartAttach(
    transportReady: boolean,
    p2pConnected: boolean,
    relayReady: boolean,
    mode: 'p2p' | 'relay',
  ): boolean {
    return this.attachState.canStartAttach(transportReady, p2pConnected, relayReady, mode);
  }

  private cancelMessageSubscription(): void {
    this.messageUnsub?.();
    this.messageUnsub = null;
  }

  private emitOutcome(result: AttachTransitionResult): void {
    for (const listener of this.outcomeListeners) {
      listener(result);
    }
  }
}
