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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
 * `adapter` identifies the provider, and a different adapter is a *different
 * provider*: the runtime is replaced and the previous one disposed. That is what
 * makes a provider switch real rather than decorative (`#1363` round 3) — and it
 * raises the cost of an unstable one, because a new adapter object on every
 * render would be a new runtime on every render. Build it once: a module-level
 * constant, or a `useMemo`.
 */
export function useAIConversation<Context>(
  adapter: AIConversationAdapter<Context>,
  context: Context | null,
): AIConversationHandle {
  // The runtime is owned by the *provider*, not by this component: a runtime
  // built for one adapter cannot answer for another, and `useState`'s
  // initialiser runs exactly once — so a changed adapter used to be ignored
  // outright, and the hook went on answering the first provider forever.
  //
  // Replaced rather than mutated, and that is the half that makes the swap safe:
  // the old runtime is *disposed*, `wanted()` refuses everything once `disposed`
  // is set, and the generation counters belong to one runtime alone — so a
  // response A is still holding cannot land in B even if it resolves after the
  // switch.
  const [entry, setEntry] = useState(() => ({
    adapter,
    runtime: new ConversationRuntime(adapter),
  }))
  // Adjusting state during render, which React documents for a prop whose
  // identity changed. It re-renders before committing, so the new provider is
  // never drawn with the old runtime's snapshot — and the discarded pass runs no
  // effects, which is where subscriptions live.
  if (entry.adapter !== adapter) {
    setEntry({ adapter, runtime: new ConversationRuntime(adapter) })
  }
  const { runtime } = entry
  const contextRef = useRef(context)
  contextRef.current = context
  const key = context === null ? null : adapter.contextKey(context)

  useEffect(() => {
    runtime.setContext(contextRef.current)
  }, [runtime, key])

  useEffect(() => () => runtime.dispose(), [runtime])

  const snapshot = useConversationSnapshot(runtime)

  // Each command is stable for the runtime's lifetime, and that is a
  // correctness property rather than a micro-optimisation. The transcript
  // watches `loadOlder` in an effect dependency list — a page arriving is what
  // should pull the next one — and an identity that changed every render would
  // re-run that effect every render, paging for reasons that have nothing to do
  // with a page arriving. Memoising the *object* alone would not do it: the
  // snapshot changes on every update, so the object is rebuilt and would carry
  // fresh arrows with it.
  const select = useCallback(
    (conversationId: string | null) => runtime.select(conversationId),
    [runtime],
  )
  const reload = useCallback(() => runtime.reload(), [runtime])
  const loadOlder = useCallback(() => runtime.loadOlder(), [runtime])

  return useMemo(
    () => ({ snapshot, select, reload, loadOlder }),
    [snapshot, select, reload, loadOlder],
  )
}
