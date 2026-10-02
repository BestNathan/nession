/**
 * A turn the reader is inspecting does not close under them.
 *
 * `#1363`'s canonical design states the rule — *"Focus is never stranded.
 * Collapsing reveals rather than hides when the focused element is inside"* —
 * and the automatic transition is where it was being broken. A streaming turn's
 * openness is derived from live state (`workingOf`), so when the answer settles
 * the process rows simply receive `hidden`: no focus check, nothing moved first,
 * and the reader loses both what they were reading and where they were.
 *
 * A manual collapse never had this problem, and the reason is worth stating
 * because it is why this only has to handle the automatic one. `hidden` means
 * `display: none`, so a folded process is not focusable at all — which means
 * focus can only ever be *inside* a process that is already open. So the reader
 * who collapses on purpose is focusing the Turn control, which sits outside the
 * region that hides; they are never inside it when it goes.
 *
 * The fix is therefore to record what focusing inside implies: that turn stays
 * open until the reader says otherwise. Written as an override rather than as a
 * condition on `isOpen`, because "is focus inside?" is not answerable once the
 * hide has happened — the browser has already moved focus to `<body>` by then,
 * so a check that ran after the fact would find nothing to protect.
 */

import { useEffect, useRef, type RefObject } from 'react'

/** The attribute a transcript row carries to say which turn it draws. */
const TURN_KEY_ATTRIBUTE = 'data-turn-key'

export function useFocusPinsTurn(
  contentRef: RefObject<HTMLElement | null>,
  onFocusInsideTurn: (key: string) => void,
): void {
  // Held on a ref so the listener is attached once: re-subscribing on every
  // render would be a listener whose identity changes for no reason.
  const notify = useRef(onFocusInsideTurn)
  notify.current = onFocusInsideTurn

  useEffect(() => {
    const content = contentRef.current
    if (content === null) {
      return
    }
    // `focusin` rather than `focus`, because `focusin` bubbles: one listener on
    // the transcript sees every control inside it, including ones a future
    // renderer adds.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      const row = target.closest(`[${TURN_KEY_ATTRIBUTE}]`)
      const key = row instanceof HTMLElement ? row.dataset.turnKey : undefined
      if (key !== undefined) {
        notify.current(key)
      }
    }
    content.addEventListener('focusin', onFocusIn)
    return () => {
      content.removeEventListener('focusin', onFocusIn)
    }
  }, [contentRef])
}
