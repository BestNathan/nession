/**
 * What to call a conversation in a list row or a header (#1120).
 *
 * The conversation's identity is a UUID, and an identity is not a label. A
 * list reading
 *
 * ```text
 * d2b4c1d5-…
 * a8fe36a1-…
 * 977fbe34-…
 * ```
 *
 * cannot answer the only question a person has — *which one was I discussing
 * terminal ownership in?* — so the title the provider read from the transcript
 * leads, and the UUID is left to the tooltip, which is where #1120 puts it for
 * Web: available as identity and debug, absent as product text.
 *
 * ## The fallback announces itself
 *
 * Roughly a fifth of real transcripts carry no title (measured: 3 of 14), so
 * this is a real path rather than a defensive one. What it returns there is a
 * **date presented as a date** — `Conversation · Sep 27, 10:06` — and never a
 * stand-in that reads like a name. That distinction is the whole reason the
 * provider reports absence instead of inventing a string: if both arrived as
 * some plausible-looking text, "Claude named this" and "nobody named this"
 * would be indistinguishable, and no caller could recover the difference.
 */

/** The candidate fields a label is derived from, so callers need not carry more. */
export interface LabelledConversation {
  title?: string | null;
  updated_at?: string | null;
}

/**
 * The label for a conversation, and never an empty string.
 *
 * A title is used verbatim when there is one: the provider returns it
 * untruncated and in whatever language Claude wrote it (measured titles include
 * `"app-sessions-redesign"`, `"dingtalk_auth"` and `"底板反向条件分支"`), and
 * shortening belongs to the element that knows its own width.
 *
 * `locale` is passed through to the date fallback rather than left to the
 * environment, so a test can assert a format instead of asserting whatever the
 * machine happens to be set to.
 */
export function conversationLabel(
  conversation: LabelledConversation | null | undefined,
  locale?: string,
): string {
  const title = conversation?.title?.trim();
  if (title) {
    return title;
  }

  const when = conversationDate(conversation?.updated_at, locale);
  return when === null ? 'Conversation' : `Conversation · ${when}`;
}

/**
 * A short absolute date and time, or `null` when there is nothing to format.
 *
 * Absolute rather than relative (`2 hours ago`) because this stands in for a
 * name rather than describing recency, and a label that changed every time the
 * component re-rendered would be a worse name than a fixed one. An
 * unparseable timestamp is dropped rather than shown raw — the same rule the
 * transcript's own timestamps follow.
 */
function conversationDate(timestamp: string | null | undefined, locale?: string): string | null {
  if (!timestamp) {
    return null;
  }
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  const date = at.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}
