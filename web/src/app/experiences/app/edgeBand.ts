import { EDGE_BAND_PX } from './gesture';

/**
 * Where a top-level App navigation gesture may start when it lands on a work
 * surface (#1081).
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
 * top of the exclusion**, not a replacement for it:
 *
 * ```text
 * touch starts on shell chrome            -> the shell may page, whole width
 * touch starts inside a work surface,
 *   within EDGE_BAND_PX of a shell edge   -> the shell may page, if the drag
 *                                            moves the way that edge's layer
 *                                            arrives
 * touch starts inside a work surface,
 *   anywhere else                         -> the surface owns it
 * ```
 *
 * Two details bound the exception, and both are load-bearing:
 *
 * - **The band is measured from the shell, not from the window.** An App 390px
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
 * header owns the leave. Measured on the fixture, 390 of 705 band cells sit
 * over a work surface on the Terminal layer and 0 of 705 at the Workspace root,
 * so the two rules overlap nowhere and nothing was given up to state both.
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
 * A band is bounded on **both** sides — `left <= clientX <= left + EDGE_BAND_PX`
 * and not merely the upper half — so a point outside the shell is claimed by
 * neither edge. It matters for an App inset inside a wider window: without the
 * lower bound, every coordinate to the left of an inset App would read as that
 * App's left band, and a touch in the page *behind* it would page the App.
 *
 * A shell narrower than two bands puts some touches in both. The left band is
 * tested first and wins, which is a tie-break rather than a rule: at every
 * width the App ships (375 and up) the two bands are disjoint.
 */
export function edgeBandSide(
  clientX: number,
  bounds: ShellBounds,
): EdgeSide | null {
  if (clientX >= bounds.left && clientX <= bounds.left + EDGE_BAND_PX) {
    return 'left';
  }
  if (clientX <= bounds.right && clientX >= bounds.right - EDGE_BAND_PX) {
    return 'right';
  }
  return null;
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
