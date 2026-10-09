import type { TerminalStatus } from '@/product/terminal/state/session';

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
  /** True when an ATTACH_TIMEOUT left budget remaining — the owner should re-attach. */
  retryAttach: boolean;
}

/**
 * Pure attach phase reducer shared by shell and legacy attach drivers.
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
    const flags = { forceRelay: false, retryAttach: false };
    this.applyEvent(event, flags);
    return {
      phase: this.phase,
      reconnectCount: this.reconnectCount,
      forceRelay: flags.forceRelay,
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
    flags: { forceRelay: boolean; retryAttach: boolean },
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

  /**
   * `failed` is not a one-way door, and a transport that connects is proof that
   * the failure it records is over: a pinned route that was reported exhausted
   * and then came back shows the recovery instead of an "Attach failed" the
   * connection has already outlived. `canStartAttach` has always accepted
   * `failed`, so the attach that follows lands in `attached` as usual.
   */
  private onP2PConnected(): void {
    if (this.options.transportFirst) {
      return;
    }
    if (this.phase === 'connecting' || this.phase === 'reconnecting' || this.phase === 'failed') {
      this.phase = 'connected';
    }
  }

  private onTransportReady(): void {
    if (
      this.phase === 'connecting'
      || this.phase === 'reconnecting'
      || this.phase === 'connected'
      || this.phase === 'failed'
    ) {
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

  private onAttachError(manualRoute: boolean, flags: { forceRelay: boolean }): void {
    if (manualRoute) {
      this.phase = 'failed';
      return;
    }
    flags.forceRelay = true;
    this.phase = 'connecting';
  }

  private onAttachTimeout(
    event: Extract<AttachEvent, { type: 'ATTACH_TIMEOUT' }>,
    flags: { forceRelay: boolean; retryAttach: boolean },
  ): void {
    this.reconnectCount = event.attempt;
    if (event.attempt > P2P_MAX_RECONNECT) {
      if (event.manualRoute) {
        this.phase = 'failed';
        return;
      }
      flags.forceRelay = true;
      this.phase = 'connecting';
      return;
    }
    flags.retryAttach = true;
    // Stable, not alternating (#1309 SC-07): the retry is driven by the
    // retryAttach flag and the attempt number rides reconnectCount, so the
    // connecting ↔ reconnecting toggle only re-fired mirrors — and made the
    // reconnect banner flicker every other attempt.
    this.phase = 'reconnecting';
  }

  private onDisconnect(): void {
    this.phase = 'idle';
    this.reconnectCount = 0;
  }
}
