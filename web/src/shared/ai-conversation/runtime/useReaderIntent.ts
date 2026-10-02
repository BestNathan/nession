/**
 * Whether the reader wants older history — which is not where they are scrolled.
 *
 * `#1363`'s review draws the distinction, and the reason for it is in the
 * scroller. Prepending a page preserves the reading anchor, which means it moves
 * `scrollTop` *away* from zero to keep the same content in view. A trigger that
 * asks "is the offset at the top?" therefore answers no the instant it succeeds:
 * measured, with a page size of three, the anchor left `scrollTop` at 146 and
 * the next page never came. The reader got one page and then had to jog the
 * transcript for the next — the reported symptom.
 *
 * So the offset decides nothing. It only ever *states* the intent, in one
 * direction:
 *
 * - **arriving at the top states it** — the reader went looking for history;
 * - **a gesture away from the top withdraws it** — they are going back to
 *   reading forwards, and loading the rest of the conversation behind them would
 *   be work nobody asked for.
 *
 * Everything else that moves the offset is *our* doing — the anchor
 * preservation, the initial jump to the tail — and none of it is the reader
 * changing their mind. That is why the withdrawal listens for **gestures**
 * rather than for `scroll`: a scroll event cannot tell the reader's hand from
 * the scroller's own adjustment, and only one of those two means anything.
 *
 * ## Where this sits
 *
 * `runtime/`, beside the other two hooks in this framework, rather than in
 * `components/` beside `useScrollEdges`. `web/CLAUDE.md` is explicit that `use*`
 * modules do not live under `components/`; the existing file there is a
 * precedent, not a licence, and this is not the change to either deepen it or
 * go fix it.
 *
 * The listeners are attached natively rather than passed to
 * `MessageScrollerViewport` as props: the vendored viewport composes its own
 * `onWheel` / `onTouchMove`, and whether a caller's prop would replace or join
 * that is not something anyone should have to reverse-engineer from a bundle to
 * find out.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'

/** How close to the top counts as "at the top", in px. */
const TOP_THRESHOLD = 50

export function useReaderIntent(
  contentRef: RefObject<HTMLElement | null>,
  openId: string | null,
): boolean {
  // The intent names the conversation it belongs to, so a switch cannot inherit
  // it. A separate "reset on change" effect would be a render too late — the
  // fetch that reads this runs in the same pass and would see the stale `true`.
  const [wantsOlderFor, setWantsOlderFor] = useState<string | null>(null)
  const openIdRef = useRef(openId)
  openIdRef.current = openId

  useEffect(() => {
    const content = contentRef.current
    const viewport = content?.closest('[data-slot="message-scroller-viewport"]')
    if (!(viewport instanceof HTMLElement)) {
      return
    }

    // The *initial* position is deliberately not sampled: on mount the scroller
    // has not yet moved to the end, so reading it here says "at the top" and the
    // caller immediately pulls history nobody asked for — measured in a browser,
    // where opening a conversation rendered five turns for a newest page of
    // three.
    const arrived = () => {
      if (viewport.scrollTop <= TOP_THRESHOLD) {
        setWantsOlderFor(openIdRef.current)
      }
    }

    // A wheel down, a finger dragging up (which moves content up towards the
    // newer end), or a key that pages forward. `touchstart` resets the origin so
    // a drag is measured from where it began rather than from the last frame of
    // the previous one.
    let touchFrom: number | null = null
    const wheelDown = (event: WheelEvent) => {
      if (event.deltaY > 0) {
        setWantsOlderFor(null)
      }
    }
    const touchBegan = () => {
      touchFrom = null
    }
    const touchMoved = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y === undefined) {
        return
      }
      if (touchFrom !== null && y < touchFrom) {
        setWantsOlderFor(null)
      }
      touchFrom = y
    }
    const keyed = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
        setWantsOlderFor(null)
      }
    }

    viewport.addEventListener('scroll', arrived, { passive: true })
    viewport.addEventListener('wheel', wheelDown, { passive: true })
    viewport.addEventListener('touchstart', touchBegan, { passive: true })
    viewport.addEventListener('touchmove', touchMoved, { passive: true })
    viewport.addEventListener('keydown', keyed)
    return () => {
      viewport.removeEventListener('scroll', arrived)
      viewport.removeEventListener('wheel', wheelDown)
      viewport.removeEventListener('touchstart', touchBegan)
      viewport.removeEventListener('touchmove', touchMoved)
      viewport.removeEventListener('keydown', keyed)
    }
  }, [contentRef])

  return wantsOlderFor !== null && wantsOlderFor === openId
}
