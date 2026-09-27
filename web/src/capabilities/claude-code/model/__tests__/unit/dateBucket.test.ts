import { describe, expect, it } from 'vitest';
import { dateBucket } from '@/capabilities/claude-code/model/dateBucket';

/**
 * A fixed "now" — a local-time constructor, not an ISO string.
 *
 * Two reasons, both about the test meaning the same thing on every machine.
 * `new Date('2026-09-27T15:00:00')` without a `Z` is parsed as *local* time,
 * which is what these assertions are about; and building it from parts avoids
 * any chance of a parser deciding otherwise. The clock is fixed rather than
 * `new Date()` because a test that reads the real clock passes at 23:59 and
 * fails at 00:01, which is the failure that gets re-run until it goes away.
 */
const NOW = new Date(2026, 8, 27, 15, 0, 0); // 27 Sep 2026, 15:00 local

/** A local timestamp `daysAgo` days before NOW, at the given hour. */
function daysBefore(daysAgo: number, hour = 12): string {
  const at = new Date(2026, 8, 27 - daysAgo, hour, 0, 0);
  return at.toISOString();
}

describe('dateBucket', () => {
  it('puts today in today, at both ends of the day', () => {
    // 00:00 today is the boundary the calendar-day rule exists for: a rolling
    // 24-hour window would file it under "previous 7 days" and a reader looking
    // at "Today" would not find it.
    expect(dateBucket(daysBefore(0, 0), NOW)).toBe('today');
    expect(dateBucket(daysBefore(0, 15), NOW)).toBe('today');
  });

  it('puts yesterday and the six days before it in the previous week', () => {
    expect(dateBucket(daysBefore(1), NOW)).toBe('previous-7-days');
    expect(dateBucket(daysBefore(6), NOW)).toBe('previous-7-days');
  });

  it('stands on the seventh-day boundary rather than beside it', () => {
    // The one assertion here that is about the off-by-one, and the reason this
    // function takes `now`: a test written with the real clock cannot stand on
    // a boundary, only somewhere near it.
    expect(dateBucket(daysBefore(7), NOW)).toBe('previous-7-days');
    expect(dateBucket(daysBefore(8), NOW)).toBe('older');
  });

  it('files a time from late yesterday as yesterday, not as today', () => {
    // The 24-hour-window bug, stated as a case: at 15:00, something at 20:00
    // yesterday is 19 hours old and would be "today" to a rolling window. It is
    // *yesterday* to a person, and the buckets are for people.
    const late = new Date(2026, 8, 26, 20, 0, 0).toISOString();
    expect(dateBucket(late, NOW)).toBe('previous-7-days');
  });

  it('gives no bucket when there is no usable date', () => {
    // Not `older`. The provider sorts missing timestamps last because `None` is
    // not evidence of recency, and filing them under "Older" would assert
    // something about them that nothing knows — they may be brand new.
    expect(dateBucket(null, NOW)).toBeNull();
    expect(dateBucket(undefined, NOW)).toBeNull();
    expect(dateBucket('', NOW)).toBeNull();
    expect(dateBucket('not a date', NOW)).toBeNull();
  });

  it('treats a future timestamp as today rather than reaching for a fourth bucket', () => {
    // Clock skew between the agent and the browser is real, and a conversation
    // with a timestamp a few minutes ahead is still the current one. Worth
    // pinning because the alternative — a negative age falling through every
    // comparison — is how it would end up in "Older" and look like a bug.
    expect(dateBucket(daysBefore(-1), NOW)).toBe('today');
  });

  it('does not depend on the wall clock it was not given', () => {
    // The same input answers the same way two years apart, which is what makes
    // this file deterministic in CI.
    const ts = daysBefore(3);
    const later = new Date(2028, 0, 1, 9, 0, 0);
    expect(dateBucket(ts, NOW)).toBe('previous-7-days');
    expect(dateBucket(ts, later)).toBe('older');
  });
});
