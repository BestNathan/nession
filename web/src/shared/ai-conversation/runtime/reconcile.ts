/**
 * Keeping object identity across a refresh — and keeping the items themselves.
 *
 * ## Why identity, when the ids were already stable
 *
 * A poll re-reads the newest page every few seconds. The ids in that page are
 * stable, so keying by id already prevents React from *remounting* an item —
 * but it does not prevent it from *re-rendering* one, and re-rendering a
 * message means re-parsing its Markdown. Parsing is the expensive part of
 * drawing a transcript, and a poll that says exactly what the last poll said
 * should cost nothing.
 *
 * Giving back the previous object for an item whose content did not change,
 * paired with `memo` on the item components, is what makes a refresh cost only
 * the items that actually changed (#1363 SC-07, and "App/Web remain responsive
 * for long transcripts" in #1167's terms).
 *
 * ## Why merging, and not replacing
 *
 * A refresh answers with the provider's **tail page** — a fixed-size window over
 * the newest items. When the conversation grows, that window slides: the item
 * that used to head it falls off the back and stops being mentioned by any
 * response. An operation that let the page redefine a *range* therefore drops
 * it, even though nothing about it changed and the reader can see it. That is
 * the P0 in #1363's post-implementation review, and it is why the primitive here
 * is a merge rather than a replace.
 *
 * ## Why comparing by serialization is acceptable
 *
 * The items arrive as JSON. They have no cycles, no class instances and no
 * identity beyond their values, so a structural comparison is a value
 * comparison. The cost is the right way round, too: stringifying a page is
 * microseconds while the thing it avoids — re-parsing that page's Markdown — is
 * milliseconds. Key order is whatever the parser produced, so equal items
 * compare equal; if that ever stopped holding, the consequence is a missed
 * reuse, not a wrong render.
 */

import type { AIConversationItem } from '../model/conversation'

/**
 * Merge a page into the items already held, oldest-first.
 *
 * The held order wins. An item the page restates keeps its place in the window
 * rather than moving to wherever the page happens to put it, and its previous
 * object comes back when nothing changed — which is the identity half above.
 *
 * An id the page names that the window has never held is *newer than everything
 * held*, because that is what a tail page is; it is appended.
 *
 * A held item the page does not mention is kept. That half is deliberate, not an
 * oversight: it is exactly the item the sliding window stopped mentioning, and
 * dropping it is what loses something the reader can see. The cost is that a
 * provider which *deletes* an item cannot remove it from the window this way —
 * the window keeps a ghost until the conversation is reopened. Visible history
 * that stays is the better failure of the two.
 */
export function merging(
  held: AIConversationItem[],
  arriving: AIConversationItem[],
): AIConversationItem[] {
  if (arriving.length === 0) {
    return held
  }
  if (held.length === 0) {
    return arriving
  }

  const arrivingById = new Map(arriving.map((item) => [item.id, item]))
  const heldIds = new Set(held.map((item) => item.id))

  const merged = held.map((item) => {
    const next = arrivingById.get(item.id)
    if (next === undefined || sameItem(item, next)) {
      return item
    }
    return next
  })

  for (const item of arriving) {
    if (!heldIds.has(item.id)) {
      merged.push(item)
    }
  }
  return merged
}

function sameItem(a: AIConversationItem, b: AIConversationItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
