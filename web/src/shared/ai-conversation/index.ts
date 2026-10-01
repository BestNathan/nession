/**
 * The shared AI conversation framework — the one import path a provider or a
 * surface uses.
 *
 * ## Why a barrel, and why it is the *only* public path
 *
 * A provider adapter imports this module; it does not import
 * `runtime/ConversationRuntime` or `components/ConversationMessage`. Keeping the
 * deep paths unreachable is what makes "a provider cannot reach into the shared
 * renderer" a property of the code rather than a rule in a document — the same
 * reason `nession/no-deep-capability-imports` exists for capabilities (#801).
 *
 * ## What a provider gets, and what it does not
 *
 * It gets the model to fill in, the adapter contract to implement, the runtime
 * to be driven by, and (from stage 2) the components that draw the result. It
 * does not get a slot to inject a React node into any of them (#1363 SC-10).
 */

export type {
  AIConversationActivity,
  AIConversationContent,
  AIConversationItem,
  AIConversationListState,
  AIConversationReadState,
  AIConversationSummary,
  AIMessageItem,
  AIMessageRole,
  AIMessageStatus,
  AITextContent,
  AIUnknownContent,
  AIUnknownItem,
  AIToolItem,
  AIToolPayload,
  AIToolStatus,
} from './model/conversation'

export type {
  AIConversationAdapter,
  AIConversationContext,
  AIConversationIdentity,
  AIConversationListResult,
  AIConversationPage,
  AIRefreshPolicy,
} from './adapter/types'

export { ConversationRuntime } from './runtime/ConversationRuntime'
export type {
  AIConversationSnapshot,
  ConversationScheduler,
} from './runtime/ConversationRuntime'

export {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
} from './runtime/pagination'
export type { ConversationPositions } from './runtime/pagination'
export { reusing } from './runtime/reconcile'

export { useConversationSnapshot } from './runtime/useConversationSnapshot'
