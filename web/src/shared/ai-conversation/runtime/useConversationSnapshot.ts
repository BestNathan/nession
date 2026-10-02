/**
 * The React binding of [`ConversationRuntime`](./ConversationRuntime.ts).
 *
 * One hook, and the only place React and the runtime meet. Two consequences
 * worth stating, because both are the reason the runtime is a class rather than
 * a hook:
 *
 * - **The runtime's lifetime is the caller's.** A surface creates it (usually in
 *   a `useRef`/module scope keyed by context), so it survives a re-render, a
 *   StrictMode double-mount and a remount that keeps the same conversation. A
 *   hook that owned the state could not promise any of that, and #1363 warns
 *   specifically against every provider writing its own state machine.
 * - **A provider never writes this hook.** It is shared, so a second provider
 *   gets the same subscription, the same snapshot and the same re-render
 *   behaviour without a line of its own.
 *
 * `getServerSnapshot` is the same reader as `getSnapshot`: nothing here renders
 * on a server today, and a runtime that returned a second, empty snapshot for
 * hydration would be a discrepancy waiting to be discovered in production.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { AIConversationSnapshot, ConversationRuntime } from './ConversationRuntime'

export function useConversationSnapshot<Context>(
  runtime: ConversationRuntime<Context>,
): AIConversationSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => runtime.subscribe(onChange),
    [runtime],
  )
  const read = useCallback(() => runtime.getSnapshot(), [runtime])
  return useSyncExternalStore(subscribe, read, read)
}
