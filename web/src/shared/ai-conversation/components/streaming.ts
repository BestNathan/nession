/**
 * Which message the page's partial tail applies to.
 *
 * Deliberately **not** read from the item. Claude Code never states a
 * per-message status, and inventing one in the adapter would make it assert
 * something the provider never said; what a provider does say — when it says
 * anything — is that the *page* ended mid-record (SC-11's partial tail). So the
 * page's fact is passed down and this decides which row it lands on, which is a
 * rule that holds for any polling provider rather than for one wire.
 *
 * Only the trailing assistant message can be streaming: anything before it has
 * been followed by something the provider considered complete, and a user's own
 * message is never "still arriving".
 *
 * A separate module from the components because a component file exports
 * components — and because this rule is worth a unit test of its own rather
 * than being reachable only through a render.
 */

import type { AIMessageItem } from '../model/conversation'

export function isStreaming(
  item: AIMessageItem,
  isLast: boolean,
  partialTail: boolean,
): boolean {
  return partialTail && isLast && item.role === 'assistant'
}
