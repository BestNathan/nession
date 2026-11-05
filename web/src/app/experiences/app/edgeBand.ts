import { EDGE_BAND_PX, EDGE_PLATFORM_GUARD_PX } from './gesture';

/**
 * Where a top-level App navigation gesture may start when it lands on a work
 * surface (#1081, #2724).
 *
 * `workSurface.ts` says a work surface owns the touches that begin in it, and
 * gives the reason: a page that started there would spend the surface's first
 * horizontal pixels — an xterm selection, a CodeMirror selection, a capsule
 * drag — before the surface ever saw them. That reason is about the *interior*
 * of a surface. It never justified the edges, and on the Terminal screen, where
 * the viewport and the capsule are the whole screen, applying it to the edges
 * too left the gesture with almost no reachable start at all.
 *
 * So the edge is re-admitted, and what keeps that from being a retreat to a
 * band-only gesture (#473, rejected in #748) is that it is an **exception on
 * top of the exclusion**, not a replacement for it. The outer strip belongs to
 * the platform first (#2724):
 *
 * ```text
 * touch starts on shell chrome            -> the shell may page, whole width
 * touch starts inside a work surface,
 *   in the outer guard                     -> the platform owns it (Safari back,
 *                                             Android system back); the shell
 *                                             does not claim it
 * touch starts inside a work surface,
 *   after the guard, within EDGE_BAND_PX   -> the shell may page, if the drag
 *                                             moves the way that edge's layer
 *                                             arrives
 * touch starts inside a work surface,
 *   anywhere else                          -> the surface owns it
 * ```
 *
 * The guard exists because a physical iPhone test on 2026-11-05 showed that a
 * 28px band starting at the screen edge loses the leftward back-swipe contest
 * to Safari's OS gesture: the page never receives a cancelable move. Moving
 * the shell band inward is the only way to keep the gesture and stop fighting
 * the platform. It is not a wider band; the shell still claims only
 * `EDGE_BAND_PX`.
 *
 * Two details bound the exception, and both are load-bearing:
 *
 * - **The bands are measured from the shell, not from the window.** An App 390px
 *   wide inside a desktop browser — or inside the fixture the browser contract
 *   suite drives — has to put its edges where the user sees them. A band
 *   measured from `window.innerWidth` would sit off-screen there and the
 *   gesture would be unreachable in exactly the case a test can observe.
 * - **Each edge owns one direction.** The Sessions layer slides in from the
 *   left and the Workspace layer from the right (`appLayerPositions.ts`), so a
 *   rightward drag belongs to the left band and a leftward drag to the right
 *   band. An edge band is not an unconditional licence: a drag from the left
 *   edge going left is not shell navigation, and the surface keeps it.
 *
 * The band is additionally mute on a layer whose depth owns its own leave
 * (#1081), which is a question that outranks this one — see `shellMayPage` in
 * `useSwipePager.ts`. In practice that is the whole Workspace layer: its only
 * work surfaces are inside a pushed detail, and there the capability's page
 * header owns the leave.
 */

/** The shell's horizontal extent, in the same client coordinates as a touch. */
export interface ShellBounds {
  /** The shell's left edge, in `clientX` coordinates. */
  left: number;
  /** The shell's right edge, in `clientX` coordinates. */
  right: number;
}

/** Which shell edge a touch originated from. */
export type EdgeSide = 'left' | 'right';

/**
 * Which shell edge a touch at `clientX` originates from, or `null` when it is
 * in neither band.
 *
 * A band is bounded on both sides by the shell and shifted inward by
 * `guardPx`. The outer guard is deliberately **not** part of the band: Safari
 * and Android reserve it for their own back gesture, and a page cannot win
 * that contest.
 *
 * It matters for an App inset inside a wider window: without the shell's own
 * lower/upper bounds, every coordinate to the left of an inset App would read
 * as that App's left band, and a touch in the page *behind* it would page the
 * App.
 *
 * A shell narrower than two bands puts some touches in both. The left band is
 * tested first and wins, which is a tie-break rather than a rule: at every
 * width the App ships (375 and up) the two bands are disjoint.
 */
export function edgeBandSide(
  clientX: number,
  bounds: ShellBounds,
  guardPx: number = EDGE_PLATFORM_GUARD_PX,
): EdgeSide | null {
  const leftStart = bounds.left + guardPx;
  if (clientX >= leftStart && clientX <= Math.min(leftStart + EDGE_BAND_PX, bounds.right)) {
    return 'left';
  }
  const rightEnd = bounds.right - guardPx;
  if (clientX <= rightEnd && clientX >= Math.max(rightEnd - EDGE_BAND_PX, bounds.left)) {
    return 'right';
  }
  return null;
}

/**
 * Which edge's platform guard contains `clientX`, if any (#2724).
 *
 * This strip belongs to the browser/OS edge gesture. The shell never pages
 * from it, and the Terminal direction pad must not arm there either.
 */
export function platformGuardSide(
  clientX: number,
  bounds: ShellBounds,
  guardPx: number = EDGE_PLATFORM_GUARD_PX,
): EdgeSide | null {
  if (clientX >= bounds.left && clientX < bounds.left + guardPx) {
    return 'left';
  }
  if (clientX <= bounds.right && clientX > bounds.right - guardPx) {
    return 'right';
  }
  return null;
}

/**
 * Whether a touch belongs to the shell's reserved edge region (#2657, #2724).
 *
 * The Terminal's long-press direction pad must not arm on a touch the App
 * pager may claim, nor in the platform's guard: a hold that later moves could
 * still be read as a system back swipe. The reserved region is the guard plus
 * the shell band. The product leaf asks the App layer through a predicate
 * instead of importing this module (the layer rule has no product → app edge).
 * The predicate reads the same rules the pager uses, measured from the nearest
 * App experience root so an inset App keeps its band where the user sees it.
 */
export function appEdgeBandReservation(target: EventTarget | null, clientX: number): boolean {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  const shell = element?.closest('[data-experience="app"]');
  if (!(shell instanceof Element)) {
    return false;
  }
  const rect = shell.getBoundingClientRect();
  const bounds = { left: rect.left, right: rect.right };
  return platformGuardSide(clientX, bounds) !== null || edgeBandSide(clientX, bounds) !== null;
}

/**
 * Whether a horizontal drag of `deltaX` is the one `side`'s layer arrives on.
 *
 * `deltaX` is positive to the right, so the left band — which pulls Sessions in
 * from the left — owns a rightward drag, and the right band owns a leftward one.
 * A zero `deltaX` is not a direction and owns nothing.
 */
export function edgeOwnsDrag(side: EdgeSide, deltaX: number): boolean {
  return side === 'left' ? deltaX > 0 : deltaX < 0;
}
