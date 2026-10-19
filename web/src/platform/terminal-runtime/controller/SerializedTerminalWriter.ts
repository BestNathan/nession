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
  | { kind: 'write'; data: string | Uint8Array; onParsed?: () => void; bytes: number }
  | { kind: 'resize'; cols: number; rows: number; onApplied?: () => void; bytes: number };

export interface TerminalWriterLimits {
  /** Includes the write currently waiting for xterm's parser callback. */
  maxBytes: number;
  maxEvents: number;
  /** Parser callback deadline for an in-flight write. */
  maxParseMs: number;
}

const DEFAULT_WRITER_LIMITS: TerminalWriterLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxEvents: 512,
  maxParseMs: 30_000,
};
const RESIZE_BYTES = 128;

/** Size budget charges the JS string's worst-case UTF-16 allocation. */
function writeBytes(data: string | Uint8Array): number {
  return typeof data === 'string' ? data.length * 2 + 128 : data.byteLength + 128;
}

/**
 * The writer is tied to the TerminalInstance, not to its (replaceable) socket.
 * Reattaching a transport does not make old parser work disappear from xterm.
 * Dispose only when the actual xterm instance is destroyed.
 */
export class SerializedTerminalWriter {
  private readonly operations: TerminalWriteOperation[] = [];
  private readonly limits: TerminalWriterLimits;
  private parsePending = false;
  private draining = false;
  private disposed = false;
  private halted = false;
  private pendingBytes = 0;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly terminal: TerminalWriteTarget,
    private readonly onDegraded: (reason: 'overflow' | 'parser-stalled') => void = () => {},
    limits: Partial<TerminalWriterLimits> = {},
  ) {
    this.limits = { ...DEFAULT_WRITER_LIMITS, ...limits };
    if (Object.values(this.limits).some(v => !Number.isSafeInteger(v) || v < 1)) {
      throw new RangeError('terminal writer limits must be positive safe integers');
    }
  }

  /** Diagnostic-only accounting; this is NOT the xterm-applied cursor. */
  get pendingUsage(): { bytes: number; events: number; halted: boolean } {
    return {
      bytes: this.pendingBytes,
      events: this.operations.length + Number(this.parsePending),
      halted: this.halted,
    };
  }

  write(data: string | Uint8Array, onParsed?: () => void): void {
    this.enqueue({ kind: 'write', data, onParsed, bytes: writeBytes(data) });
  }

  resize(cols: number, rows: number, onApplied?: () => void): void {
    this.enqueue({ kind: 'resize', cols, rows, onApplied, bytes: RESIZE_BYTES });
  }

  dispose(): void {
    this.disposed = true;
    this.halted = true;
    this.operations.length = 0;
    this.pendingBytes = 0;
    if (this.deadline !== null) { clearTimeout(this.deadline); }
    this.deadline = null;
    // A pending xterm callback cannot be cancelled. It checks the halted flag
    // and does not publish the parser fact or drain anything after disposal.
  }

  private enqueue(op: TerminalWriteOperation): void {
    if (this.disposed || this.halted) { return; }
    if (this.operations.length + Number(this.parsePending) >= this.limits.maxEvents
      || this.pendingBytes + op.bytes > this.limits.maxBytes) {
      this.degrade('overflow');
      return;
    }
    this.operations.push(op);
    this.pendingBytes += op.bytes;
    this.drain();
  }

  private degrade(reason: 'overflow' | 'parser-stalled'): void {
    if (this.disposed || this.halted) { return; }
    this.halted = true;
    this.operations.length = 0;
    this.pendingBytes = 0;
    if (this.deadline !== null) { clearTimeout(this.deadline); }
    this.deadline = null;
    // Do not silently resume after a hole: only a replacement xterm/baseline
    // may resume claiming parser-applied progress.
    this.onDegraded(reason);
  }

  private drain(): void {
    if (this.disposed || this.halted || this.draining) { return; }
    this.draining = true;
    try {
      while (!this.disposed && !this.halted && !this.parsePending && this.operations.length > 0) {
        const item = this.operations.shift()!;
        if (item.kind === 'resize') {
          this.pendingBytes -= item.bytes;
          this.terminal.resize(item.cols, item.rows);
          // Resize is synchronous but cannot overtake the prior parser write.
          item.onApplied?.();
          continue;
        }
        this.parsePending = true;
        this.deadline = setTimeout(() => this.degrade('parser-stalled'), this.limits.maxParseMs);
        this.terminal.write(item.data, () => {
          if (this.disposed || this.halted) { return; }
          if (this.deadline !== null) { clearTimeout(this.deadline); }
          this.deadline = null;
          this.parsePending = false;
          this.pendingBytes -= item.bytes;
          try {
            item.onParsed?.();
          } finally {
            // Synchronous callbacks do not recursively drain; the outer FIFO
            // loop handles them. Async callbacks restart it.
            this.drain();
          }
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
