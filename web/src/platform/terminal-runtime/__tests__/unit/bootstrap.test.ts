import { describe, it, expect } from 'vitest';
import { decodeBootstrapMarker, provesVerifiedBootstrapRepair } from '@/platform/terminal-runtime/bootstrap';

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
