/**
 * The client's half of sequenced input delivery (#1307): what a user has typed
 * that the PTY has not confirmed.
 *
 * React-free and transport-free on purpose. Everything here is a decision about
 * *bytes and a cursor*, and none of it needs a socket to be tested — which
 * matters, because the decisions are the part that has to be right and a
 * decision reachable only through a reconnect is a decision reachable only in
 * production.
 *
 * ## The one invariant
 *
 * The queue is a **contiguous run above the cursor**: `pending[i]` is chunk
 * `cursor + 1 + i`, and that is derived rather than stored.
 *
 * Deriving the sequence number is what makes renumbering impossible. The agent
 * applies only the chunk that continues its cursor, so a queue whose front no
 * longer continues it can never deliver anything again — the agent refuses, the
 * cursor never moves, and every later frame is refused too. A stored number
 * would let a local edit (drop a chunk, reorder, expire the oldest) quietly
 * produce that state. A derived one cannot: dropping the acked prefix moves the
 * cursor by exactly the number of chunks dropped, so every surviving chunk
 * keeps the position it was sent with.
 *
 * ## What that means for the bounds
 *
 * It also decides what "bounded" is allowed to do, and the answer is more
 * constrained than it looks:
 *
 * * **Dropping from the front is unsound.** The oldest chunk carries position
 *   `cursor + 1`; removing it leaves the front at `cursor + 2`, which the agent
 *   refuses as a gap — so the bound would convert "the user typed a lot" into
 *   "no input can ever be delivered again". A bound that bricks the session is
 *   worse than the memory it saves.
 * * **So the queue is bounded by refusing new input, not by evicting old.** At
 *   a bound the user's *newest* keystrokes are refused and what was already
 *   pending is kept — the reverse of a ring buffer, and deliberate: what is
 *   already pending is a contiguous run the agent can still apply, and what is
 *   refused was never sent, so nothing is left inconsistent.
 * * **Expiry is all-or-nothing**, and that is a property of the same rule
 *   rather than a simplification: the chunk that ages out first is the front
 *   one, and the front one cannot go alone. So a queue with any chunk older
 *   than the TTL is discarded whole.
 *
 * The single exception to "refuse when full" is a queue that is *empty*: one
 * chunk always fits, whatever its size. A paste is one chunk, and refusing it
 * because the paste is larger than the byte bound would be refusing exactly the
 * case the bound exists to permit (the requirement says as much — bounds must
 * not assume one keystroke per event).
 *
 * ## What a drop is
 *
 * Every refusal and every discard is recorded rather than swallowed, because
 * the requirement's answer to "input could not be delivered" is an explicit
 * state rather than silence. This module records *what happened*; deciding what
 * the user is told about it is the layer above (#1307 SC-09).
 */

/** Which session's input this is, and the generations it belongs to. */
export interface InputIdentity {
  sessionName: string;
  /**
   * The agent's input epoch. A different value means a different agent process
   * holds the cursor, so nothing pending here can be proven applied or proven
   * unapplied — see {@link InputDropReason}.
   */
  inputEpoch: number;
  /**
   * The control generation this input was typed under. A different one means
   * the lease moved to another client (#1095), and input the previous
   * controller never got applied must not arrive under the new one's (#1307
   * SC-08).
   */
  controlGeneration?: number;
}

export interface InputQueueBounds {
  /** Chunks that may wait at once. */
  maxChunks: number;
  /** Bytes that may wait at once. */
  maxBytes: number;
  /** How long a chunk stays deliverable, measured from when it arrived. */
  maxAgeMs: number;
}

/** Why input that the user typed will not be delivered. */
export type InputDropReason =
  /** A bound refused it: the queue was already holding this much. */
  | 'bound'
  /** It waited longer than the TTL. */
  | 'age'
  /** The agent's input epoch moved, so the cursor it was numbered against is gone. */
  | 'epoch'
  /** The control lease moved to another client. */
  | 'generation';

export interface InputDrop {
  reason: InputDropReason;
  /** How many chunks were lost by this event. */
  chunks: number;
  at: number;
}

interface Chunk {
  data: string;
  bytes: number;
  at: number;
}

export class PendingInputQueue {
  private readonly bounds: InputQueueBounds;
  private readonly now: () => number;
  private chunks: Chunk[] = [];
  private bytes = 0;
  private identity: InputIdentity | null = null;
  /**
   * The last cursor the agent stated, from an attach reply or an
   * acknowledgement. `pending[i]` is chunk `cursor + 1 + i`.
   */
  private cursor = 0;
  private drop: InputDrop | null = null;
  private dropped = 0;
  /**
   * Told when input is lost, at the moment it is lost (#1307 SC-09).
   *
   * `lastDrop` cannot serve this on its own: it says what the most recent loss
   * was, not that there has been one since the reader last looked, so a reader
   * polling it either repeats itself or misses a loss between two polls. The
   * layer that shows the user a loss needs the edge, and this is the edge.
   */
  onDrop: ((drop: InputDrop) => void) | null = null;

  constructor(bounds: InputQueueBounds, now: () => number = () => Date.now()) {
    this.bounds = bounds;
    this.now = now;
  }

  /** Chunks waiting. */
  get size(): number {
    return this.chunks.length;
  }

  /** Bytes waiting. */
  get byteLength(): number {
    return this.bytes;
  }

  /** The identity this queue is bound to, or `null` before the first attach. */
  get boundTo(): InputIdentity | null {
    return this.identity;
  }

  /** The highest chunk the agent has stated as applied. */
  get appliedThrough(): number {
    return this.cursor;
  }

  /** The most recent loss, or `null` if nothing has been lost. */
  get lastDrop(): InputDrop | null {
    return this.drop;
  }

  /** How many chunks have been lost in total. */
  get droppedChunks(): number {
    return this.dropped;
  }

  /** True once the queue has an epoch to number its input against. */
  get isBound(): boolean {
    return this.identity !== null;
  }

  /**
   * Take the identity the agent stated, and reconcile against its cursor.
   *
   * `appliedThrough` is what the agent said its cursor was, and passing it is
   * what makes an attach a **reconcile** rather than a mere re-bind: the chunks
   * at or below it are dropped as applied, and everything above it stays for a
   * retry. Omitting it — which the control-lease path does, because a lease
   * change states no position — leaves the cursor where it was.
   *
   * Returns what changed, because the caller's next move depends on it: an
   * epoch change invalidates the queue (nothing in it can be proven either
   * way), a generation change invalidates it for a different reason (the lease
   * is not ours any more), and a plain re-bind keeps every chunk above the
   * stated cursor, which is the whole point of having numbered them.
   */
  reconcile(
    identity: InputIdentity,
    appliedThrough?: number,
  ): 'bound' | 'epoch-changed' | 'generation-changed' {
    const previous = this.identity;
    let verdict: 'bound' | 'epoch-changed' | 'generation-changed' = 'bound';
    if (previous && previous.inputEpoch !== identity.inputEpoch) {
      this.clear('epoch');
      // A new epoch's positions are its own, so the old cursor says nothing
      // about them and the statement below is the only one that counts.
      this.cursor = 0;
      verdict = 'epoch-changed';
    } else if (
      previous &&
      previous.controlGeneration !== undefined &&
      identity.controlGeneration !== undefined &&
      previous.controlGeneration !== identity.controlGeneration
    ) {
      this.clear('generation');
      verdict = 'generation-changed';
    }
    this.identity = identity;
    if (appliedThrough !== undefined) {
      this.acknowledge(identity.inputEpoch, appliedThrough);
    }
    return verdict;
  }

  /** Apply a cursor the agent restated without changing the identity. */
  acknowledge(epoch: number, appliedThrough: number): void {
    // An acknowledgement for another epoch is not this queue's; the agent says
    // which epoch it is talking about precisely so this can be ignored rather
    // than applied to the wrong run.
    if (this.identity && this.identity.inputEpoch !== epoch) {
      return;
    }
    if (appliedThrough <= this.cursor) {
      return;
    }
    const covered = Math.min(appliedThrough - this.cursor, this.chunks.length);
    this.dropPrefix(covered);
    this.cursor = appliedThrough;
  }

  /**
   * Accept one chunk of user input.
   *
   * `false` means it was refused at a bound — the caller has nothing to send
   * and the user has lost that input, which is why the refusal is recorded
   * rather than returned as a bare boolean.
   */
  accept(data: string): boolean {
    if (data.length === 0) {
      return true;
    }
    this.expire();
    const bytes = utf8ByteLength(data);
    const full =
      this.chunks.length > 0 &&
      (this.chunks.length + 1 > this.bounds.maxChunks ||
        this.bytes + bytes > this.bounds.maxBytes);
    if (full) {
      this.record('bound', 1);
      return false;
    }
    this.chunks.push({ data, bytes, at: this.now() });
    this.bytes += bytes;
    return true;
  }

  /**
   * Discard everything that has outlived the TTL.
   *
   * All-or-nothing, and the reason is in this module's header: the chunk that
   * ages out first is the one at the front, and the front cannot be removed
   * without orphaning every chunk behind it. So the first chunk past the TTL
   * takes the queue with it — which is also the honest description of what has
   * happened, because a queue with a chunk that old has not been delivered for
   * longer than the policy allows, and delivering the rest would be executing
   * typed-ahead input as if the user had just typed it.
   */
  expire(): boolean {
    const oldest = this.chunks[0];
    if (!oldest || this.now() - oldest.at <= this.bounds.maxAgeMs) {
      return false;
    }
    this.clear('age');
    return true;
  }

  /**
   * What a flush should send, oldest first, each with the position it carries.
   *
   * The chunks are *not* removed: on a transport that can carry a sequence,
   * they stay until the agent says it applied them, because that is what makes
   * a retry after a lost acknowledgement possible at all.
   *
   * `null` when the queue has no epoch yet — a chunk sent before the agent has
   * said which run it belongs to would be input the agent writes but cannot
   * account for, and the cursor would then be wrong for every chunk after it.
   */
  outbound(): Array<{ seq: number; data: string }> | null {
    if (!this.identity) {
      return null;
    }
    return this.chunks.map((chunk, index) => ({
      seq: this.cursor + 1 + index,
      data: chunk.data,
    }));
  }

  /**
   * Take everything and forget it, for a transport that cannot acknowledge.
   *
   * The relay path, until the Server can preserve a sequence through its 16 ms
   * merge (#1307 stage 4): its input is delivered or it is not, and there is
   * nothing a later retry could be checked against — so retaining it would only
   * mean holding bytes the TTL would eventually discard.
   */
  drain(): string[] {
    if (this.identity) {
      // A drain on a bound queue is a flush without the retention, so it is
      // still a flush: the age bound applies first.
      this.expire();
    }
    const data = this.chunks.map((chunk) => chunk.data);
    this.chunks = [];
    this.bytes = 0;
    return data;
  }

  /** Forget everything, recording why. */
  clear(reason: InputDropReason): void {
    if (this.chunks.length > 0) {
      this.record(reason, this.chunks.length);
    }
    this.chunks = [];
    this.bytes = 0;
  }

  private dropPrefix(count: number): void {
    if (count <= 0) {
      return;
    }
    const dropped = this.chunks.splice(0, count);
    for (const chunk of dropped) {
      this.bytes -= chunk.bytes;
    }
  }

  private record(reason: InputDropReason, chunks: number): void {
    this.drop = { reason, chunks, at: this.now() };
    this.dropped += chunks;
    this.onDrop?.(this.drop);
  }
}

/**
 * The UTF-8 length of `data`, which is what the wire will carry.
 *
 * Counted in bytes rather than in JS string units because the bound is about
 * memory and bandwidth, and a string of CJK or emoji is two to four times
 * larger on the wire than its `.length`. `TextEncoder` is the same encoder
 * `encodeBase64` uses, so the two agree about what this input's size is.
 */
export function utf8ByteLength(data: string): number {
  return new TextEncoder().encode(data).length;
}
