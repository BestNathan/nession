import { describe, it, expect } from 'vitest';
import { bucketSessions, sessionBucketOf } from '../../sessionHistory';
import type { Session } from '@/types';

/**
 * In `unit/` rather than beside the App's other pure helpers in `integration/`
 * (`edgeBand.test.ts`, `appLayerPositions.test.ts`): this module touches no DOM,
 * and `unit` is the project whose environment is `node` (`vite.config.ts`). The
 * sibling that also has nothing to mount, `appTypography.test.ts`, is here too.
 */

/**
 * A local-midday anchor, written without a `Z` so it parses in the runner's own
 * zone. Bucket boundaries are local midnights, so a UTC literal would make every
 * expectation below depend on where the test runs.
 */
const NOW = new Date('2026-09-01T12:00:00').getTime();

/** A Session at `iso`, with only the fields this module reads. */
function at(iso: string, id = iso): Session {
  return {
    session_id: id,
    agent_id: 'a1',
    session_name: id,
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: iso,
  };
}

/** Local midnight of the day containing `NOW`, and the week boundary below it. */
const TODAY_START = new Date('2026-09-01T00:00:00').getTime();
const WEEK_START = new Date('2026-08-25T00:00:00').getTime();

describe('sessionBucketOf', () => {
  it('puts the current calendar day in today', () => {
    expect(sessionBucketOf(TODAY_START, NOW)).toBe('today');
    expect(sessionBucketOf(NOW, NOW)).toBe('today');
  });

  it('moves the boundary at local midnight, not 24 hours back', () => {
    // The reason the boundary is a calendar day: a screen left open across
    // midnight must not re-bucket last night's work as "today".
    expect(sessionBucketOf(TODAY_START - 1, NOW)).toBe('previous7');
    expect(sessionBucketOf(new Date('2026-08-31T23:59:59').getTime(), NOW)).toBe(
      'previous7',
    );
  });

  it('covers the seven calendar days before today', () => {
    expect(sessionBucketOf(WEEK_START, NOW)).toBe('previous7');
    expect(sessionBucketOf(WEEK_START - 1, NOW)).toBe('older');
    expect(sessionBucketOf(new Date('2026-08-31T00:00:00').getTime(), NOW)).toBe(
      'previous7',
    );
  });

  it('calls anything older than the week older', () => {
    expect(sessionBucketOf(new Date('2020-01-01T00:00:00').getTime(), NOW)).toBe(
      'older',
    );
  });
});

describe('bucketSessions', () => {
  it('returns buckets in history order regardless of the input order', () => {
    // Oldest first in, today first out: the order is the point of grouping and
    // does not follow from the sort the user picked.
    const buckets = bucketSessions(
      [
        at('2026-07-01T09:00:00', 'old'),
        at('2026-09-01T09:00:00', 'today'),
        at('2026-08-30T09:00:00', 'week'),
      ],
      NOW,
    );
    expect(buckets.map((b) => b.key)).toEqual(['today', 'previous7', 'older']);
    expect(buckets.map((b) => b.label)).toEqual([
      'Today',
      'Previous 7 days',
      'Older',
    ]);
    expect(buckets.flatMap((b) => b.sessions.map((s) => s.session_id))).toEqual([
      'today',
      'week',
      'old',
    ]);
  });

  it('drops empty buckets rather than rendering a label with nothing under it', () => {
    const buckets = bucketSessions([at('2026-09-01T09:00:00')], NOW);
    expect(buckets.map((b) => b.key)).toEqual(['today']);
  });

  it('keeps the caller order inside a bucket', () => {
    // `useDashboard` already sorted these, possibly by name. Re-sorting here
    // would overrule a user who chose Name.
    const buckets = bucketSessions(
      [
        at('2026-09-01T09:00:00', 'zebra'),
        at('2026-09-01T08:00:00', 'apple'),
        at('2026-09-01T07:00:00', 'mango'),
      ],
      NOW,
    );
    expect(buckets[0]?.sessions.map((s) => s.session_id)).toEqual([
      'zebra',
      'apple',
      'mango',
    ]);
  });

  it('returns nothing for no sessions', () => {
    expect(bucketSessions([], NOW)).toEqual([]);
  });

  it('returns one bucket when the whole list falls in one stretch', () => {
    // This is the signal `AppSessionsSurface` reads as "not grouped": one label
    // over one bucket is noise, and the issue says so ("a flat list is
    // acceptable").
    const buckets = bucketSessions(
      [at('2026-09-01T09:00:00'), at('2026-09-01T08:00:00')],
      NOW,
    );
    expect(buckets).toHaveLength(1);
  });
});
