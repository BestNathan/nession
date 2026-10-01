import type { ConnectionState } from '@/platform/socket/types';
import type { TerminalBootstrap } from '../bootstrap';

/**
 * What an attach said about the agent's input cursor (#1307).
 *
 * Both fields are optional and absence is a statement rather than a zero: an
 * agent built before the input contract states neither, and a transport that
 * cannot carry a sequence — the relay, until its merge preserves one — never
 * asks.
 */
export interface TerminalInputSeed {
  inputEpoch?: number;
  appliedThrough?: number;
  controlGeneration?: number;
}

/** Abstraction over ConnectionManager so Controller never touches WebSocket/P2P details. */
export interface TerminalTransport {
  readonly mode: 'p2p' | 'relay';

  send(data: string): void;
  sendResize(cols: number, rows: number): void;
  /** Seed stream timeline after P2P attach (#1094). Optional on transports without seq. */
  seedStreamCursor?(streamEpoch: number | undefined, streamCursor: number | undefined): void;
  /**
   * Reconcile the input cursor against the attach reply (#1307).
   *
   * Optional and separate from `seedStreamCursor` because the two travel on
   * different paths: the output timeline has a resume of its own, and the input
   * cursor is stated by the attach itself.
   */
  seedInputCursor?(seed: TerminalInputSeed | undefined): void;
  /** Flush any input waiting for the session to be attached. */
  flushInputBuffer(): void;
  /** Flush the coalesced resize buffered before the session was attached. */
  flushPendingResize(): void;
  /** Flush every outbound buffer (input + coalesced resize) in order. */
  flushAllOutbound(): void;

  /**
   * Bytes from the agent. `bootstrap` is present when they are the session's
   * **history** rather than its live output (#321): a bootstrap replaces the
   * consumer's buffer, live output appends to it. Absent means append — which
   * is what every frame meant before the marker existed, and what a replay from
   * `agent.terminal.stream.resume` still means (a bootstrap is deliberately not
   * recorded in the stream timeline).
   *
   * The marker carries what the agent said about the snapshot, because a
   * truncated one is not a history the consumer may replace its buffer with
   * (#1305) — see {@link TerminalBootstrap}.
   */
  onOutput: ((data: Uint8Array, bootstrap?: TerminalBootstrap) => void) | null;
  onResize: ((cols: number, rows: number) => void) | null;
  onStateChange: ((state: ConnectionState) => void) | null;
  onError: ((err: Error) => void) | null;
  onDisconnect: (() => void) | null;

  dispose(): void;
}
