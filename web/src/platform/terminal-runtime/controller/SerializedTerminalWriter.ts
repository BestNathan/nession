/**
 * FIFO adapter for one xterm instance (#1931 / #1645).
 *
 * xterm.write is asynchronous: delivering bytes into its parser queue does not
 * mean they have been applied to the buffer. In particular, an authoritative
 * resize cannot overtake output that xterm has not parsed yet.
 *
 * This deliberately owns only *ordering*, not stream identity or applied ACK.
 * Those remain separate work under #1924: no cursor can be inferred from the
 * fact that a caller entered write() or from this queue's position.
 */
export interface TerminalWriteTarget {
  write(data: string | Uint8Array, callback: () => void): void;
  resize(cols: number, rows: number): void;
}

type TerminalWriteOperation =
  | { kind: 'write'; data: string | Uint8Array; onParsed?: () => void }
  | { kind: 'resize'; cols: number; rows: number; onApplied?: () => void };

/**
 * The writer is tied to the TerminalInstance, not to its (replaceable) socket.
 * Reattaching a transport does not make old parser work disappear from xterm.
 * Dispose only when the actual xterm instance is destroyed.
 */
export class SerializedTerminalWriter {
  private readonly operations: TerminalWriteOperation[] = [];
  private parsePending = false;
  private draining = false;
  private disposed = false;

  constructor(private readonly terminal: TerminalWriteTarget) {}

  write(data: string | Uint8Array, onParsed?: () => void): void {
    if (this.disposed) { return; }
    this.operations.push({ kind: 'write', data, onParsed });
    this.drain();
  }

  resize(cols: number, rows: number, onApplied?: () => void): void {
    if (this.disposed) { return; }
    this.operations.push({ kind: 'resize', cols, rows, onApplied });
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.operations.length = 0;
    // A pending xterm parser callback is un-cancellable. It checks disposed
    // before notifying the caller or draining anything after its write.
  }

  private drain(): void {
    if (this.disposed || this.draining) { return; }
    this.draining = true;
    try {
      while (!this.disposed && !this.parsePending && this.operations.length > 0) {
        const item = this.operations.shift()!;
        if (item.kind === 'resize') {
          this.terminal.resize(item.cols, item.rows);
          // Resize is synchronous but cannot overtake the prior parser write.
          // This callback is an event-level fact, never a cumulative ACK.
          item.onApplied?.();
          continue;
        }
        this.parsePending = true;
        this.terminal.write(item.data, () => {
          if (this.disposed) { return; }
          this.parsePending = false;
          try {
            item.onParsed?.();
          } finally {
            // A synchronous callback re-enters drain() while draining=true;
            // the outer loop handles it. An async callback restarts the loop.
            this.drain();
          }
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
