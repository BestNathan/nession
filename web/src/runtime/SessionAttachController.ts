import {
  ATTACH_TIMEOUT_MS,
  AttachStateMachine,
  P2P_MAX_RECONNECT,
  type AttachEvent,
  type AttachTransitionResult,
} from '@/runtime/AttachStateMachine';
import type { TerminalAgentApi } from '@/features/terminal';

/** Listeners receive every attach outcome the state machine produces. */
export type AttachOutcomeListener = (result: AttachTransitionResult) => void;

export interface StartP2PAttachParams {
  sessionName: string;
  /** The live P2P terminal API of the current transport. */
  agentApi: TerminalAgentApi;
  manualRoute: boolean;
  lastResize: { cols: number; rows: number } | null;
  transportGeneration: number;
}

/**
 * Attach resolutions that mean "the agent never got (or never answered) the
 * attach" — transport-level failure surfaces of the WebSocket service and its
 * message router. Legacy had no per-attach transport signal: a dropped socket
 * left the attach unanswered until the controller timer fired, so every one of
 * these converges to the legacy timer's outcome (ATTACH_TIMEOUT with the
 * reconnect-budget attempt). Only a genuine agent error ack (prose in the
 * resolved error, and never a transport string) dispatches ATTACH_ERROR.
 */
const TRANSPORT_FAILURE_ERRORS: ReadonlySet<string> = new Set([
  'Connection lost',
  'MessageRouter disposed',
  'WebSocketService disposed',
  'WebSocket not connected',
  'Connection timeout',
  'WebSocket connection failed',
  'WebSocketService is closed',
]);

export class SessionAttachController {
  /** Bumped by cancel/supersede; guards late attach resolutions from firing. */
  private attachGeneration = 0;
  /** Transport generation of the attach currently in flight, if any. */
  private inFlightTransportGen: number | null = null;
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

  /**
   * Send a client.attach request through the agent API. Never throws and never
   * rejects: the feature API converges transport failures into
   * `{ ok: false, error }`, and the request timeout is the feature's own
   * `timeoutMs` budget, surfaced as the `'timeout'` error.
   *
   * Resolution outcomes (epoch-guarded — a late resolution after a cancel or
   * supersede is a no-op):
   * - ok → ATTACH_OK, then cancel (the runtime marks the transport attached).
   * - error in the transport-failure set (incl. 'timeout') → ATTACH_TIMEOUT
   *   with the reconnect-budget attempt; the runtime retries until the budget
   *   is exhausted (then force-relays or fails), so no explicit cancel here —
   *   a retry path supersedes via cancelActiveAttach inside startP2PAttach.
   * - any other prose (a genuine agent error ack) → ATTACH_ERROR; the runtime
   *   force-relays (auto route) or fails (manual route), and the in-flight
   *   attach is canceled.
   */
  startP2PAttach(params: StartP2PAttachParams): () => void {
    if (this.inFlightTransportGen === params.transportGeneration) {
      // Same transport already has an attach in flight — dedupe (the runtime
      // re-drives attach on every 'connected' re-entry and context update).
      return () => {};
    }
    this.cancelActiveAttach();
    this.inFlightTransportGen = params.transportGeneration;
    const gen = ++this.attachGeneration;

    void params.agentApi
      .attach(params.sessionName, params.lastResize ?? undefined, {
        timeoutMs: ATTACH_TIMEOUT_MS,
      })
      .then((result) => {
        if (gen !== this.attachGeneration) {
          // Canceled or superseded while in flight — the late resolution is a
          // no-op (the dispose-time router rejection on teardown lands here).
          return;
        }
        this.inFlightTransportGen = null;
        if (result.ok) {
          this.dispatch({ type: 'ATTACH_OK' });
          this.cancelActiveAttach();
          return;
        }
        if (result.error === 'timeout' || TRANSPORT_FAILURE_ERRORS.has(result.error)) {
          this.dispatch({
            type: 'ATTACH_TIMEOUT',
            manualRoute: params.manualRoute,
            attempt: this.attachState.reconnectCount + 1,
          });
          return;
        }
        // Genuine agent error ack: the agent owns the session and refused the
        // attach. The runtime routes it (force-relay auto / fail manual).
        this.dispatch({ type: 'ATTACH_ERROR', manualRoute: params.manualRoute });
        this.cancelActiveAttach();
      });

    return () => {
      if (gen === this.attachGeneration) {
        this.cancelActiveAttach();
      }
    };
  }

  cancelActiveAttach(): void {
    this.attachGeneration += 1;
    this.inFlightTransportGen = null;
  }

  get reconnectCount(): number {
    return this.attachState.reconnectCount;
  }

  get maxReconnect(): number {
    return P2P_MAX_RECONNECT;
  }

  canStartAttach(
    transportReady: boolean,
    attachEnabled: boolean,
    transportActive: boolean,
    mode: 'p2p' | 'relay',
  ): boolean {
    return this.attachState.canStartAttach(
      transportReady,
      attachEnabled,
      transportActive,
      mode,
    );
  }

  private emitOutcome(result: AttachTransitionResult): void {
    for (const listener of this.outcomeListeners) {
      listener(result);
    }
  }
}
