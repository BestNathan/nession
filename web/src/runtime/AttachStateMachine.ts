import type { TerminalStatus } from '@/terminal/state/session';

export const P2P_MAX_RECONNECT = 10;
export const ATTACH_TIMEOUT_MS = 10_000;

export type AttachPhase = TerminalStatus;

export type AttachEvent =
  | { type: 'SESSION_SELECTED' }
  | { type: 'TRANSPORT_READY' }
  | { type: 'TRANSPORT_LOST' }
  | { type: 'TRANSPORT_EXHAUSTED'; manualRoute: boolean }
  | { type: 'P2P_CONNECTED' }
  | { type: 'ATTACH_OK' }
  | { type: 'ATTACH_ERROR'; manualRoute: boolean }
  | { type: 'ATTACH_TIMEOUT'; manualRoute: boolean; attempt: number }
  | { type: 'RELAY_SERVER_READY' }
  | { type: 'RELAY_BEGIN_OK' }
  | { type: 'DISCONNECT' };

export interface AttachStateMachineOptions {
  transportFirst: boolean;
}

export interface AttachTransitionResult {
  phase: AttachPhase;
  reconnectCount: number;
  forceRelay: boolean;
  bumpRouteEpoch: boolean;
  /** True when an ATTACH_TIMEOUT left budget remaining — the owner should re-attach. */
  retryAttach: boolean;
}

/**
 * Pure attach phase reducer shared by session-first and legacy attach drivers.
 */
export class AttachStateMachine {
  phase: AttachPhase = 'idle';
  reconnectCount = 0;

  constructor(private readonly options: AttachStateMachineOptions) {}

  reset(): void {
    this.phase = 'idle';
    this.reconnectCount = 0;
  }

  dispatch(event: AttachEvent): AttachTransitionResult {
    const flags = { forceRelay: false, bumpRouteEpoch: false, retryAttach: false };
    this.applyEvent(event, flags);
    return {
      phase: this.phase,
      reconnectCount: this.reconnectCount,
      forceRelay: flags.forceRelay,
      bumpRouteEpoch: flags.bumpRouteEpoch,
      retryAttach: flags.retryAttach,
    };
  }

  canStartAttach(transportReady: boolean, p2pConnected: boolean, relayReady: boolean, mode: 'p2p' | 'relay'): boolean {
    if (this.phase !== 'connecting' && this.phase !== 'reconnecting' && this.phase !== 'failed') {
      return false;
    }
    if (mode === 'relay') {
      return relayReady && transportReady;
    }
    if (!p2pConnected) {
      return false;
    }
    return this.options.transportFirst ? transportReady : true;
  }

  private applyEvent(
    event: AttachEvent,
    flags: { forceRelay: boolean; bumpRouteEpoch: boolean; retryAttach: boolean },
  ): void {
    switch (event.type) {
      case 'SESSION_SELECTED':
        this.onSessionSelected();
        break;
      case 'TRANSPORT_LOST':
        this.onTransportLost();
        break;
      case 'TRANSPORT_EXHAUSTED':
        this.onTransportExhausted(event.manualRoute);
        break;
      case 'P2P_CONNECTED':
        this.onP2PConnected();
        break;
      case 'TRANSPORT_READY':
        this.onTransportReady();
        break;
      case 'RELAY_SERVER_READY':
        break;
      case 'RELAY_BEGIN_OK':
      case 'ATTACH_OK':
        this.onAttachOk();
        break;
      case 'ATTACH_ERROR':
        this.onAttachError(event.manualRoute, flags);
        break;
      case 'ATTACH_TIMEOUT':
        this.onAttachTimeout(event, flags);
        break;
      case 'DISCONNECT':
        this.onDisconnect();
        break;
    }
  }

  private onSessionSelected(): void {
    this.phase = 'connecting';
    this.reconnectCount = 0;
  }

  private onTransportLost(): void {
    if (this.phase === 'attached' || this.phase === 'connected') {
      this.phase = 'reconnecting';
    }
  }

  private onP2PConnected(): void {
    if (this.options.transportFirst) {
      return;
    }
    if (this.phase === 'connecting' || this.phase === 'reconnecting') {
      this.phase = 'connected';
    }
  }

  private onTransportReady(): void {
    if (this.phase === 'connecting' || this.phase === 'reconnecting' || this.phase === 'connected') {
      if (!this.options.transportFirst && this.phase !== 'connected') {
        this.phase = 'connected';
      }
    }
  }

  private onAttachOk(): void {
    this.phase = 'attached';
    this.reconnectCount = 0;
  }

  private onTransportExhausted(manualRoute: boolean): void {
    if (manualRoute) {
      this.phase = 'failed';
    }
  }

  private onAttachError(manualRoute: boolean, flags: { forceRelay: boolean; bumpRouteEpoch: boolean }): void {
    if (manualRoute) {
      this.phase = 'failed';
      return;
    }
    flags.forceRelay = true;
    flags.bumpRouteEpoch = true;
    this.phase = 'connecting';
  }

  private onAttachTimeout(
    event: Extract<AttachEvent, { type: 'ATTACH_TIMEOUT' }>,
    flags: { forceRelay: boolean; bumpRouteEpoch: boolean; retryAttach: boolean },
  ): void {
    this.reconnectCount = event.attempt;
    if (event.attempt > P2P_MAX_RECONNECT) {
      if (event.manualRoute) {
        this.phase = 'failed';
        return;
      }
      flags.forceRelay = true;
      flags.bumpRouteEpoch = true;
      this.phase = 'connecting';
      return;
    }
    flags.retryAttach = true;
    this.phase = this.phase === 'connecting' ? 'reconnecting' : 'connecting';
  }

  private onDisconnect(): void {
    this.phase = 'idle';
    this.reconnectCount = 0;
  }
}
