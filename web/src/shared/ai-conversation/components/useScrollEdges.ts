/**
 * Which edges of a scrollable box have content beyond them.
 *
 * The edge fade is the *affordance* for a capped group body — a scrollbar
 * gutter may be hidden, and a body that simply stops reads as a body that
 * ended. But a fade drawn unconditionally is worse than none: on a short group
 * it would fade the last line of content that is not cut off at all. So the
 * fade is gated on a measurement rather than on a guess.
 *
 * Lives apart from the component because it is a measurement, not a rendering
 * decision, and because a second capped surface will want the same answer.
 *
 * `ResizeObserver` is feature-detected rather than assumed: jsdom does not
 * implement it, and a component that threw in a test would be a component no
 * one could assert on.
 */

import { useEffect, useState, type RefObject } from 'react'

export interface ScrollEdges {
  /** There is content above the current scroll position. */
  up: boolean
  /** There is content below it. */
  down: boolean
}

export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ up: false, down: false })

  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    // One pixel of tolerance, because sub-pixel layout makes an exactly-zero
    // remainder common at the ends and a fade that flickers at the bottom of a
    // fully-scrolled body is worse than no fade.
    const sync = () => {
      const up = element.scrollTop > 1
      const down = element.scrollTop < element.scrollHeight - element.clientHeight - 1
      setEdges((current) => (current.up === up && current.down === down ? current : { up, down }))
    }
    sync()
    element.addEventListener('scroll', sync, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [ref])

  return edges
}
