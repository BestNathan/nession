/**
 * Claude Code as a provider of the shared conversation contract.
 *
 * The whole of Claude's participation is this file and
 * [`normalizers`](./normalizers.ts). It declares where its conversations come
 * from, how to read one, and how it learns that one changed; it declares
 * nothing about how any of that is drawn, and there is nowhere in the contract
 * to put such a declaration (#1363 SC-04, SC-10).
 *
 * ## What stays Claude's, and why that is the correct list
 *
 * - The two units' request shapes and the routing field the contract does not
 *   carry — `agent_id` finds the target, it is not part of what the target is
 *   asked.
 * - The page sizes. The provider clamps them to its own ceiling; the adapter
 *   asks for that ceiling and exposes the provider cursor, while the shared
 *   runtime continues until the directory is complete.
 * - The poll interval. Whether a provider polls, is pushed to, or waits to be
 *   asked is a fact about the provider's transport, and Claude Code has no push
 *   channel for conversations — `#1005` scope 5 allows polling for v1, and the
 *   contract keeps the choice visible rather than baking it into the runtime.
 * - Tool-call pairing and the one-line summary, which are already done
 *   provider-side and arrive as one `tool` item.
 */

import {
  ConversationRuntime,
  type AIConversationAdapter,
  type AIConversationListResult,
  type AIConversationPage,
} from '@/shared/ai-conversation'
import { claudeCodeApi } from '../ClaudeCodePlugin'
import type {
  ClaudeCodeConversationsRequest,
  ClaudeCodeConversationsResponse,
  ClaudeCodeMessagesRequest,
  ClaudeCodeMessagesResponse,
} from '../types'
import { toActivity, toItem, toSummary } from './normalizers'

/** What a conversation request is scoped by, for this provider. */
export interface ClaudeCodeConversationContext {
  agentId: string
  sessionId: string
}

/**
 * The two operations this adapter needs, and nothing else.
 *
 * Declared structurally rather than as `ClaudeCodePlugin` on purpose: what the
 * adapter requires of the capability is two calls, and saying so is what makes
 * that a checked fact. The plugin satisfies this by shape, a test satisfies it
 * with an object literal, and a future change that made the adapter reach for a
 * third operation would have to come back here and admit it.
 */
export interface ClaudeCodeConversationApi {
  claudeCodeConversations(
    request: ClaudeCodeConversationsRequest,
  ): Promise<ClaudeCodeConversationsResponse>
  claudeCodeMessages(request: ClaudeCodeMessagesRequest): Promise<ClaudeCodeMessagesResponse>
}

/** Ask for the provider's own ceiling; the runtime follows the returned cursor. */
const LIST_LIMIT = 200

/** One page of a timeline. The provider clamps this to its ceiling. */
const PAGE_LIMIT = 60

/**
 * How often the newest page is re-read while Claude is running.
 *
 * Polling, not a stream: this capability has no push channel, and a live
 * conversation frozen on screen is worse than a re-read that changes nothing.
 * The runtime stops asking on its own once the provider says `inactive`, so
 * this interval only governs a conversation that is still moving.
 */
const POLL_INTERVAL_MS = 3000

/**
 * Build the adapter over an API client.
 *
 * The client is a parameter so a test can drive the adapter with recorded
 * responses rather than a live socket, and so the eventual second provider has
 * an example of how little of Nession the contract actually needs.
 */
export function createClaudeCodeAdapter(
  api: ClaudeCodeConversationApi = claudeCodeApi,
): AIConversationAdapter<ClaudeCodeConversationContext> {
  return {
    id: 'claude-code',
    identity: { label: 'Claude' },

    // The Session *is* the conversation space: conversations are listed at a
    // Session's cwd, so two Sessions are two different directories, and a
    // selection made in one is not a selection in the other.
    contextKey: (context) => `${context.agentId}:${context.sessionId}`,

    async list(context, cursor): Promise<AIConversationListResult> {
      const response = await api.claudeCodeConversations({
        agent_id: context.agentId,
        session_id: context.sessionId,
        limit: LIST_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      const bound = response.binding ?? null
      const nextCursor = response.has_more ? (response.next_cursor ?? null) : null
      if (response.state === 'ready' && response.has_more && nextCursor === null) {
        throw new Error('Claude conversation list said more pages exist without a cursor')
      }
      return {
        state: response.state,
        conversations: (response.items ?? []).map((item) =>
          toSummary(
            item,
            // Only the bound conversation has an activity the provider can
            // state — it is a fact about the *binding*, relative to this
            // Session, and the wire says nothing about the others. Reporting
            // `unknown` for them is the honest answer, and it is a real state
            // in the model rather than a missing one.
            item.id === bound?.conversation_id ? toActivity(bound.activity) : 'unknown',
          ),
        ),
        bindingId: bound?.conversation_id ?? null,
        nextCursor,
        error: response.error ?? null,
      }
    },

    async read(context, conversationId, cursor): Promise<AIConversationPage> {
      const response = await api.claudeCodeMessages({
        agent_id: context.agentId,
        session_id: context.sessionId,
        conversation_id: conversationId,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      })
      const activity = response.activity ? toActivity(response.activity) : null
      return {
        state: response.state,
        // From the response itself, not from a lookup into the list by id: the
        // header renders from this object, and #1222 removed the join.
        conversation: response.conversation
          ? toSummary(response.conversation, activity ?? 'unknown')
          : null,
        activity,
        items: (response.items ?? []).map(toItem),
        nextCursor: response.next_cursor ?? null,
        partialTail: response.partial_tail,
        skipped: response.skipped,
        error: response.error ?? null,
      }
    },

    refresh: { kind: 'poll', intervalMs: POLL_INTERVAL_MS },
  }
}

/**
 * The one adapter instance, for surfaces to hand to `useAIConversation`.
 *
 * A module-level constant rather than a call at each site: the hook reads it on
 * the first render and treats it as the provider's identity, so a surface
 * building a new adapter per render would be asserting that the provider
 * changed. Building it once is what makes that impossible to get wrong.
 */
export const claudeCodeConversationAdapter = createClaudeCodeAdapter()

/**
 * A runtime already pointed at this provider.
 *
 * Surfaces do not each build their own bridge: the provider declares how it is
 * driven, and this is that declaration in one place. A second provider adds one
 * of these next to its adapter and nothing else.
 */
export function createClaudeCodeRuntime(
  api: ClaudeCodeConversationApi = claudeCodeApi,
): ConversationRuntime<ClaudeCodeConversationContext> {
  return new ConversationRuntime(createClaudeCodeAdapter(api))
}
