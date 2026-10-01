import {
  applyTerminalStreamEvents,
  type StreamApplyHandlers,
  type TerminalStreamEvent,
} from './streamApply';
import type { TerminalBootstrap } from './bootstrap';

/**
 * Ordered stream reconciler — the single owner of the terminal stream cursor
 * (#1303).
 *
 * A live frame and a replay answer are two writers to one timeline, and they
 * arrive on schedules nothing coordinates: frames as the transport delivers
 * them, events whenever the agent answers `agent.terminal.stream.resume`. The
 * previous design let every frame run its own async gap recovery *and* advance
 * the cursor itself, which produced a determinate loss window:
 *
 * ```text
 * committed 5 → live 8 starts a resume → live 9 finds that resume in flight,
 * skips its own recovery, and commits 9 → the first resume answers 6,7,8,9 and
 * is filtered against the cursor the second handler already advanced → 6, 7
 * and 8 are gone, with no later mechanism left to ask for them.
 * ```
 *
 * So this class holds the invariant that broke: **one cursor, advanced in
 * order, by one commit path.** A frame that cannot be placed yet waits in a
 * buffer keyed by sequence number instead of jumping the gap, and a replay
 * answer is merged into that same buffer rather than applied on its own.
 * Nothing is delivered out of order and nothing is dropped as a duplicate
 * until it has actually been delivered.
 *
 * Two rules fall out of it:
 *
 * - The frontier (`frontier`) only ever moves to `frontier + 1`, so a consumer
 *   sees a contiguous run starting from wherever the stream was anchored.
 * - A gap is a *state*, not an error: it is filled by one resume request at a
 *   time, and it is only ever abandoned — see {@link abandon} — when waiting
 *   for it has started to cost output that is already in hand.
 */
export class StreamReconciler {
  private epoch: number | null = null;
  /**
   * Highest sequence number applied, with every frame before it applied too.
   * `null` means the stream has no anchor yet: either nothing has arrived, or
   * the generation was just adopted and the timeline's start is not known.
   */
  private frontier: number | null = null;
  /**
   * Frames that cannot be applied yet, keyed by sequence number. First write
   * wins, so a frame that arrived live is the copy that gets applied when a
   * replay later answers with the same sequence number — same bytes, but the
   * live copy is the one that carries the bootstrap marker.
   */
  private pending = new Map<number, PendingFrame>();
  /**
   * Identifies the current stream generation. Every reset bumps it, so a reply
   * that was in flight across an epoch change or a dispose is recognised and
   * discarded rather than applied to a stream it no longer describes (#1303).
   */
  private generation = 0;
  /**
   * The recovery request currently out. Compared by identity, not by value:
   * a request whose deadline expires must not clear — or be confused with —
   * one issued after it.
   */
  private inFlight: Flight | null = null;
  /**
   * Attempts spent on the hole at {@link attemptsFor}, which is the cursor a
   * request was made from. Keyed by position so that a fill — or a jump over a
   * hole the agent no longer retains — retires the count with the hole it
   * belonged to, instead of charging a later, unrelated one.
   */
  private attemptsFor = -1;
  private attempts = 0;
  /**
   * Set by {@link seed}. The attach response names the position its snapshot
   * was taken at, so the events after it are worth asking for even when
   * nothing is buffered to place them against.
   */
  private wantHistory = false;
  private disposed = false;
  private readonly handlers: StreamApplyHandlers;

  constructor(
    private readonly resume: (epoch: number, afterSeq: number) => Promise<ResumeReply>,
    private readonly sink: StreamSink,
  ) {
    this.handlers = {
      onOutput: (data) => this.sink.onOutput(data),
      onResize: (cols, rows) => this.sink.onResize(cols, rows),
    };
  }

  /**
   * A frame from the live transport.
   *
   * Frames carrying no stream position — a bootstrap snapshot (#321) and
   * everything in relay mode — are outside the timeline by construction: the
   * agent gives a bootstrap no epoch and no seq precisely so it cannot be taken
   * for an event in the stream, and relay never had sequence numbers at all.
   * They go straight through.
   */
  acceptLive(frame: LiveFrame): void {
    if (this.disposed) {
      return;
    }
    if (frame.streamEpoch === undefined || frame.streamSeq === undefined) {
      this.sink.onOutput(frame.data, frame.bootstrap);
      return;
    }
    this.accept(frame.streamEpoch, frame.streamSeq, 'output', () =>
      this.sink.onOutput(frame.data, frame.bootstrap),
    );
  }

  /**
   * A resize that is an **event in the stream** — one the agent recorded, and
   * so one that consumed a sequence number (#1303).
   *
   * It takes the same path as a live output frame, which is the whole point:
   * the agent's stream log holds the resize at that position, so a client that
   * skipped it would see a hole where the log has an event, and the next live
   * frame would be held behind a resume round trip that returns this same
   * resize. A resize carrying no position — the `%window-resize` echo, or any
   * relay frame — goes through {@link acceptLevelResize} instead.
   */
  acceptLiveResize(frame: LiveResizeFrame): void {
    if (this.disposed) {
      return;
    }
    const { streamEpoch, streamSeq, cols, rows } = frame;
    this.accept(streamEpoch, streamSeq, 'resize', () => this.sink.onResize(cols, rows));
  }

  /**
   * A resize that states **no** position: a level, applied on arrival (#1350).
   *
   * It applies immediately because nothing can be ordered against it, and a
   * level is by definition the size the pane has *now* — holding it would be
   * holding the truth behind a gap. But applying it while a *sequenced* resize
   * is still held is the half of the composition that used to be missing: when
   * the held frame finally drained it applied the **older** size over this one,
   * and xterm was left on a grid the pane no longer has, with nothing to correct
   * it.
   *
   * So a level supersedes the resizes waiting behind it. `supersedeBufferedResizes`
   * explains why they are emptied rather than removed.
   */
  acceptLevelResize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.supersedeBufferedResizes();
    this.sink.onResize(cols, rows);
  }

  /**
   * Empty every buffered resize without taking it out of the timeline.
   *
   * The tempting version — `pending.delete(seq)` — breaks the cursor. `drain`
   * only ever commits `frontier + 1`, so a hole where a frame used to be stops
   * the frontier at the number below it: everything above waits out
   * {@link HOLE_ATTEMPT_LIMIT} requests before being given up on, and a replay
   * that still carries that sequence number puts it straight back. Committing an
   * empty frame keeps the run contiguous and still drops exactly what this
   * supersession is meant to drop — the **size** it would have applied.
   *
   * Output is left alone: a level resize says nothing about bytes.
   */
  private supersedeBufferedResizes(): void {
    for (const [seq, frame] of this.pending) {
      if (frame.kind === 'resize') {
        this.pending.set(seq, { seq, kind: frame.kind, apply: () => {} });
      }
    }
  }

  /**
   * Seed the cursor from an attach response's stream position (#1094).
   *
   * The snapshot the client just rendered ends at this position, so the cursor
   * is at least there — and within one epoch it must never move backwards. A
   * live frame can already have advanced it past the seeded value, and
   * regressing it makes the replay re-apply output that has already been
   * written, which is the duplication measured as `out seq=1` delivered twice
   * (#1148). Across an epoch change the two sequences are not comparable, so
   * the seed wins there.
   */
  seed(epoch: number | undefined, cursor: number | undefined): void {
    if (this.disposed || epoch === undefined) {
      return;
    }
    if (epoch !== this.epoch) {
      this.reset(epoch);
    }
    if (cursor !== undefined && (this.frontier === null || cursor > this.frontier)) {
      this.frontier = cursor;
    }
    this.wantHistory = true;
    this.drain();
    this.recover();
  }

  /**
   * Drop everything and stop. A resume reply still in flight is discarded by
   * its generation guard, so a transport rewire cannot deliver the old
   * stream's events into the new one (#1303).
   */
  dispose(): void {
    this.disposed = true;
    this.reset(null);
  }

  /** Adopt a stream generation, discarding every trace of the previous one. */
  private reset(epoch: number | null): void {
    this.epoch = epoch;
    this.frontier = null;
    this.pending.clear();
    this.attemptsFor = -1;
    this.attempts = 0;
    this.wantHistory = false;
    this.inFlight = null;
    this.generation += 1;
  }

  private noteAttempt(position: number): void {
    if (this.attemptsFor === position) {
      this.attempts += 1;
    } else {
      this.attemptsFor = position;
      this.attempts = 1;
    }
  }

  private attemptsAt(position: number): number {
    return this.attemptsFor === position ? this.attempts : 0;
  }

  private accept(
    epoch: number,
    seq: number,
    kind: PendingFrame['kind'],
    apply: () => void,
  ): void {
    if (this.disposed) {
      return;
    }
    // A frame with nothing to be ordered against anchors the timeline (see
    // `anchor`) rather than waiting for a history fetch to place it. That is
    // the first frame of a connection, and it is also every frame after a
    // reply that refused the epoch the client asked about: the agent answers
    // `epochMatch: false` with **no events**, so a frame held for that fetch is
    // held for one that cannot fill it — measured in CI as a terminal that
    // showed its bootstrap and then nothing at all, for as long as the test
    // ran (#1320). The fetch is still asked for below; anything it returns for
    // a position the frontier has not passed is applied, and the rest is a
    // duplicate by construction.
    const anchors = this.epoch === null || this.frontier === null;
    if (anchors || epoch !== this.epoch) {
      this.reset(epoch);
    }
    if (this.frontier !== null && seq <= this.frontier) {
      // Already applied. A frame below the frontier is a duplicate by
      // definition — the frontier is contiguous, so nothing below it is
      // missing.
      return;
    }
    if (!this.pending.has(seq)) {
      this.pending.set(seq, { seq, kind, apply });
    }
    if (anchors) {
      this.anchor();
    }
    this.drain();
    this.recover();
  }

  /**
   * Buffer replay events and commit whatever is now contiguous.
   *
   * Events at or below the frontier were applied before the replay was asked
   * for; a replay must not re-apply what has already been delivered (#1148).
   * The rest is merged into the same buffer the live frames use, deduped by
   * sequence number — that is what makes a frame the replay already carries
   * safe to receive again live.
   */
  private onReply(flight: Flight, reply: ResumeReply): void {
    if (this.disposed || flight.generation !== this.generation) {
      return;
    }
    // Only if this is still the request in flight: a reply that arrives after
    // its own deadline already expired is applied (its events can only fill
    // forward, never re-open what the frontier has passed) but must not clear a
    // request issued since.
    if (this.inFlight === flight) {
      this.inFlight = null;
    }
    const afterSeq = flight.afterSeq;
    this.wantHistory = false;
    if (!reply.epochMatch) {
      // The agent is on a different stream generation than the one we asked
      // about — the old timeline is not comparable to this one, so nothing
      // buffered survives it. The agent sends no events with a mismatch, so
      // there is nothing to commit here either; the adopted epoch's next live
      // frame asks for that generation's history (see `accept`). Asking again
      // from here would only re-ask an epoch the agent has already replaced.
      this.reset(reply.streamEpoch);
    }

    for (const event of reply.events) {
      if (event.streamEpoch !== this.epoch) {
        continue;
      }
      if (this.frontier !== null && event.streamSeq <= this.frontier) {
        continue;
      }
      if (!this.pending.has(event.streamSeq)) {
        this.pending.set(event.streamSeq, {
          seq: event.streamSeq,
          kind: event.kind,
          apply: () => applyTerminalStreamEvents([event], this.handlers),
        });
      }
    }

    // The agent answered a request for `afterSeq` with events that start later
    // than `afterSeq + 1`: everything in between has left its retained window
    // and no later request can return it. This is the interim client-side
    // reading of a truncation the protocol cannot state yet — #1304 owns saying
    // it explicitly, and the bootstrap fallback that should replace this.
    if (reply.events.length > 0) {
      const firstSeq = lowestSeqAbove(reply.events, afterSeq);
      if (firstSeq !== null && firstSeq > afterSeq + 1) {
        this.skipHole(firstSeq);
      }
    }

    this.anchor();
    this.noteAttempt(afterSeq);
    this.drain();
    // An answer that left a hole open is not the end of the recovery — the
    // request did not cover everything it was asked for, and the frames still
    // waiting cannot place themselves. Ask again now rather than waiting for
    // another frame to arrive: the next one may never come, and until it does
    // the terminal is frozen on output it already holds.
    this.recover();
  }

  private onReplyFailed(flight: Flight): void {
    if (this.disposed || flight.generation !== this.generation) {
      return;
    }
    if (this.inFlight === flight) {
      this.inFlight = null;
    }
    const afterSeq = flight.afterSeq;
    this.noteAttempt(afterSeq);
    // A stream with no anchor has no hole to fill, only history that did not
    // come. Holding its first frames behind a request that already failed
    // would freeze the terminal for a fetch the consumer never needed to see
    // output: let the frames that are in hand anchor the timeline instead.
    if (this.frontier === null) {
      this.anchor();
      this.drain();
      return;
    }
    // Same reason as the answered case, and the one that matters most: a
    // refused request is exactly when output in hand would otherwise wait for
    // a frame that may never arrive. `recover` retries while the hole has
    // attempts left and commits what is held once it does not.
    this.recover();
  }

  /**
   * Ask for the events after the frontier, at most one request at a time.
   *
   * A request goes out when there is something it could commit: a hole (frames
   * waiting on a missing predecessor) or a seeded cursor (history the client
   * has not seen). Both are answered by the same call, and neither is answered
   * twice concurrently — an answer that arrives while another is pending is
   * merged by sequence number anyway, so overlapping requests would only
   * duplicate payload.
   */
  private recover(): void {
    if (this.disposed || this.epoch === null || this.inFlight !== null) {
      return;
    }
    if (this.pending.size === 0 && !this.wantHistory) {
      return;
    }
    const afterSeq = this.frontier ?? 0;
    if (this.attemptsAt(afterSeq) >= HOLE_ATTEMPT_LIMIT) {
      this.abandon();
      return;
    }
    const flight: Flight = { generation: this.generation, afterSeq };
    this.inFlight = flight;
    // The reconciler's own clock, not the transport's promise: an unanswered
    // request must not hold output indefinitely. On expiry the frames in hand
    // are committed and the hole is given up — the next frame starts a fresh
    // attempt from wherever the stream got to.
    const deadline = setTimeout(() => {
      if (this.disposed || this.inFlight !== flight) {
        return;
      }
      this.inFlight = null;
      this.abandon();
    }, RESUME_DEADLINE_MS);
    void this.resume(this.epoch, afterSeq).then(
      (reply) => {
        clearTimeout(deadline);
        this.onReply(flight, reply);
      },
      () => {
        clearTimeout(deadline);
        this.onReplyFailed(flight);
      },
    );
  }

  /**
   * Give up on the hole at the frontier and let the timeline continue after it.
   *
   * Only reached when the hole has outlasted {@link HOLE_ATTEMPT_LIMIT}
   * requests, none of which moved the frontier. The output already in hand is
   * committed rather than held; the frames the
   * agent no longer retains are lost, which is the state the stream was in
   * before this class buffered anything, minus the freeze.
   */
  private abandon(): void {
    this.attemptsFor = -1;
    this.attempts = 0;
    this.wantHistory = false;
    if (this.pending.size > 0) {
      this.skipHole(lowestPendingSeq(this.pending));
    }
  }

  /**
   * Stop waiting for the hole below `toExclusive` and commit what is in hand.
   *
   * Two things can establish that a hole will never be filled: the agent
   * answers a request from `afterSeq` with events that begin later than
   * `afterSeq + 1` — everything in between has left its retained window — or
   * the hole outlives {@link HOLE_ATTEMPT_LIMIT} attempts.
   *
   * The timeline is re-anchored just under the lowest frame actually held, so
   * output the client already has is delivered rather than dropped, and never
   * below the frontier, so nothing already applied is applied twice (#1148).
   */
  private skipHole(toExclusive: number): void {
    const held = this.pending.size > 0 ? lowestPendingSeq(this.pending) : toExclusive;
    const anchor = Math.min(toExclusive, held) - 1;
    if (this.frontier === null || anchor > this.frontier) {
      this.frontier = anchor;
    }
    this.drain();
  }

  /**
   * Start the timeline at the lowest frame held, for the cases where there is
   * nothing to order against: the first frame of a connection, an epoch change
   * whose history fetch came back empty or failed.
   */
  private anchor(): void {
    if (this.frontier !== null || this.pending.size === 0) {
      return;
    }
    this.frontier = lowestPendingSeq(this.pending) - 1;
  }

  /**
   * Apply every frame that is now next in line.
   *
   * Anything at or below the frontier is discarded first, so `pending` holding
   * a frame means exactly one thing: a gap is open ahead of the frontier. The
   * cursor is the only thing that decides what is still needed, and a frame it
   * has already passed is one the snapshot or an earlier commit covered.
   */
  private drain(): void {
    if (this.frontier !== null) {
      for (const seq of [...this.pending.keys()]) {
        if (seq <= this.frontier) {
          this.pending.delete(seq);
        }
      }
    }
    while (this.frontier !== null) {
      const seq = this.frontier + 1;
      const frame = this.pending.get(seq);
      if (!frame) {
        return;
      }
      this.pending.delete(seq);
      this.frontier = seq;
      frame.apply();
    }
  }
}

export interface LiveFrame {
  data: Uint8Array;
  streamEpoch?: number;
  streamSeq?: number;
  bootstrap?: TerminalBootstrap;
}

/**
 * A live resize that carries its place in the timeline (#1303).
 *
 * Both fields are required, unlike {@link LiveFrame}'s: a resize either has a
 * position the agent recorded it at, or it is a level that never enters this
 * class — there is no third case, and accepting a half-position would mean
 * guessing one.
 */
export interface LiveResizeFrame {
  cols: number;
  rows: number;
  streamEpoch: number;
  streamSeq: number;
}

/** The part of `agent.terminal.stream.resume`'s reply the cursor depends on. */
export interface ResumeReply {
  streamEpoch: number;
  epochMatch: boolean;
  events: TerminalStreamEvent[];
}

/** Where committed frames go — the consumer's write path. */
export interface StreamSink {
  onOutput: (data: Uint8Array, bootstrap?: TerminalBootstrap) => void;
  onResize: (cols: number, rows: number) => void;
}

interface PendingFrame {
  seq: number;
  /**
   * What this frame commits when its turn comes. A resize is distinguishable
   * from output because a *level* resize supersedes the resizes waiting ahead
   * of it and leaves output alone (#1350) — the frame itself stays either way,
   * see {@link StreamReconciler.supersedeBufferedResizes}.
   */
  kind: 'output' | 'resize';
  apply: () => void;
}

/** One recovery request, identified so its answer cannot be mistaken for another's. */
interface Flight {
  generation: number;
  afterSeq: number;
}

/**
 * How long a recovery request may hold the frames in hand before the
 * reconciler gives up on it.
 *
 * The request is a transport round trip, and the transport is allowed to be
 * slow in ways a terminal cannot wait out: `MessageRouter.request` waits up to
 * 15s and `WebSocketService.request` parks behind its readiness gate for as
 * long as that, so a promise that is never answered never fails either. Waiting
 * on it means waiting on the transport's clock — measured as a terminal frozen
 * on its bootstrap for the whole of a 15s window (#1320). This deadline is the
 * reconciler's own: a couple of round trips' worth, far below the transport's,
 * and the stream continues past the hole if it expires.
 */
export const RESUME_DEADLINE_MS = 2_000;

/**
 * How many requests a hole gets before the reconciler stops waiting for it.
 *
 * Each request is a round trip, and they run back to back rather than waiting
 * for the next frame: output must never be held behind a hole the agent is not
 * going to fill. Reaching the limit means that many separate asks failed to
 * move the frontier, and the frames in hand are then committed — the gap is
 * given up rather than the output.
 */
const HOLE_ATTEMPT_LIMIT = 3;

function lowestPendingSeq(pending: Map<number, PendingFrame>): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const seq of pending.keys()) {
    if (seq < lowest) {
      lowest = seq;
    }
  }
  return lowest;
}

/**
 * The lowest sequence number in `events` that is above `afterSeq` — where the
 * agent's retained window still reaches, read off the answer it just gave.
 */
function lowestSeqAbove(events: TerminalStreamEvent[], afterSeq: number): number | null {
  let lowest: number | null = null;
  for (const event of events) {
    if (event.streamSeq > afterSeq && (lowest === null || event.streamSeq < lowest)) {
      lowest = event.streamSeq;
    }
  }
  return lowest;
}
