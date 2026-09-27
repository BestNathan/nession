/**
 * Which date group a conversation belongs to in the list (#1120 item 5).
 *
 * The scope calls this optional ("may group by date buckets where that improves
 * scanning"), and the reason to do it is the same reason the list got a preview
 * line: a flat list of titles is a list you read from the top every time, and
 * the question a reader actually has is "which of these is recent".
 *
 * ## Why `now` is a parameter
 *
 * A relative label is the one thing in this component that changes without
 * anything changing. Defaulting to `new Date()` at the call site would make the
 * function untestable at exactly the boundaries that matter — midnight, and the
 * seventh day back — and those are where a bug would live. Passing it in means
 * the tests can stand on a boundary rather than beside it.
 *
 * ## Calendar days, not 24-hour windows
 *
 * "Today" has to mean the day the reader is in, not "the last 24 hours": at
 * 09:00, something from 20:00 yesterday is *yesterday* to a person and would be
 * "today" to a rolling window. So the boundaries are local midnights, and
 * "Previous 7 days" is the seven days before the current one — which is also
 * what makes the buckets line up with how the App's history language reads.
 *
 * ## `null` is an answer
 *
 * A conversation with no timestamp, or an unparseable one, gets **no bucket**
 * rather than being filed under `older`. The provider sorts those last on
 * purpose (`None` is "not evidence of recency"), and putting them in `older`
 * would assert a fact about them that nothing knows. The caller renders them
 * after the buckets, without a heading.
 */
export type DateBucket = 'today' | 'previous-7-days' | 'older';

/** Milliseconds in a day, as the calendar arithmetic below uses it. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight at the start of `at`'s local day.
 *
 * Built from the local Y/M/D rather than by subtracting a time-of-day offset,
 * because `setHours(0,0,0,0)` is the one form that stays correct across a DST
 * transition — subtracting `getHours()` hours would land an hour off on the two
 * days a year the offset changes.
 */
function startOfDay(at: Date): number {
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/**
 * The bucket `timestamp` falls in, or `null` when there is no usable date.
 */
export function dateBucket(
  timestamp: string | null | undefined,
  now: Date = new Date(),
): DateBucket | null {
  if (!timestamp) {
    return null;
  }
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }

  const today = startOfDay(now);
  const when = at.getTime();
  if (when >= today) {
    return 'today';
  }
  // Seven *whole* days before today, so the window is today plus the seven days
  // that precede it — an item exactly seven days old is in the previous week,
  // not outside it.
  if (when >= today - 7 * DAY_MS) {
    return 'previous-7-days';
  }
  return 'older';
}
