import { describe, expect, it } from 'vitest';
import { AppliedTerminalCursor } from '@/platform/terminal-runtime/AppliedTerminalCursor';

const baseline = (streamEpoch = 7, appliedThrough = 0) =>
  ({ kind: 'verified' as const, streamEpoch, appliedThrough });
const pos = (streamSeq: number, streamEpoch = 7) => ({ streamEpoch, streamSeq });

describe('AppliedTerminalCursor (#1953)', () => {
  it('does not expose a cursor before a verified baseline', () => {
    const tracker = new AppliedTerminalCursor();
    expect(tracker.snapshot({ generation: 0, streamEpoch: 7 })).toBeNull();
    expect(tracker.recordParsed({ generation: 0, streamEpoch: 7 }, pos(1))).toBe('stale');
    expect(() => tracker.beginFromVerifiedBaseline({
      kind: 'unverified' as 'verified', streamEpoch: 7, appliedThrough: 9,
    })).toThrow(RangeError);
  });

  it('advances only after every intervening sequence was parsed, including resume gaps', () => {
    const tracker = new AppliedTerminalCursor();
    const binding = tracker.beginFromVerifiedBaseline(baseline(7, 4));
    expect(tracker.recordParsed(binding, pos(7))).toBe('buffered');
    expect(tracker.recordParsed(binding, pos(6))).toBe('buffered');
    expect(tracker.snapshot(binding)?.appliedSeq).toBe(4);
    expect(tracker.recordParsed(binding, pos(7))).toBe('duplicate');
    expect(tracker.recordParsed(binding, pos(5))).toBe('advanced');
    expect(tracker.snapshot(binding)?.appliedSeq).toBe(7);
    expect(tracker.recordParsed(binding, pos(6))).toBe('duplicate');
  });

  it('keeps ACK separately behind actual parser completion', () => {
    const tracker = new AppliedTerminalCursor();
    const binding = tracker.beginFromVerifiedBaseline(baseline());
    expect(tracker.recordAckSubmitted(binding, 1)).toBe(false);
    expect(tracker.recordParsed(binding, pos(2))).toBe('buffered');
    expect(tracker.recordAckSubmitted(binding, 2)).toBe(false);
    expect(tracker.snapshot(binding)).toEqual({
      streamEpoch: 7, generation: binding.generation, appliedSeq: 0, ackSentSeq: 0,
    });
    tracker.recordParsed(binding, pos(1));
    expect(tracker.recordAckSubmitted(binding, 2)).toBe(true);
    expect(tracker.recordAckSubmitted(binding, 1)).toBe(false);
    expect(tracker.snapshot(binding)?.ackSentSeq).toBe(2);
  });

  it('ignores late callbacks after renderer or route rebinding', () => {
    const tracker = new AppliedTerminalCursor();
    const oldBinding = tracker.beginFromVerifiedBaseline(baseline(7, 2));
    const current = tracker.beginFromVerifiedBaseline(baseline(7, 2));
    expect(current.generation).toBeGreaterThan(oldBinding.generation);
    expect(tracker.recordParsed(oldBinding, pos(3))).toBe('stale');
    expect(tracker.recordAckSubmitted(oldBinding, 2)).toBe(false);
    expect(tracker.recordParsed(current, pos(3))).toBe('advanced');
    tracker.reset();
    expect(tracker.recordParsed(current, pos(4))).toBe('stale');
    expect(tracker.snapshot(current)).toBeNull();
  });

  it('fails closed on epoch mismatch or exhausted out-of-order memory', () => {
    const tracker = new AppliedTerminalCursor(2);
    const binding = tracker.beginFromVerifiedBaseline(baseline(7, 0));
    expect(tracker.recordParsed(binding, pos(3))).toBe('buffered');
    expect(tracker.recordParsed(binding, pos(4))).toBe('buffered');
    expect(tracker.recordParsed(binding, pos(5))).toBe('invalid');
    expect(tracker.snapshot(binding)).toBeNull();
    expect(tracker.recordParsed(binding, pos(1))).toBe('stale');
    const next = tracker.beginFromVerifiedBaseline(baseline(9, 0));
    expect(tracker.recordParsed(next, pos(1, 7))).toBe('invalid');
    expect(tracker.snapshot(next)).toBeNull();
  });

  it('rejects zero, negative, fractional and unsafe sequence values', () => {
    const tracker = new AppliedTerminalCursor();
    expect(() => tracker.beginFromVerifiedBaseline(baseline(0, 0))).toThrow();
    expect(() => tracker.beginFromVerifiedBaseline(baseline(7, -1))).toThrow();
    expect(() => tracker.beginFromVerifiedBaseline(baseline(7, 1.2))).toThrow();
    const binding = tracker.beginFromVerifiedBaseline(baseline());
    expect(tracker.recordParsed(binding, pos(0))).toBe('invalid');
    expect(tracker.snapshot(binding)).toBeNull();
    const next = tracker.beginFromVerifiedBaseline(baseline());
    expect(tracker.recordParsed(next, pos(Number.MAX_SAFE_INTEGER + 1))).toBe('invalid');
  });

  it('does not collapse a high safe sequence or manufacture the next event', () => {
    const tracker = new AppliedTerminalCursor();
    const through = Number.MAX_SAFE_INTEGER - 3;
    const b = tracker.beginFromVerifiedBaseline(baseline(7, through));
    expect(tracker.recordParsed(b, pos(through + 2))).toBe('buffered');
    expect(tracker.snapshot(b)?.appliedSeq).toBe(through);
    expect(tracker.recordParsed(b, pos(through + 1))).toBe('advanced');
    expect(tracker.snapshot(b)?.appliedSeq).toBe(through + 2);
    expect(tracker.recordAckSubmitted(b, through + 2)).toBe(true);
  });

  it('validates the queue bound at construction', () => {
    expect(() => new AppliedTerminalCursor(0)).toThrow(RangeError);
    expect(() => new AppliedTerminalCursor(-1)).toThrow(RangeError);
    expect(() => new AppliedTerminalCursor(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
