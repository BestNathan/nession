/**
 * Gesture constants for the App top-level pager.
 *
 * **The edge band is back, and it is a bounded exception rather than the rule
 * it was first proposed as.** #473 asked for "edge-only shell swipes (~24px)";
 * #748 rejected that because a band is the *only* place a page may start, which
 * narrows a documented gesture to about a tenth of the surface and makes it
 * undiscoverable — so the gesture kept its whole width.
 *
 * #1049 (decision 1) then closed the real gap underneath #473 with a **start
 * gate**: `onTouchStart` in `useSwipePager` declines to begin at all when the
 * touch lands inside a work surface — the terminal viewport, a CodeMirror
 * editor, a `textarea`, or the capsule (`isWorkSurface`, `workSurface.ts`).
 * The axis lock alone could not do it: the lock decides *after* a touch has
 * been captured, so the first horizontal pixels of an xterm selection, a
 * CodeMirror selection, or a capsule drag were spent on the shell before the
 * working surface ever saw them.
 *
 * That gate was right about what it protected and wrong about what it cost.
 * On the Terminal screen the viewport and the capsule *are* the screen, so the
 * gate left the gesture with almost nothing to start on: the product says
 * `Sessions ← Terminal → Workspace` is spatial while the place a user actually
 * swipes returns before the gesture begins (#1081).
 *
 * #1081 keeps both halves and reconciles them by scope, not by compromise:
 *
 * - the gesture keeps its **whole width** wherever the shell owns the touch —
 *   shell chrome, and every surface that is not a work surface;
 * - over a work surface it starts from the shell's **edge bands only**, and
 *   `EDGE_BAND_PX` is the narrow half of that trade.
 *
 * Neither half is a retreat to #473. The band is an exception added to the
 * exclusion, so nothing that worked before stops working, and the middle of a
 * work surface is still the surface's. `edgeBand.ts` owns the direction rule
 * and the full reasoning; this module owns the numbers.
 *
 * `docs/design/interaction/app.md` carries the product-facing version, and is
 * converged in the same change.
 */

/** How far a drag must travel before a page commits. */
export const SWIPE_COMMIT_PX = 80;

/**
 * The width of the shell edge band that may claim a horizontal drag which
 * started over a work surface (#1081).
 *
 * 28px is the middle of the 24–32px #473 proposed and #1081 re-proposed. It is
 * a *starting* value: the band's real width is bounded by what a phone browser
 * reserves for its own edge gesture, which no test here can see. See
 * `edgeBand.ts`.
 */
export const EDGE_BAND_PX = 28;
