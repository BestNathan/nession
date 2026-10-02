/**
 * Whether a message is still arriving.
 *
 * ## Provider first, page second
 *
 * A provider that states a per-message `status` is believed: `streaming` is
 * streaming and `settled` is not, whatever the page said. That is what the
 * status being in the shared model is *for* — a second provider (#1363 SC-12)
 * can say when a message finished, and a renderer that overrode that with its
 * own inference would be Claude's renderer wearing the shared contract.
 *
 * Claude Code never states a per-message status, and inventing one in the
 * adapter would make it assert something the provider never said. What it does
 * say is that the *page* ended mid-record, so `partialTail` remains the
 * fallback for a provider that says nothing about the message itself. The page's
 * fact is passed down and the fallback decides which row it lands on, which is a
 * rule that holds for any polling provider rather than for one wire.
 *
 * Under that fallback only the trailing assistant message can be streaming:
 * anything before it has been followed by something the provider considered
 * complete, and a user's own message is never "still arriving".
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
  if (item.role !== 'assistant') {
    return false
  }
  if (item.status !== undefined) {
    return item.status === 'streaming'
  }
  return partialTail && isLast
}
