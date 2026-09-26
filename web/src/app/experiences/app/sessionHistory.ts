import type { Session } from '@/types';

/**
 * Time buckets for the App's Session history (#1083).
 *
 * The App's Sessions layer is a conversation navigator, so its list is grouped
 * the way a history list is: by when the work last happened. The alternative
 * the issue rejects is the per-row recency that shipped — `bash · devbox-01 ·
 * 25d ago` on every row — which states time once per row and makes each row
 * read like an observability record. Grouping states it once per bucket, where
 * it can be scanned instead of read.
 *
 * **Grouping and per-row recency are mutually exclusive**, and that is a
 * property of the *view*, not of this function: `AppSessionsSurface` derives one
 * boolean from {@link bucketSessions}'s result and drives both from it, so the
 * two cannot disagree. This module deliberately knows nothing about it.
 *
 * ## Why `now` is a parameter
 *
 * Bucket membership is relative to the present, so a function that read
 * `Date.now()` itself could only be tested by moving the clock. `formatRelativeTime`
 * (`shared/lib/format.ts`) has that dependency and is pinned through Playwright's
 * frozen clock instead; a pure module has no such escape hatch, and jsdom runs
 * with the real clock. Passing `now` makes every boundary a literal.
 *
 * ## Boundaries are calendar days, not 168 hours
 *
 * "Today" means the user's calendar day, so the boundary is their local
 * midnight — not `now - 24h`, which would move the whole list under a user who
 * left the screen open past midnight. "Previous 7 days" is the seven calendar
 * days before today, for the same reason. Each boundary is re-normalised to a
 * local midnight after the arithmetic, because subtracting a fixed 7×24h across
 * a daylight-saving change lands an hour off and would put a Session in the
 * wrong bucket twice a year.
 *
 * ## Empty buckets are dropped
 *
 * The issue is explicit — "do not introduce buckets unless there is at least one
 * Session in them" — and it is also what keeps a six-Session fixture from
 * rendering two empty labels. A consequence worth knowing: a list whose Sessions
 * all fall in one bucket returns **one** bucket, which the surface treats as
 * "not grouped" and renders flat.
 */

/** Which bucket a Session belongs to. */
export type SessionBucketKey = 'today' | 'previous7' | 'older';

/** One non-empty stretch of Session history, in presentation order. */
export interface SessionBucket {
  key: SessionBucketKey;
  /** What the group label reads. Copy belongs to the App, which is this layer. */
  label: string;
  sessions: Session[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the local calendar day containing `ms`. */
function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Which bucket a Session last active at `lastActivity` falls in, given `now`.
 *
 * Exported for the surface's own tests and for callers that need one row's
 * bucket without building the whole list; the grouping itself is
 * {@link bucketSessions}.
 */
export function sessionBucketOf(
  lastActivity: number,
  now: number,
): SessionBucketKey {
  const todayStart = startOfLocalDay(now);
  if (lastActivity >= todayStart) {
    return 'today';
  }
  const weekStart = startOfLocalDay(todayStart - 7 * DAY_MS);
  if (lastActivity >= weekStart) {
    return 'previous7';
  }
  return 'older';
}

const LABELS: Record<SessionBucketKey, string> = {
  today: 'Today',
  previous7: 'Previous 7 days',
  older: 'Older',
};

const ORDER: SessionBucketKey[] = ['today', 'previous7', 'older'];

/**
 * Group `sessions` into the buckets they belong to, dropping empty ones.
 *
 * **Order within a bucket is the caller's, not this function's.** The list's
 * sort control (`useDashboard.filterSessions`) already ordered the array, and a
 * re-sort here would silently overrule a user who chose "Name".
 *
 * Buckets come back in fixed order — today, then the previous seven days, then
 * older — because that order is the point of grouping and does not follow from
 * the sort the user picked.
 */
export function bucketSessions(
  sessions: Session[],
  now: number,
): SessionBucket[] {
  const byKey = new Map<SessionBucketKey, Session[]>();
  for (const session of sessions) {
    const key = sessionBucketOf(new Date(session.last_activity).getTime(), now);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [session]);
    } else {
      bucket.push(session);
    }
  }
  return ORDER.flatMap((key) => {
    const bucket = byKey.get(key);
    return bucket === undefined ? [] : [{ key, label: LABELS[key], sessions: bucket }];
  });
}
