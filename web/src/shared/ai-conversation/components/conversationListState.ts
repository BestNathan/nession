/**
 * The two pure questions the conversation directory asks about its own state.
 *
 * Kept out of the surface file so its exports stay components only (React
 * Fast Refresh); both the shared surface and `ConversationView` read the same
 * answers rather than re-deriving "is the list blocked" in two places.
 */

import type { AIConversationSnapshot } from '../runtime/ConversationRuntime'

/**
 * The list's refresh failed while the rows it already had are still readable.
 *
 * Bounded and inline, above the rows rather than replacing them — the same
 * shape older paging uses, and for the same reason: the reader still has a list
 * to choose from, and taking it away because a refresh missed would punish them
 * for the network.
 */
export function listRefreshMessage(snapshot: AIConversationSnapshot): string | null {
  if (snapshot.listError) {
    return snapshot.listError
  }
  if (snapshot.conversations.length > 0 && snapshot.listState === 'unavailable') {
    return 'Conversations cannot be refreshed right now'
  }
  return null
}

/**
 * Whether the list has nothing to offer and the guard should speak instead.
 *
 * A failure or a load in progress with rows already on screen is *not* blocked:
 * the rows a reader can already see are worth more than a message about a
 * refresh that is still going.
 */
export function listIsBlocked(snapshot: AIConversationSnapshot): boolean {
  // Nothing to choose from and nothing open: whatever the reason — still
  // loading, failed, unavailable, or answered-empty — the guard is the whole
  // story and an empty list would be a worse way to tell it.
  return snapshot.conversations.length === 0 && snapshot.openId === null
}
