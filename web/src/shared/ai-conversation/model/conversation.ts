/**
 * A conversation as a whole: how it is listed, how live it is, and what it is
 * made of.
 *
 * This module is the union point of the model — the three files under `model/`
 * are split by what the parts *mean*, and this one names the whole. Nothing
 * here knows what a Claude or a Codex is; a provider teaches the shared model
 * its dialect in `capabilities/<provider>/conversation/`, and the direction of
 * that dependency is enforced by `nession/no-reverse-imports` rather than by
 * review.
 */

import type { AIMessageItem } from './content'
import type { AIToolItem } from './activity'

// Re-exported here so `model/` reads as one vocabulary to everything outside
// it: a consumer imports the model from one path, and the internal split by
// *meaning* stays an implementation detail of this directory.
export type {
  AIConversationContent,
  AIMessageItem,
  AIMessageRole,
  AIMessageStatus,
  AITextContent,
  AIUnknownContent,
} from './content'
export type {
  AIToolCategory,
  AIToolItem,
  AIToolPayload,
  AIToolStatus,
} from './activity'

/**
 * Whether the conversation is still being written to, relative to the context
 * that asked.
 *
 * `unknown` means the provider could not say — not that it is inactive. The
 * runtime keeps refreshing on `unknown`, because a live conversation frozen on
 * screen is a worse answer than a re-read that changes nothing (#1222's rule,
 * preserved here).
 */
export type AIConversationActivity = 'active' | 'inactive' | 'unknown'

/**
 * One conversation, as a list row and as a header.
 *
 * `id` is identity; `title` and `preview` are display metadata that may repeat
 * across conversations and must never be used to select one. That distinction
 * was measured in #1222 and is the reason the binding is an id rather than a
 * title match.
 */
export interface AIConversationSummary {
  id: string
  /** The provider's own title, when it wrote one. */
  title?: string | null
  /** What the user last asked, when the provider recorded it. */
  preview?: string | null
  activity: AIConversationActivity
  /** Newest timestamp the conversation carries, when it carries one. */
  updatedAt?: string | null
}

/**
 * A record the adapter could not map onto a message or a tool.
 *
 * Its presence is the honest alternative to dropping a record: the transcript
 * says "something was here that this client does not model", and the runtime
 * counts it so the surface can say the same.
 */
export interface AIUnknownItem {
  kind: 'unknown'
  id: string
  timestamp?: string | null
}

export type AIConversationItem = AIMessageItem | AIToolItem | AIUnknownItem

/**
 * What a provider answered about a directory of conversations.
 *
 * `unavailable` is not `empty`: "this host does not have that directory" and
 * "that directory has no conversations" are different sentences to a reader,
 * and #1222 made them different states precisely so a surface could stop
 * conflating them.
 */
export type AIConversationListState = 'ready' | 'unavailable' | 'error'

/**
 * What a provider answered about one conversation.
 *
 * `not_found` is separate from `error` for the same reason: a conversation that
 * was deleted or never existed is not a failure to read one, and the runtime
 * keeps the selection on it rather than bouncing the reader back to the list.
 */
export type AIConversationReadState = 'ready' | 'not_found' | 'unavailable' | 'error'
