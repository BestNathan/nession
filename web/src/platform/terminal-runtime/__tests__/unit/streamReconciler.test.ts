import { describe, it, expect } from 'vitest';
import {
  StreamReconciler,
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
}

function makeHarness(): Harness {
  const requests: PendingRequest[] = [];
  const out: string[] = [];
  const resizes: Array<[number, number]> = [];
  const reconciler = new StreamReconciler(
    (epoch, afterSeq) =>
      new Promise<ResumeReply>((resolve, reject) => {
        requests.push({ epoch, afterSeq, resolve, reject });
      }),
    {
      onOutput: (data) => out.push(new TextDecoder().decode(data)),
      onResize: (cols, rows) => resizes.push([cols, rows]),
    },
  );
  return { reconciler, requests, out, resizes };
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

function reply(events: TerminalStreamEvent[], streamEpoch = 1): ResumeReply {
  return { streamEpoch, epochMatch: true, events };
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
    h.reconciler.acceptLive({ data: new TextEncoder().encode('snapshot'), bootstrap: true });
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

  it('continues past a hole the agent no longer retains', async () => {
    // The agent's ring buffer evicted 6..10 before the resume was answered, so
    // its answer starts at 11. Waiting for 6 would hold 12 and every frame
    // after it forever — the retention case #1304 owns the reporting for, and
    // this is what keeps the terminal alive until it lands.
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 12, 'twelve');
    h.requests[0].resolve(reply([11, 12].map((seq) => output(seq))));
    await flushMicrotasks();

    expect(h.out).toEqual(['five', 'replay-11', 'twelve']);
    expect(h.requests).toHaveLength(1);
  });

  it('stops waiting for a hole that survives repeated attempts', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    h.requests[0].reject(new Error('agent unavailable'));
    await flushMicrotasks();
    // A failure is not an answer: the hole is still open and nothing is
    // committed out of order.
    expect(h.out).toEqual(['five']);

    live(h, 9, 'nine');
    h.requests[1].reject(new Error('agent unavailable'));
    await flushMicrotasks();
    live(h, 10, 'ten');
    h.requests[2].reject(new Error('agent unavailable'));
    await flushMicrotasks();

    // Three attempts, each triggered by a frame that could not be placed. The
    // fourth frame gives up on the hole rather than holding it — and everything
    // in hand is committed, in order, so the user sees output instead of a
    // terminal that stopped at sequence 5.
    live(h, 11, 'eleven');
    expect(h.requests).toHaveLength(3);
    expect(h.out).toEqual(['five', 'eight', 'nine', 'ten', 'eleven']);
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

  it('adopts the epoch a mismatched reply reports', async () => {
    const h = makeHarness();
    live(h, 5, 'five');
    live(h, 8, 'eight');
    // The agent recreated its stream between the request and the answer. It
    // sends no events with a mismatch, so there is nothing to apply — but the
    // epoch it reports is the one the next frames will carry.
    h.requests[0].resolve({ streamEpoch: 7, epochMatch: false, events: [] });
    await flushMicrotasks();
    expect(h.out).toEqual(['five']);

    live(h, 1, 'seven-one', 7);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].epoch).toBe(7);
    expect(h.requests[1].afterSeq).toBe(0);
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
