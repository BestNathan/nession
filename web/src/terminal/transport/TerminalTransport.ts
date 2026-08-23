import type { ConnectionState } from '../../hooks/useP2PConnection';

/** Abstraction over ConnectionManager so Controller never touches WebSocket/P2P details. */
export interface TerminalTransport {
  readonly mode: 'p2p' | 'relay';

  send(data: string): void;
  sendResize(cols: number, rows: number): void;
  /** Flush any input buffered before the session was attached. */
  flushInputBuffer(): void;
  /** Flush the coalesced resize buffered before the session was attached. */
  flushPendingResize(): void;
  /** Flush every outbound buffer (input + coalesced resize) in order. */
  flushAllOutbound(): void;

  onOutput: ((data: Uint8Array) => void) | null;
  onResize: ((cols: number, rows: number) => void) | null;
  onStateChange: ((state: ConnectionState) => void) | null;
  onError: ((err: Error) => void) | null;
  onDisconnect: (() => void) | null;

  dispose(): void;
}
