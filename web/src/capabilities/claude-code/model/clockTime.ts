/**
 * A record's own timestamp, as a clock time (#1120).
 *
 * Short on purpose: the reading order is the transcript's order, so the
 * timestamp is orientation rather than information. Anything unparseable is
 * dropped rather than shown raw — an RFC 3339 string in the middle of a
 * sentence is worse than no time at all.
 *
 * Shared by the transcript and the candidate list rather than duplicated in
 * each, because the two must agree: a row reading `10:06` that opens a
 * transcript whose newest message reads something else is a discrepancy the
 * reader has no way to resolve, and no test would catch it. `#1120`'s list
 * redesign adds a date bucket beside these times, which is a second reason for
 * one owner — "Yesterday" and `10:06` have to be derived from the same clock.
 */
export function clockTime(timestamp: string | null | undefined): string | null {
  if (!timestamp) {
    return null;
  }
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
