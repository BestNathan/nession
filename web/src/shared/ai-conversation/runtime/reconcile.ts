/**
 * Keeping object identity across a refresh.
 *
 * ## Why identity, when the ids were already stable
 *
 * A poll replaces the newest page every few seconds. The ids in that page are
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
 * Give back the previous objects for the items that did not change.
 *
 * Items are matched by `id`, which the model defines as stable within a
 * conversation. An item whose content changed (a streaming message growing, a
 * tool that went from `running` to `success`) is a new object, so its component
 * re-renders — which is exactly what should happen, because it changed.
 */
export function reusing(
  previous: AIConversationItem[],
  next: AIConversationItem[],
): AIConversationItem[] {
  if (previous.length === 0) {
    return next
  }
  const before = new Map(previous.map((item) => [item.id, item]))
  return next.map((item) => {
    const held = before.get(item.id)
    return held !== undefined && sameItem(held, item) ? held : item
  })
}

function sameItem(a: AIConversationItem, b: AIConversationItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
