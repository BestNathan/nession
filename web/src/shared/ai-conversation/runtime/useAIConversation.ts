/**
 * A conversation, bound to a React component's lifetime.
 *
 * This is the only hook a surface needs. It owns the runtime's creation and
 * disposal and points it at a context; everything else — selection, paging,
 * refresh, reconciliation — is the runtime's, and everything a surface *draws*
 * comes from the snapshot this returns.
 *
 * ## Why the key does not stand in for the context
 *
 * A surface builds its context inline (`{ agentId, sessionId }`), so the object
 * is new on every render — and the effect that hands it to the runtime runs
 * every render for that reason. It used to depend on `adapter.contextKey`
 * instead, to keep a per-render object out of a dependency list, and that
 * quietly made the key stand in for the value: a provider whose context carries
 * a token, a lease or a client handle may change one without moving the
 * conversation space, and the runtime went on asking with the context it had
 * replaced (`#1363` round 4).
 *
 * Keying is still how the runtime decides *identity* — a new key resets the
 * conversation space and a same-key value does not — but that decision belongs
 * to `setContext`, which sees both, rather than to a dependency list that can
 * only see one.
 *
 * ## Why disposal is safe to be StrictMode-double-invoked
 *
 * React mounts, unmounts and mounts again in development. This hook disposes in
 * its cleanup and points the runtime at its context again on the next run, so
 * the second mount gets a working runtime rather than a dead one — which is why
 * `setContext` re-arms.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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

  // Depending on the *value*, not on the key derived from it.
  //
  // A surface builds its context inline, so this effect runs on every render
  // where the object is new — which it always is. That is affordable now
  // because `setContext` answers a same-key value by replacing what the next
  // adapter call receives and nothing else, so the common case is one
  // assignment. Depending on the key instead was the defect: a provider whose
  // context carries a token, a lease or a client handle can change one without
  // moving the conversation space, and the runtime went on polling with the
  // context it had replaced (`#1363` round 4).
  useEffect(() => {
    runtime.setContext(context)
  }, [runtime, context])

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
