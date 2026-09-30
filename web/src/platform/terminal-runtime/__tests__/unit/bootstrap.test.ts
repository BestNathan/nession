import { describe, it, expect } from 'vitest';
import { decodeBootstrapMarker } from '@/platform/terminal-runtime/bootstrap';

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
