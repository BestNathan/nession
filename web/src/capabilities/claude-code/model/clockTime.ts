import { formatClockTime } from '@/shared/lib/format';

/**
 * A record's own timestamp, as a clock time (#1120).
 *
 * **Delegates to the shared formatter** since #1363. The transcript is now a
 * shared component that cannot import a capability, so the formatter had to
 * move down; keeping this name means the capability's callers and its
 * candidate list do not change, and means there is still exactly one place that
 * decides what a timestamp looks like. A second implementation here would let a
 * row reading `10:06` open a transcript whose newest message reads something
 * else — the discrepancy the original note warned about.
 */
export function clockTime(timestamp: string | null | undefined): string | null {
  return formatClockTime(timestamp);
}
