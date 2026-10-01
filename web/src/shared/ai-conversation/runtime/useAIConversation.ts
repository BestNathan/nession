/**
 * A conversation, bound to a React component's lifetime.
 *
 * This is the only hook a surface needs. It owns the runtime's creation and
 * disposal and points it at a context; everything else — selection, paging,
 * refresh, reconciliation — is the runtime's, and everything a surface *draws*
 * comes from the snapshot this returns.
 *
 * ## Why the context is keyed, not compared
 *
 * A surface builds its context inline (`{ agentId, sessionId }`), so the object
 * is new on every render and an effect depending on it would run forever. The
 * adapter's `contextKey` is the stable answer to "is this the same conversation
 * space", so the effect depends on *that*, and the latest context object is
 * held in a ref for the call itself. This is the same reason the runtime asks
 * the adapter for a key rather than comparing contexts itself.
 *
 * ## Why disposal is safe to be StrictMode-double-invoked
 *
 * React mounts, unmounts and mounts again in development. This hook disposes in
 * its cleanup and points the runtime at its context again on the next run, so
 * the second mount gets a working runtime rather than a dead one — which is why
 * `setContext` re-arms.
 */

import { useEffect, useRef, useState } from 'react'
import type { AIConversationAdapter } from '../adapter/types'
import { ConversationRuntime, type AIConversationSnapshot } from './ConversationRuntime'
import { useConversationSnapshot } from './useConversationSnapshot'

export interface AIConversationHandle {
  snapshot: AIConversationSnapshot
  /** Open a conversation the reader chose; `null` returns to the binding. */
  select: (conversationId: string | null) => void
  /** Ask again — the list's only refresh, by design. */
  reload: () => void
  /** Fetch the page before the loaded window; answers whether one engaged. */
  loadOlder: () => boolean
}

/**
 * `adapter` is expected to be stable — a module-level constant, or built once
 * by the caller. It is read on the first render only, so a new adapter object
 * per render is harmless to correctness but would be a new provider identity,
 * which is not a thing a re-render should be able to change.
 */
export function useAIConversation<Context>(
  adapter: AIConversationAdapter<Context>,
  context: Context | null,
): AIConversationHandle {
  const [runtime] = useState(() => new ConversationRuntime(adapter))
  const contextRef = useRef(context)
  contextRef.current = context
  const key = context === null ? null : adapter.contextKey(context)

  useEffect(() => {
    runtime.setContext(contextRef.current)
  }, [runtime, key])

  useEffect(() => () => runtime.dispose(), [runtime])

  const snapshot = useConversationSnapshot(runtime)
  return {
    snapshot,
    select: (conversationId) => runtime.select(conversationId),
    reload: () => runtime.reload(),
    loadOlder: () => runtime.loadOlder(),
  }
}
