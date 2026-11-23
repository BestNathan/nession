import { describe, it, expect } from 'vitest';
import {
  PendingInputQueue,
  utf8ByteLength,
  type InputDrop,
  type InputQueueBounds,
} from '@/platform/terminal-runtime/inputQueue';
import { INPUT_QUEUE_BOUNDS } from '@/platform/terminal-runtime/ConnectionManager';

const BOUNDS: InputQueueBounds = {
  maxChunks: 4,
  maxBytes: 16,
  maxAgeMs: 1_000,
};

const identity = (over: Partial<{ inputEpoch: number; controlGeneration: number }> = {}) => ({
  sessionName: 'work',
  inputEpoch: 7,
  controlGeneration: 2,
  ...over,
});

/** A queue over a clock this test moves by hand. */
function queueWithClock(bounds: InputQueueBounds = BOUNDS) {
  let now = 0;
  const queue = new PendingInputQueue(bounds, () => now);
  return {
    queue,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('PendingInputQueue', () => {
  describe('the sequence is derived from the cursor', () => {
    /**
     * The mutation this pins is storing a sequence number on the chunk. With a
     * stored number, dropping the acknowledged prefix leaves the survivors
     * numbered from where they were rather than from where the cursor is, and
     * the agent — which applies only the chunk that continues its cursor —
     * refuses the whole run.
     */
    it('numbers the run from the cursor, in order', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      expect(queue.accept('a')).toBe(true);
      expect(queue.accept('b')).toBe(true);
      expect(queue.accept('c')).toBe(true);
      expect(queue.outbound()).toEqual([
        { seq: 1, data: 'a' },
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
      ]);
    });

    /**
     * The property that makes a retry safe: the chunks that are still pending
     * after an acknowledgement keep the positions they were already sent with,
     * so re-sending them is re-sending the same chunk rather than a
     * renumbered one.
     */
    it('leaves the survivors on their original positions after an ack', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      for (const data of ['a', 'b', 'c', 'd']) {
        queue.accept(data);
      }
      queue.acknowledge(7, 2);
      expect(queue.appliedThrough).toBe(2);
      expect(queue.size).toBe(2);
      expect(queue.outbound()).toEqual([
        { seq: 3, data: 'c' },
        { seq: 4, data: 'd' },
      ]);
    });

    it('has nothing to send before the agent says which run this is', () => {
      const { queue } = queueWithClock();
      queue.accept('a');
      expect(queue.outbound()).toBeNull();
      expect(queue.isBound).toBe(false);
      queue.reconcile(identity());
      expect(queue.isBound).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 1, data: 'a' }]);
    });
  });

  describe('the coalesced frame projection (#3397)', () => {
    /**
     * One frame for the whole run above the cursor: the bytes are exactly the
     * chunks in order, and the range is exactly the positions they occupy.
     * Concatenating is lossless by construction — the Agent writes a frame
     * whole and advances to `seqEnd`.
     */
    it('joins the whole pending run into one frame above the cursor', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('\x1b[<35;20;1M');
      queue.accept('b');
      queue.acknowledge(7, 1);

      expect(queue.outboundFrame()).toEqual({
        data: '\x1b[<35;20;1Mb',
        seqStart: 2,
        seqEnd: 3,
      });
    });

    /** No epoch or no chunks means no position to state, so no frame either. */
    it('has no frame before an epoch or with an empty run', () => {
      const { queue } = queueWithClock();
      expect(queue.outboundFrame()).toBeNull();
      queue.reconcile(identity());
      expect(queue.outboundFrame()).toBeNull();
    });
  });

  describe('acknowledgement', () => {
    it('drops exactly the acknowledged prefix', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      for (const data of ['a', 'b', 'c']) {
        queue.accept(data);
      }
      queue.acknowledge(7, 1);
      expect(queue.outbound()).toEqual([
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
      ]);
      expect(queue.byteLength).toBe(2);
    });

    /** A restated cursor is not a new one, and re-dropping would eat live input. */
    it('ignores a cursor that has not moved', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('b');
      queue.acknowledge(7, 1);
      queue.acknowledge(7, 1);
      queue.acknowledge(7, 0);
      expect(queue.size).toBe(1);
      expect(queue.appliedThrough).toBe(1);
    });

    /**
     * An acknowledgement names its epoch so that one about a different run can
     * be ignored. Applying it would move this queue's cursor on another agent
     * process's word and drop input that was never applied — the duplicate the
     * sequence exists to prevent.
     */
    it('ignores an acknowledgement for another epoch', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('b');
      queue.acknowledge(8, 2);
      expect(queue.size).toBe(2);
      expect(queue.appliedThrough).toBe(0);
    });
  });

  describe('bounds', () => {
    /**
     * The mutation is evicting the oldest chunk to make room. The oldest chunk
     * carries the front position, so evicting it leaves a run that starts above
     * the cursor — which the agent refuses forever, turning a memory bound into
     * a session that cannot be typed into.
     */
    it('refuses new input rather than evicting the front', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      for (const data of ['a', 'b', 'c', 'd']) {
        expect(queue.accept(data)).toBe(true);
      }
      expect(queue.accept('e')).toBe(false);
      // Everything already accepted is still there, at the positions it had.
      expect(queue.outbound()).toEqual([
        { seq: 1, data: 'a' },
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
        { seq: 4, data: 'd' },
      ]);
      expect(queue.lastDrop).toMatchObject({ reason: 'bound', chunks: 1 });
      expect(queue.droppedChunks).toBe(1);
    });

    it('bounds bytes as well as chunks, and keeps the queue deliverable', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      expect(queue.accept('0123456789')).toBe(true);
      expect(queue.accept('0123456789')).toBe(false);
      expect(queue.byteLength).toBe(10);
      expect(queue.outbound()).toHaveLength(1);
    });

    /**
     * A paste is one chunk, and the bound exists to permit it rather than to
     * refuse it — up to the byte budget itself. The requirement says bounds
     * must not assume one keystroke per event; a queue that split a paste into
     * per-keystroke chunks would refuse exactly the case it is for. What the
     * bound does refuse, whole and with a stated loss, is a single event whose
     * own bytes exceed the budget (#4299) — pinned in the #4299 block below.
     */
    it('accepts one exact-bound paste as a single chunk into an empty queue', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      const paste = 'x'.repeat(BOUNDS.maxBytes);
      expect(queue.accept(paste)).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 1, data: paste }]);
      // And the next thing is refused, because the queue is full.
      expect(queue.accept('y')).toBe(false);
    });

    /**
     * The count is bytes on the wire, not JavaScript string units: a CJK
     * character is one `.length` and three bytes, and a bound that counted
     * units would let an IME composition run to three times the memory it
     * promised.
     */
    it('counts UTF-8 bytes, not string units', () => {
      expect(utf8ByteLength('abc')).toBe(3);
      expect(utf8ByteLength('中')).toBe(3);
      expect('中'.length).toBe(1);
      const { queue } = queueWithClock({ maxChunks: 10, maxBytes: 6, maxAgeMs: 1000 });
      queue.reconcile(identity());
      expect(queue.accept('中中')).toBe(true);
      expect(queue.accept('中')).toBe(false);
    });

    it('drops an empty chunk rather than counting it', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      expect(queue.accept('')).toBe(true);
      expect(queue.size).toBe(0);
    });
  });

  /**
   * #4299: the byte bound governs the FIRST chunk too. The mutation this block
   * pins is guarding the bounds behind `chunks.length > 0`, which admitted one
   * event of any size into an empty queue — a single paste larger than the
   * whole per-Session budget was buffered while detached and offered on
   * reconnect, with no loss stated. The refusal is whole (no truncation, no
   * split) and recorded as exactly one `bound` drop for the refused chunk.
   */
  describe('the first chunk obeys the byte bound (#4299)', () => {
    /** SC-01 negative: 1 MiB + 1 byte on an empty queue over the real policy. */
    it('refuses a single oversized first chunk and states exactly one bound drop', () => {
      const { queue } = queueWithClock(INPUT_QUEUE_BOUNDS);
      const drops: InputDrop[] = [];
      queue.onDrop = (drop) => drops.push(drop);
      queue.reconcile(identity());

      const oversized = 'x'.repeat(INPUT_QUEUE_BOUNDS.maxBytes + 1);
      expect(queue.accept(oversized)).toBe(false);
      expect(queue.byteLength).toBe(0);
      expect(queue.size).toBe(0);
      expect(queue.outbound()).toEqual([]);
      expect(queue.outboundFrame()).toBeNull();
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ reason: 'bound', chunks: 1 });
      expect(queue.lastDrop).toMatchObject({ reason: 'bound', chunks: 1 });
      expect(queue.droppedChunks).toBe(1);

      // The refusal does not poison the queue: ordinary input still lands,
      // numbered from the cursor as if the refused event never existed.
      expect(queue.accept('ok\r')).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 1, data: 'ok\r' }]);
      expect(drops).toHaveLength(1);
    });

    /** SC-01 positive: exactly maxBytes is inside the budget, not past it. */
    it('accepts a first chunk of exactly maxBytes', () => {
      const { queue } = queueWithClock(INPUT_QUEUE_BOUNDS);
      const drops: InputDrop[] = [];
      queue.onDrop = (drop) => drops.push(drop);
      queue.reconcile(identity());

      const paste = 'x'.repeat(INPUT_QUEUE_BOUNDS.maxBytes);
      expect(queue.accept(paste)).toBe(true);
      expect(queue.byteLength).toBe(INPUT_QUEUE_BOUNDS.maxBytes);
      expect(queue.outbound()).toEqual([{ seq: 1, data: paste }]);
      expect(drops).toHaveLength(0);
    });

    /**
     * The first chunk is measured in UTF-8 bytes, not string units: a CJK
     * paste whose `.length` is far under the budget can still exceed it on
     * the wire, and one that lands exactly on the budget must be admitted.
     */
    it('measures the first chunk in UTF-8 bytes at the 1 MiB boundary', () => {
      // 3-byte CJK chars padded with ASCII to land exactly on the budget.
      const cjk = '中'.repeat(Math.floor(INPUT_QUEUE_BOUNDS.maxBytes / 3));
      const exact = cjk + 'x'.repeat(INPUT_QUEUE_BOUNDS.maxBytes - utf8ByteLength(cjk));
      const over = `${exact}a`;
      expect(utf8ByteLength(exact)).toBe(INPUT_QUEUE_BOUNDS.maxBytes);
      expect(utf8ByteLength(over)).toBe(INPUT_QUEUE_BOUNDS.maxBytes + 1);
      expect(over.length).toBeLessThan(INPUT_QUEUE_BOUNDS.maxBytes);

      const accepting = queueWithClock(INPUT_QUEUE_BOUNDS);
      accepting.queue.reconcile(identity());
      expect(accepting.queue.accept(exact)).toBe(true);
      expect(accepting.queue.byteLength).toBe(INPUT_QUEUE_BOUNDS.maxBytes);

      const refusing = queueWithClock(INPUT_QUEUE_BOUNDS);
      const drops: InputDrop[] = [];
      refusing.queue.onDrop = (drop) => drops.push(drop);
      refusing.queue.reconcile(identity());
      expect(refusing.queue.accept(over)).toBe(false);
      expect(refusing.queue.byteLength).toBe(0);
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ reason: 'bound', chunks: 1 });
    });

    /** The bound applies before the queue has an epoch, not only after. */
    it('refuses an oversized first chunk on an unbound empty queue', () => {
      const { queue } = queueWithClock(INPUT_QUEUE_BOUNDS);
      expect(queue.accept('x'.repeat(INPUT_QUEUE_BOUNDS.maxBytes + 1))).toBe(false);
      expect(queue.byteLength).toBe(0);
      expect(queue.lastDrop).toMatchObject({ reason: 'bound', chunks: 1 });
      queue.reconcile(identity());
      expect(queue.accept('a')).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 1, data: 'a' }]);
    });

    /** The same contract at the small fixture scale, exact-bound included. */
    it('refuses the first chunk past a small bound but admits the exact bound', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      expect(queue.accept('x'.repeat(BOUNDS.maxBytes + 1))).toBe(false);
      expect(queue.byteLength).toBe(0);
      expect(queue.lastDrop).toMatchObject({ reason: 'bound', chunks: 1 });
      expect(queue.accept('x'.repeat(BOUNDS.maxBytes))).toBe(true);
      expect(queue.byteLength).toBe(BOUNDS.maxBytes);
    });

    /**
     * SC-02: a cumulative refusal leaves the accepted run byte-for-byte and
     * position-for-position intact — the bound refuses the newest event, it
     * never edits what the queue already holds.
     */
    it('refuses a cumulative byte overflow without mutating the accepted run', () => {
      const { queue } = queueWithClock();
      const drops: InputDrop[] = [];
      queue.onDrop = (drop) => drops.push(drop);
      queue.reconcile(identity());
      expect(queue.accept('0123456789')).toBe(true);

      expect(queue.accept('1234567')).toBe(false); // 10 + 7 > 16
      expect(queue.byteLength).toBe(10);
      expect(queue.outbound()).toEqual([{ seq: 1, data: '0123456789' }]);
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ reason: 'bound', chunks: 1 });

      // The kept run still acknowledges and still admits ordinary UTF-8 input.
      queue.acknowledge(7, 1);
      expect(queue.byteLength).toBe(0);
      expect(queue.accept('中')).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 2, data: '中' }]);
    });

    /** SC-02: the chunk bound likewise refuses without touching held bytes. */
    it('refuses at the chunk bound without mutating accepted bytes', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      for (const data of ['a', 'b', 'c', 'd']) {
        expect(queue.accept(data)).toBe(true);
      }
      expect(queue.accept('e')).toBe(false);
      expect(queue.byteLength).toBe(4);
      expect(queue.outbound()).toEqual([
        { seq: 1, data: 'a' },
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
        { seq: 4, data: 'd' },
      ]);
      expect(queue.lastDrop).toMatchObject({ reason: 'bound', chunks: 1 });
    });
  });

  describe('expiry', () => {
    /**
     * All-or-nothing, and the mutation is dropping only the aged chunks: the
     * aged one is at the front, so removing it alone leaves a run the agent
     * refuses, and the chunks behind it — which the user typed *later* — would
     * be executed as if they were current.
     */
    it('discards the whole queue once the oldest chunk is too old', () => {
      const { queue, advance } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('old');
      advance(900);
      queue.accept('new');
      advance(200);
      // `old` is past the 1000 ms TTL and `new` is not.
      expect(queue.expire()).toBe(true);
      expect(queue.size).toBe(0);
      expect(queue.outbound()).toEqual([]);
      expect(queue.lastDrop).toMatchObject({ reason: 'age', chunks: 2 });
    });

    it('keeps a queue that is inside the TTL', () => {
      const { queue, advance } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      advance(999);
      expect(queue.expire()).toBe(false);
      expect(queue.size).toBe(1);
      expect(queue.droppedChunks).toBe(0);
    });

    /** A chunk cannot be accepted into a queue whose front is already stale. */
    it('expires on the way in, so stale input cannot hide behind new input', () => {
      const { queue, advance } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('old');
      advance(5_000);
      expect(queue.accept('new')).toBe(true);
      expect(queue.outbound()).toEqual([{ seq: 1, data: 'new' }]);
      expect(queue.lastDrop).toMatchObject({ reason: 'age', chunks: 1 });
    });
  });

  describe('identity', () => {
    /**
     * The attach reply is the reconcile, not just a re-bind: the cursor it
     * states is where the agent actually is, and a queue that ignored it would
     * keep chunks the PTY already has and re-send them.
     *
     * This was a real defect in this module — `reconcile` bound the identity
     * and left the cursor at whatever it had been, so a client reattaching
     * after a lost acknowledgement re-sent its whole run from chunk 1. The
     * agent refuses those, so it recovered a round trip later; but the first
     * frame after every reconnect was wrong, and the client was asking the
     * agent to tell it something the attach reply had already said.
     */
    it('applies the cursor an attach states, dropping what it covers', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity(), 0);
      for (const data of ['a', 'b', 'c']) {
        queue.accept(data);
      }
      // Reattached: the agent applied two of the three and the acks were lost.
      queue.reconcile(identity(), 2);
      expect(queue.appliedThrough).toBe(2);
      expect(queue.outbound()).toEqual([{ seq: 3, data: 'c' }]);
    });

    /**
     * A re-bind that states no position — the lease path — leaves the cursor
     * alone. Otherwise a handoff, which says nothing about input, would reset
     * the cursor and renumber the run.
     */
    it('leaves the cursor alone when no position is stated', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity(), 2);
      queue.accept('a');
      queue.reconcile(identity({ controlGeneration: 5 }));
      expect(queue.appliedThrough).toBe(2);
    });

    it('keeps every unacknowledged chunk across an ordinary re-bind', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('b');
      queue.acknowledge(7, 1);
      expect(queue.reconcile(identity())).toBe('bound');
      expect(queue.outbound()).toEqual([{ seq: 2, data: 'b' }]);
      expect(queue.appliedThrough).toBe(1);
    });

    /**
     * The agent that would have to say whether these bytes landed is gone, and
     * its cursor died with it. Keeping them would replay input that may already
     * have run; the epoch is what makes that boundary sayable (#1307 SC-09).
     */
    it('discards everything when the input epoch moves', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('b');
      expect(queue.reconcile(identity({ inputEpoch: 8 }))).toBe('epoch-changed');
      expect(queue.size).toBe(0);
      expect(queue.appliedThrough).toBe(0);
      expect(queue.lastDrop).toMatchObject({ reason: 'epoch', chunks: 2 });
      expect(queue.outbound()).toEqual([]);
    });

    /**
     * A handoff moves the lease to another client; input the previous
     * controller typed and never got applied must not arrive under the new
     * generation's name (#1307 SC-08, #1095).
     */
    it('discards everything when the control generation moves', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      expect(queue.reconcile(identity({ controlGeneration: 3 }))).toBe(
        'generation-changed',
      );
      expect(queue.size).toBe(0);
      expect(queue.lastDrop).toMatchObject({ reason: 'generation', chunks: 1 });
    });

    /** A generation the peer never stated is not a generation change. */
    it('does not treat an unstated generation as a change', () => {
      const { queue } = queueWithClock();
      queue.reconcile({ sessionName: 'work', inputEpoch: 7 });
      queue.accept('a');
      expect(
        queue.reconcile({ sessionName: 'work', inputEpoch: 7 }),
      ).toBe('bound');
      expect(queue.size).toBe(1);
    });
  });

  describe('drain', () => {
    /**
     * The relay path's shape until the Server can carry a sequence through its
     * merge (#1307 stage 4): deliver or lose, with nothing to retry against.
     */
    it('returns everything and forgets it', () => {
      const { queue } = queueWithClock();
      queue.reconcile(identity());
      queue.accept('a');
      queue.accept('b');
      expect(queue.drain()).toEqual(['a', 'b']);
      expect(queue.size).toBe(0);
      expect(queue.byteLength).toBe(0);
      expect(queue.outbound()).toEqual([]);
    });
  });
});
