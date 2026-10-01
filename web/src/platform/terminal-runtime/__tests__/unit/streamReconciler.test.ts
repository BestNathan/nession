import { describe, it, expect, vi } from 'vitest';
import {
  StreamReconciler,
  RESUME_DEADLINE_MS,
  type ResumeReply,
} from '@/platform/terminal-runtime/streamReconciler';
import type { TerminalStreamEvent } from '@/platform/terminal-runtime/streamApply';

/**
 * A resume request the test resolves by hand, so every interleaving of live
 * frames and replay answers is a sequence the test states rather than one the
 * scheduler happens to produce.
 */
interface PendingRequest {
  epoch: number;
  afterSeq: number;
  resolve: (reply: ResumeReply) => void;
  reject: (error?: unknown) => void;
}

interface Harness {
  reconciler: StreamReconciler;
  requests: PendingRequest[];
  out: string[];
  resizes: Array<[number, number]>;
  /**
   * How many times the sink was told the buffer has a hole in it (#1304).
   * Counted rather than flagged: a second notice for the same hole would mean
   * the reconciler asked again for events the agent has already said it cannot
   * return.
   */
  readonly truncated: number;
}

function makeHarness(): Harness {
  const requests: PendingRequest[] = [];
  const out: string[] = [];
  const resizes: Array<[number, number]> = [];
  const seen = { truncated: 0 };
  const reconciler = new StreamReconciler(
    (epoch, afterSeq) =>
      new Promise<ResumeReply>((resolve, reject) => {
        requests.push({ epoch, afterSeq, resolve, reject });
      }),
    {
      onOutput: (data) => out.push(new TextDecoder().decode(data)),
      onResize: (cols, rows) => resizes.push([cols, rows]),
      onStreamTruncated: () => {
        seen.truncated += 1;
      },
    },
  );
  return {
    reconciler,
    requests,
    out,
    resizes,
    get truncated() {
      return seen.truncated;
    },
  };
}

function live(h: Harness, seq: number, text: string, epoch = 1): void {
  h.reconciler.acceptLive({
    data: new TextEncoder().encode(text),
    streamEpoch: epoch,
    streamSeq: seq,
  });
}

function output(seq: number, epoch = 1): TerminalStreamEvent {
  return { kind: 'output', streamEpoch: epoch, streamSeq: seq, data: btoa(`replay-${seq}`) };
}

/**
 * A live resize at `seq` on stream 1 — what the agent's fan-out sends for a
 * resize it recorded. Every test here works within one epoch; the level lane,
 * which states no position at all, is `acceptLevelResize` and is called
 * directly where it is the thing under test.
 */
function liveResize(h: Harness, seq: number, cols = 120, rows = 40): void {
  h.reconciler.acceptLiveResize({ cols, rows, streamEpoch: 1, streamSeq: seq });
}

/**
 * An answer to a resume, with the window the agent states alongside it (#1304).
 *
 * `facts` is omitted only where the test is about an agent that states
 * **nothing** — an epoch mismatch, or one built before the fields existed.
 * Leaving it out everywhere else would make those tests say the same thing as
 * the ones that pass a floor, which is exactly the distinction this field set
 * exists to make.
 */
function reply(
  events: TerminalStreamEvent[],
  streamEpoch = 1,
  facts: { firstAvailableSeq?: number; complete?: boolean } = {},
): ResumeReply {
  return { streamEpoch, epochMatch: true, ...facts, events };
}

/** Let the reconciler's `.then` handlers run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('StreamReconciler', () => {
  it('places a live frame that arrives during an in-flight resume behind it (#1303)', async () => {
    // The exact sequence from the issue: the second frame's gap detection used
    // to be skipped while the first frame's resume was in flight, and the
    // second frame committed itself over the gap. The first resume then
    // filtered its own answer against the advanced cursor and dropped 6, 7
    // and 8 for good.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');

    // The resume is asked for from the last committed frame, and only once:
    // the second frame joins the recovery instead of starting its own.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].afterSeq).toBe(5);

    live(h, 9, 'nine');
    expect(h.requests).toHaveLength(1);
    // Nothing has been committed past the gap, so the frame that skipped it is
    // not on screen ahead of its predecessors.
    expect(h.out).toEqual(['five']);

    h.requests[0].resolve(reply([6, 7, 8, 9].map((seq) => output(seq))));
    await flushMicrotasks();

    // 8 and 9 arrive once each — from the live copy already held, not twice.
    expect(h.out).toEqual(['five', 'replay-6', 'replay-7', 'eight', 'nine']);
  });

  it('keeps one request in flight while a hole is open', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    live(h, 9, 'nine');
    live(h, 10, 'ten');
    // Three frames could not be placed and the recovery already under way is
    // the one that will place them; asking again duplicates the payload and
    // races the answers against each other.
    expect(h.requests).toHaveLength(1);

    h.requests[0].resolve(reply([]));
    await flushMicrotasks();
    // An empty answer proves nothing about the hole, so the next frame asks
    // again — from the same cursor.
    live(h, 11, 'eleven');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].afterSeq).toBe(5);
  });

  it('fills several gaps in sequence without reordering output', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    h.requests[0].resolve(reply([6, 7].map((seq) => output(seq))));
    await flushMicrotasks();
    expect(h.out).toEqual(['five', 'replay-6', 'replay-7', 'eight']);

    // A second gap, further along the same epoch.
    live(h, 12, 'twelve');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].afterSeq).toBe(8);
    h.requests[1].resolve(reply([9, 10, 11, 12].map((seq) => output(seq))));
    await flushMicrotasks();

    expect(h.out).toEqual([
      'five', 'replay-6', 'replay-7', 'eight',
      'replay-9', 'replay-10', 'replay-11', 'twelve',
    ]);
  });

  it('does not apply replayed events the live stream already delivered (#1148)', async () => {
    const h = makeHarness();
    live(h, 1, 'one');
    live(h, 2, 'two');
    h.reconciler.seed(1, 0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].afterSeq).toBe(2);

    // The replay answers from the seeded cursor and therefore carries frames
    // that have already been written to the terminal.
    h.requests[0].resolve(reply([1, 2, 3].map((seq) => output(seq))));
    await flushMicrotasks();

    expect(h.out).toEqual(['one', 'two', 'replay-3']);
  });

  it('never moves the seeded cursor backwards within an epoch (#1148)', async () => {
    const h = makeHarness();
    live(h, 1, 'one');
    live(h, 2, 'two');

    // A stale seed from the attach response: the live stream is already past
    // it, and replaying from it would re-apply what has been written.
    h.reconciler.seed(1, 0);
    expect(h.requests[0].afterSeq).toBe(2);
  });

  it('asks from the stream start when a new epoch is adopted', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    // A frame from a new generation: the sequences restart, so the cursor must
    // not carry over — and the new stream's own history is worth asking for.
    live(h, 1, 'new-one', 2);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].epoch).toBe(2);
    expect(h.requests[0].afterSeq).toBe(0);
    // The new generation's first frame is held until that history is in hand.
    expect(h.out).toEqual(['five']);

    h.requests[0].resolve(reply([1, 2].map((seq) => output(seq, 2)), 2));
    await flushMicrotasks();
    expect(h.out).toEqual(['five', 'new-one', 'replay-2']);
  });

  it('discards a reply from a generation the stream has left (#1303)', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    expect(h.requests).toHaveLength(1);

    // The transport is rewired onto a new stream while the old resume is still
    // in flight; its answer describes a timeline that no longer exists.
    live(h, 1, 'new-one', 2);
    h.requests[0].resolve(reply([6, 7, 8].map((seq) => output(seq))));
    await flushMicrotasks();

    expect(h.out).toEqual(['five']);
    h.requests[1].resolve(reply([1, 2].map((seq) => output(seq, 2)), 2));
    await flushMicrotasks();
    expect(h.out).toEqual(['five', 'new-one', 'replay-2']);
  });

  it('discards a reply that lands after dispose (#1303)', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');

    h.reconciler.dispose();
    h.requests[0].resolve(reply([6, 7, 8].map((seq) => output(seq))));
    await flushMicrotasks();

    expect(h.out).toEqual(['five']);
  });

  it('passes frames with no stream position straight through', () => {
    const h = makeHarness();
    // A bootstrap snapshot is deliberately outside the stream (#321) — giving
    // it a sequence number would put it inside the replay window — and relay
    // frames never had one. Neither may be buffered or dropped by the cursor.
    h.reconciler.acceptLive({
      data: new TextEncoder().encode('snapshot'),
      bootstrap: { requestedLines: 5000, truncated: false },
    });
    h.reconciler.acceptLive({ data: new TextEncoder().encode('relay') });
    expect(h.out).toEqual(['snapshot', 'relay']);
    expect(h.requests).toHaveLength(0);
  });

  it('applies replayed resizes in stream order', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 7, 'seven');
    h.requests[0].resolve(
      reply([
        { kind: 'resize', streamEpoch: 1, streamSeq: 6, cols: 120, rows: 40 },
        output(7),
      ]),
    );
    await flushMicrotasks();

    expect(h.resizes).toEqual([[120, 40]]);
    expect(h.out).toEqual(['five', 'seven']);
  });

  it('holds a recorded resize in the timeline instead of applying it out of turn (#1303)', async () => {
    // A resize the agent recorded consumed a sequence number, so it is an
    // event like any other: applying it on arrival would leave its own
    // position unaccounted for, and the next live frame would be held behind a
    // hole the client had already been given the contents of.
    const h = makeHarness();
    live(h, 5, 'five');

    // The resize is recorded at 6 and arrives before anything fills the gap
    // ahead of it.
    h.reconciler.acceptLiveResize({ cols: 120, rows: 40, streamEpoch: 1, streamSeq: 8 });
    expect(h.resizes).toEqual([]);
    expect(h.requests).toHaveLength(1);

    // The answer carries the resize the agent logged at 6 — the same event, so
    // the frame that arrived live is the copy that gets applied, and it is
    // applied in its place rather than twice.
    h.requests[0].resolve(
      reply([
        { kind: 'resize', streamEpoch: 1, streamSeq: 6, cols: 100, rows: 30 },
        output(7),
      ]),
    );
    await flushMicrotasks();

    expect(h.resizes).toEqual([[100, 30], [120, 40]]);
    expect(h.out).toEqual(['five', 'replay-7']);
  });

  it('advances the cursor through a recorded resize that arrives first (#1303)', async () => {
    // The attach case this change exists for: a client fits its terminal and
    // resizes on the way in, so the first thing the agent records is a resize
    // at `seeded cursor + 1`. Delivered live with its position, it takes that
    // slot, and the first output frame after it needs no recovery at all.
    //
    // The discriminator is the request count, not the resize: applying the
    // frame on arrival would show the same size on screen and leave the
    // position unaccounted for, so the assertion that can fail is the one about
    // what the *cursor* did.
    const h = makeHarness();
    h.reconciler.seed(1, 0);
    h.requests[0].resolve(reply([]));
    await flushMicrotasks();
    expect(h.requests).toHaveLength(1);

    h.reconciler.acceptLiveResize({ cols: 120, rows: 40, streamEpoch: 1, streamSeq: 1 });
    expect(h.resizes).toEqual([[120, 40]]);

    live(h, 2, 'prompt');
    expect(h.out).toEqual(['prompt']);
    expect(h.requests).toHaveLength(1);
  });

  it('lets a newer unsequenced resize supersede a held sequenced one (#1350)', async () => {
    const h = makeHarness();
    live(h, 1, 'one');
    // 2 is missing, so the recorded resize at 3 cannot be placed: it waits.
    liveResize(h, 3);
    expect(h.resizes).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].afterSeq).toBe(1);

    // While it is held, another connection reflows the shared pane. The agent
    // did not record that, so this frame states no position and reports the
    // pane's size *now* — newer than the resize waiting behind the gap.
    h.reconciler.acceptLevelResize(100, 30);
    expect(h.resizes).toEqual([[100, 30]]);

    // The gap fills and the held resize reaches its turn.
    h.requests[0].resolve(reply([output(2), output(3)]));
    await flushMicrotasks();

    // **The older size never lands.** Committing the held resize after the
    // level would put xterm back on the grid the pane has left, and nothing
    // corrects it: the client resizes xterm one way and sends nothing back.
    expect(h.resizes).toEqual([[100, 30]]);
    expect(h.out).toEqual(['one', 'replay-2']);

    // And its position is still consumed — the frame advanced the cursor
    // without applying anything, so the timeline is not stranded one short of
    // the frames above it.
    live(h, 4, 'four');
    expect(h.requests).toHaveLength(1);
    expect(h.out).toEqual(['one', 'replay-2', 'four']);
  });

  it('applies a sequenced resize recorded after the level that superseded a held one', async () => {
    const h = makeHarness();
    live(h, 1, 'one');
    liveResize(h, 3);
    // The level is newer than everything already buffered, and newer than
    // nothing else: this second recorded resize arrives after it, so it is an
    // event the level cannot have superseded.
    h.reconciler.acceptLevelResize(100, 30);
    liveResize(h, 4, 130, 50);

    h.requests[0].resolve(reply([output(2), output(3)]));
    await flushMicrotasks();

    expect(h.resizes).toEqual([
      [100, 30],
      [130, 50],
    ]);
  });

  it('continues past a hole the agent no longer retains', async () => {
    // The agent's ring buffer evicted 6..10 before the resume was answered, so
    // its answer starts at 11 — and it says so. Waiting for 6 would hold 12 and
    // every frame after it forever; the loss is real, and now it is *stated*:
    // the consumer is told the buffer has a hole, so the snapshot that repairs
    // one (#321) can be asked for.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 12, 'twelve');
    h.requests[0].resolve(
      reply([11, 12].map((seq) => output(seq)), 1, {
        firstAvailableSeq: 11,
        complete: false,
      }),
    );
    await flushMicrotasks();

    expect(h.truncated).toBe(1);
    expect(h.out).toEqual(['five', 'replay-11', 'twelve']);
    // And it is asked for once: the agent stated where its window begins, so
    // asking again for 6..10 asks for events it has already said are gone.
    expect(h.requests).toHaveLength(1);
  });

  it('draws the boundary between whole and truncated at the stated floor', async () => {
    // Two answers from the same cursor, one event apart. The first asks the
    // agent for everything above 5 and gets it: its window begins at 6, which
    // is exactly the cursor's next event, so nothing was evicted between them.
    // The second's window begins at 7, so seq 6 is gone for good.
    //
    // Neither can be told from the other by looking at the events. That is what
    // the interim reading this replaced did — `lowestSeqAbove` inferred the
    // window from the tail — and it is why the boundary is drawn from the
    // agent's statement and not from the shape of what it sent.
    const whole = makeHarness();
    live(whole, 5, 'five');
    live(whole, 8, 'eight');
    whole.requests[0].resolve(
      reply([6, 7].map((seq) => output(seq)), 1, {
        firstAvailableSeq: 6,
        complete: true,
      }),
    );
    await flushMicrotasks();

    const truncated = makeHarness();
    live(truncated, 5, 'five');
    live(truncated, 8, 'eight');
    truncated.requests[0].resolve(
      reply([7].map((seq) => output(seq)), 1, {
        firstAvailableSeq: 7,
        complete: false,
      }),
    );
    await flushMicrotasks();

    // One event of difference in the floor, and the two verdicts are opposite.
    expect(whole.truncated).toBe(0);
    expect(truncated.truncated).toBe(1);

    // Both continue, and neither invents the events it does not hold: seq 6 is
    // applied in the first and absent in the second, and the frame in hand
    // arrives after it either way. Advancing the cursor over 6 without stating
    // it is what the client used to do silently.
    expect(whole.out).toEqual(['five', 'replay-6', 'replay-7', 'eight']);
    expect(truncated.out).toEqual(['five', 'replay-7', 'eight']);
  });

  it('states the loss when the window is far above the cursor', async () => {
    // The reproduction from #1304: the client committed its cursor at 5, the
    // agent's ring has long since passed it, and the answer it gets back is a
    // tail. Everything between 6 and 4999 is unrecoverable, and saying so is
    // the whole point — the cursor still advances, over ground the client now
    // knows is missing rather than ground it believes it recovered.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 5002, 'later');
    h.requests[0].resolve(
      reply([5000, 5001, 5002].map((seq) => output(seq)), 1, {
        firstAvailableSeq: 5000,
        complete: false,
      }),
    );
    await flushMicrotasks();

    expect(h.truncated).toBe(1);
    expect(h.out).toEqual(['five', 'replay-5000', 'replay-5001', 'later']);
    expect(h.requests).toHaveLength(1);
  });

  it('claims nothing about a window when the answer is about another stream', async () => {
    // An epoch mismatch is not a truncation and must not be reported as one:
    // the agent holds no window for the stream this request is about, and the
    // live epoch's floor is not an answer to it. The behaviour #1094 shipped is
    // unchanged — reset onto the epoch the answer names, and let that
    // generation's next frame anchor the timeline.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    h.requests[0].resolve({ streamEpoch: 2, epochMatch: false, events: [] });
    await flushMicrotasks();

    expect(h.truncated).toBe(0);
    expect(h.out).toEqual(['five']);

    live(h, 1, 'new-one', 2);
    expect(h.out).toEqual(['five', 'new-one']);
  });

  it('resolves a hole from its own answer, not from the next frame', async () => {
    // Held output must never wait for output that may not come: a shell that
    // echoed one command and went quiet would sit frozen behind the hole
    // forever. Each answer decides — filled, or given up on.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    h.requests[0].reject(new Error('agent unavailable'));
    await flushMicrotasks();

    // The retry is the reconciler's own, with no further frame to prompt it.
    expect(h.requests).toHaveLength(2);
    h.requests[1].reject(new Error('agent unavailable'));
    await flushMicrotasks();
    expect(h.requests).toHaveLength(3);
    h.requests[2].reject(new Error('agent unavailable'));
    await flushMicrotasks();

    // Three requests that moved nothing: the frame in hand is committed rather
    // than held for a recovery that is not coming.
    expect(h.out).toEqual(['five', 'eight']);
    // And it stays resolved — no fourth request, nothing left pending.
    live(h, 9, 'nine');
    expect(h.requests).toHaveLength(3);
    expect(h.out).toEqual(['five', 'eight', 'nine']);
  });

  it('asks again when an answer fills only part of the hole', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 9, 'nine');
    // The reply covers 6 but not 7 or 8, so the frame in hand is still stuck.
    h.requests[0].resolve(reply([6].map((seq) => output(seq))));
    await flushMicrotasks();
    expect(h.out).toEqual(['five', 'replay-6']);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].afterSeq).toBe(6);

    h.requests[1].resolve(reply([7, 8, 9].map((seq) => output(seq))));
    await flushMicrotasks();
    expect(h.out).toEqual(['five', 'replay-6', 'replay-7', 'replay-8', 'nine']);
  });

  it('does not hold output forever behind a request that is never answered (#1320)', async () => {
    // The real transport can leave a request pending indefinitely:
    // `WebSocketService.request` parks behind its readiness gate for up to 15s,
    // and a promise that is never answered never rejects either. Output in hand
    // must not wait on that clock — measured in CI as a terminal frozen on its
    // bootstrap for a whole 15s window.
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      live(h, 5, 'five');
      live(h, 8, 'eight');
      expect(h.requests).toHaveLength(1);
      expect(h.out).toEqual(['five']);

      // Nothing answers. The reconciler's own deadline gives up on the hole
      // and commits what it holds.
      await vi.advanceTimersByTimeAsync(RESUME_DEADLINE_MS);
      expect(h.out).toEqual(['five', 'eight']);

      // And the stream keeps flowing from there.
      live(h, 9, 'nine');
      expect(h.out).toEqual(['five', 'eight', 'nine']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an answer that arrives after its own deadline (#1320)', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      live(h, 5, 'five');
      live(h, 8, 'eight');
      await vi.advanceTimersByTimeAsync(RESUME_DEADLINE_MS);
      expect(h.out).toEqual(['five', 'eight']);

      // The parked request finally answers. Its events are behind the frontier
      // the deadline already moved, so they are not re-applied — the frame it
      // was holding was committed once, and stays committed once.
      h.requests[0].resolve(reply([6, 7, 8].map((seq) => output(seq))));
      await flushMicrotasks();
      expect(h.out).toEqual(['five', 'eight']);

      // The frontier the deadline set is contiguous with what follows, so the
      // next frame needs no recovery at all — the abandoned hole is simply
      // behind the stream now.
      live(h, 9, 'nine');
      expect(h.requests).toHaveLength(1);
      expect(h.out).toEqual(['five', 'eight', 'nine']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets frames in hand anchor a stream whose history never arrived', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    // A new generation's first frame is held while its history is fetched. The
    // fetch fails, so the frame itself anchors the timeline — holding it would
    // leave the terminal blank for a fetch that is not needed to show it.
    live(h, 1, 'new-one', 2);
    expect(h.requests).toHaveLength(1);
    h.requests[0].reject(new Error('agent unavailable'));
    await flushMicrotasks();

    expect(h.out).toEqual(['five', 'new-one']);
  });

  it('shows output the agent refuses to give the cursor for (#1320)', async () => {
    // The sequence CI logged, in order: the seed asks for history, the agent
    // answers `epochMatch: false` with no events, and then live frames arrive
    // for a timeline that has no anchor. They used to be buffered waiting for
    // a history fetch that the agent had already refused to give — and each
    // later refusal discarded them — so the terminal never showed anything
    // after its bootstrap.
    const h = makeHarness();
    h.reconciler.seed(1, 0);
    h.requests[0].resolve({ streamEpoch: 1, epochMatch: false, events: [] });
    await flushMicrotasks();

    live(h, 2, 'two');
    live(h, 3, 'three');

    // Frames the agent is broadcasting are the live truth about the timeline,
    // whatever it says about a cursor: they are shown, in order, immediately.
    expect(h.out).toEqual(['two', 'three']);
  });

  it('adopts the epoch a mismatched reply reports, and shows what follows', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    // The agent recreated its stream between the request and the answer. It
    // sends no events with a mismatch, so there is nothing to apply — but the
    // epoch it reports is the one the next frames will carry.
    h.requests[0].resolve({ streamEpoch: 7, epochMatch: false, events: [] });
    await flushMicrotasks();
    expect(h.out).toEqual(['five']);

    // A frame for the epoch it named is the timeline's live truth. It anchors
    // rather than waiting for a history fetch — that fetch is the one that was
    // just refused — so it is shown at once and needs no request of its own.
    live(h, 1, 'seven-one', 7);
    expect(h.requests).toHaveLength(1);
    expect(h.out).toEqual(['five', 'seven-one']);
  });

  it('does not ask for history when nothing is waiting on it', () => {
    const h = makeHarness();
    live(h, 1, 'one');
    live(h, 2, 'two');
    // Two frames, contiguous, nothing missing — an idle stream asks for
    // nothing at all.
    expect(h.requests).toHaveLength(0);
  });

  it('drops a frame below the frontier as already applied', () => {
    const h = makeHarness();
    live(h, 1, 'one');
    live(h, 2, 'two');
    live(h, 2, 'two-again');
    expect(h.out).toEqual(['one', 'two']);
  });

  it('is inert after dispose', async () => {
    const h = makeHarness();
    h.reconciler.dispose();
    live(h, 1, 'one');
    h.reconciler.seed(1, 0);
    await flushMicrotasks();
    expect(h.out).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });
});
