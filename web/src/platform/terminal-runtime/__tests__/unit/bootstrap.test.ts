import { describe, it, expect } from 'vitest';
import {
  decodeBootstrapMarker,
  provesVerifiedBootstrapRepair,
  streamBaselineFromBootstrap,
} from '@/platform/terminal-runtime/bootstrap';

describe('decodeBootstrapMarker', () => {
  it('reads what the agent said about the snapshot', () => {
    // The two facts the agent sends, and the only two that decide whether the
    // consumer may replace its buffer with this snapshot (#1305).
    expect(decodeBootstrapMarker({ requested_lines: 5000, truncated: false })).toEqual({
      requestedLines: 5000,
      truncated: false,
    });
    expect(decodeBootstrapMarker({ requested_lines: 5000, truncated: true })).toEqual({
      requestedLines: 5000,
      truncated: true,
    });
  });

  it('treats absence as "not a bootstrap", which is not the same as an empty one', () => {
    // Absence is the only thing that means live output. A provider that sends
    // `bootstrap: {}` means the same thing as one that sends a populated
    // payload (#321) — so an empty object is still a marker.
    expect(decodeBootstrapMarker(undefined)).toBeUndefined();
    expect(decodeBootstrapMarker(null)).toBeUndefined();
    expect(decodeBootstrapMarker({})).toEqual({ requestedLines: 0, truncated: true });
  });

  it('answers the cautious way when the contents cannot be read', () => {
    // The two ways to be wrong are not equal: keeping scrollback a complete
    // snapshot would have replaced is recoverable, deleting scrollback a
    // truncated snapshot cannot restore is not. So anything unreadable is read
    // as incomplete.
    expect(decodeBootstrapMarker(true)).toEqual({ requestedLines: 0, truncated: true });
    expect(decodeBootstrapMarker('yes')).toEqual({ requestedLines: 0, truncated: true });
    expect(decodeBootstrapMarker({ truncated: 'false' })).toEqual({
      requestedLines: 0,
      truncated: true,
    });
    expect(decodeBootstrapMarker({ requested_lines: 'many', truncated: true })).toEqual({
      requestedLines: 0,
      truncated: true,
    });
  });
});

describe('P2 checkpoint cut and fidelity cannot be conflated (#2008)', () => {
  it('keeps both facts independently when the agent declares an unverified screen-only capture', () => {
    const snapshot = decodeBootstrapMarker({
      requested_lines: 5000, truncated: false,
      cut_consistency: 'unverified', fidelity: 'screen-only',
    });
    expect(snapshot).toEqual({
      requestedLines: 5000, truncated: false,
      cutConsistency: 'unverified', fidelity: 'screen-only',
    });
    expect(provesVerifiedBootstrapRepair(snapshot)).toBe(false);
  });

  it('does not clear a gap from legacy, malformed, truncated or partial captures', () => {
    const marker = (extra: Record<string, unknown>) => decodeBootstrapMarker({
      requested_lines: 100, truncated: false, ...extra,
    });
    expect(provesVerifiedBootstrapRepair(marker({}))).toBe(false);
    expect(provesVerifiedBootstrapRepair(marker({ cut_consistency: 'verified', fidelity: 'full-vt' }))).toBe(false);
    expect(provesVerifiedBootstrapRepair(marker({ cut_consistency: 'atomic', fidelity: 'unknown' }))).toBe(false);
    expect(provesVerifiedBootstrapRepair(marker({ cut_consistency: 'atomic', fidelity: 'partial' }))).toBe(false);
    expect(provesVerifiedBootstrapRepair(marker({
      cut_consistency: 'atomic', fidelity: 'full-vt', truncated: true,
    }))).toBe(false);
  });

  it('rejects atomic/full-VT markers with missing, invalid, or unsafe cut identities', () => {
    const valid = { requested_lines: 20, truncated: false,
      cut_consistency: 'atomic', fidelity: 'full-vt' };
    expect(provesVerifiedBootstrapRepair(decodeBootstrapMarker(valid))).toBe(false);
    expect(provesVerifiedBootstrapRepair(decodeBootstrapMarker({
      ...valid, stream_epoch: 5, through_seq: Number.MAX_SAFE_INTEGER + 1,
    }))).toBe(false);
    expect(provesVerifiedBootstrapRepair(decodeBootstrapMarker({
      ...valid, stream_epoch: -1, through_seq: 4,
    }))).toBe(false);
    expect(provesVerifiedBootstrapRepair(decodeBootstrapMarker({
      ...valid, stream_epoch: 5, through_seq: 0,
    }))).toBe(true);
  });

  it('permits a callback to prove recovery only for a future atomic full-VT untruncated cut', () => {
    const snapshot = decodeBootstrapMarker({
      requested_lines: 5000, truncated: false,
      cut_consistency: 'atomic', fidelity: 'full-vt',
      stream_epoch: 9, through_seq: 71,
    });
    expect(provesVerifiedBootstrapRepair(snapshot)).toBe(true);
    expect(snapshot?.streamEpoch).toBe(9);
    expect(snapshot?.throughSeq).toBe(71);
  });
});

describe('a complete Agent stream-log cut is a parser baseline, not a VT repair (#2120)', () => {
  it('derives an explicit epoch/throughSeq position from an atomic partial prefix', () => {
    // The Agent's bounded event-log prefix: complete from seq 1, but quoted as
    // partial fidelity because replaying raw output does not restore modes or
    // history predating the reader. That is still a complete *stream* cut.
    const snapshot = decodeBootstrapMarker({
      requested_lines: 5000, truncated: false,
      cut_consistency: 'atomic', fidelity: 'partial',
      stream_epoch: 12, through_seq: 480,
    });
    expect(streamBaselineFromBootstrap(snapshot)).toEqual({
      kind: 'verified', streamEpoch: 12, appliedThrough: 480,
    });
    // The same marker must never be promoted to a history repair.
    expect(provesVerifiedBootstrapRepair(snapshot)).toBe(false);
  });

  it('yields no baseline from unverified, truncated, or identity-less captures', () => {
    const marker = (extra: Record<string, unknown>) => decodeBootstrapMarker({
      requested_lines: 5000, truncated: false, ...extra,
    });
    expect(streamBaselineFromBootstrap(marker({
      cut_consistency: 'unverified', fidelity: 'screen-only', stream_epoch: 3, through_seq: 9,
    }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(marker({ fidelity: 'screen-only' }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(marker({
      cut_consistency: 'atomic', fidelity: 'partial', truncated: true,
      stream_epoch: 3, through_seq: 9,
    }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(marker({ cut_consistency: 'atomic', fidelity: 'partial' }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(marker({
      cut_consistency: 'atomic', fidelity: 'partial', stream_epoch: 0, through_seq: 9,
    }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(marker({
      cut_consistency: 'atomic', fidelity: 'partial',
      stream_epoch: 3, through_seq: Number.MAX_SAFE_INTEGER + 1,
    }))).toBeUndefined();
    expect(streamBaselineFromBootstrap(undefined)).toBeUndefined();
  });

  it('accepts a truncated epoch-start cut: the screen is short, the position is exact', () => {
    // The control-channel attach barrier (#2124): the capture covers
    // everything before the first stream event. Truncation and screen-only
    // fidelity describe the snapshot, not the stream position.
    const snapshot = decodeBootstrapMarker({
      requested_lines: 5000, truncated: true,
      cut_consistency: 'atomic', fidelity: 'screen-only',
      stream_epoch: 5, through_seq: 0,
    });
    expect(streamBaselineFromBootstrap(snapshot)).toEqual({
      kind: 'verified', streamEpoch: 5, appliedThrough: 0,
    });
    // It is still not a history repair.
    expect(provesVerifiedBootstrapRepair(snapshot)).toBe(false);
  });

  it('also accepts an atomic full-VT cut, where both facts hold at once', () => {
    const snapshot = decodeBootstrapMarker({
      requested_lines: 5000, truncated: false,
      cut_consistency: 'atomic', fidelity: 'full-vt',
      stream_epoch: 4, through_seq: 0,
    });
    expect(streamBaselineFromBootstrap(snapshot)).toEqual({
      kind: 'verified', streamEpoch: 4, appliedThrough: 0,
    });
    expect(provesVerifiedBootstrapRepair(snapshot)).toBe(true);
  });
});
