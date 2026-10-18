import type { TerminalStreamPosition } from './streamApply';

/**
 * A verified baseline is a *prerequisite*, never inferred from first arrival.
 * A transport attach, tmux capture with an unverified stream cut, or a cursor
 * delivered by WebSocket is NOT by itself an eligible baseline (#1645).
 *
 * Callers must establish this from a known-empty renderer at epoch start or
 * an independently proven checkpoint/replay cut. The type makes that explicit
 * at the API boundary; it cannot itself prove the external checkpoint.
 */
export interface VerifiedTerminalBaseline {
  kind: 'verified';
  streamEpoch: number;
  appliedThrough: number;
}

export interface AppliedCursorBinding {
  /** Locally incremented nonce: stale writer callbacks must carry the old one. */
  generation: number;
  streamEpoch: number;
}

export type ParseOutcome = 'advanced' | 'buffered' | 'duplicate' | 'stale' | 'invalid';

export interface AppliedCursorSnapshot {
  streamEpoch: number;
  generation: number;
  appliedSeq: number;
  /** Explicitly submitted ACK position, not a message queued for sending. */
  ackSentSeq: number;
}

/**
 * Pure bounded accumulator of *parser-completed* Agent events. Never call it
 * when a frame is received, enqueued or handed to terminal.write. In
 * particular, this must never be seeded from the StreamReconciler sink
 * delivery frontier or an ordinary unverified tmux bootstrap.
 *
 * This does not send ACK or provide an actual terminal checkpoint.
 */
export class AppliedTerminalCursor {
  private generation = 0;
  private epoch: number | null = null;
  private applied: number | null = null;
  private ackSent = 0;
  private invalid = false;
  private readonly pending = new Set<number>();

  constructor(private readonly maxPending = 1024) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new RangeError('maxPending must be a positive safe integer');
    }
  }

  /** Invalidate all outstanding parser callbacks, even for the same epoch. */
  reset(): void {
    this.generation += 1;
    this.epoch = null;
    this.applied = null;
    this.ackSent = 0;
    this.invalid = false;
    this.pending.clear();
  }

  beginFromVerifiedBaseline(baseline: VerifiedTerminalBaseline): AppliedCursorBinding {
    if (baseline.kind !== 'verified'
      || !validSeq(baseline.streamEpoch, false)
      || !validSeq(baseline.appliedThrough, true)) {
      throw new RangeError('a valid verified Terminal stream baseline is required');
    }
    this.reset();
    this.epoch = baseline.streamEpoch;
    this.applied = baseline.appliedThrough;
    return { generation: this.generation, streamEpoch: baseline.streamEpoch };
  }

  /** A cursor exists only while the same binding's continuity proof holds. */
  snapshot(binding: AppliedCursorBinding): AppliedCursorSnapshot | null {
    if (!this.active(binding)) return null;
    return {
      streamEpoch: this.epoch!,
      generation: this.generation,
      appliedSeq: this.applied!,
      ackSentSeq: this.ackSent,
    };
  }

  recordParsed(binding: AppliedCursorBinding, position: TerminalStreamPosition): ParseOutcome {
    if (!this.active(binding)) return 'stale';
    if (!validSeq(position.streamEpoch, false)
      || !validSeq(position.streamSeq, false)
      || position.streamEpoch !== this.epoch) {
      this.invalidate();
      return 'invalid';
    }

    const seq = position.streamSeq;
    if (seq <= this.applied! || this.pending.has(seq)) return 'duplicate';

    if (seq === this.applied! + 1) {
      this.applied = seq;
      // A completed event at N does not cover N-1 unless N-1 was proved.
      while (this.pending.delete(this.applied + 1)) this.applied += 1;
      return 'advanced';
    }

    if (this.pending.size >= this.maxPending) {
      this.invalidate();
      return 'invalid';
    }
    this.pending.add(seq);
    return 'buffered';
  }

  /**
   * Record only an ACK actually sent using the confirmed parsed frontier.
   * Calling this must not itself transmit anything or mark a received frame
   * parsed. An ACK from a retired subscription/renderer is ignored.
   */
  recordAckSubmitted(binding: AppliedCursorBinding, seq: number): boolean {
    if (!this.active(binding)
      || !validSeq(seq, true)
      || seq > this.applied!
      || seq < this.ackSent) return false;
    this.ackSent = seq;
    return true;
  }

  private active(binding: AppliedCursorBinding): boolean {
    return !this.invalid
      && this.epoch !== null
      && this.applied !== null
      && binding.generation === this.generation
      && binding.streamEpoch === this.epoch;
  }

  private invalidate(): void {
    this.invalid = true;
    this.pending.clear();
  }
}

function validSeq(value: number, allowZero: boolean): boolean {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}
