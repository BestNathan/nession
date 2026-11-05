/**
 * Gesture constants for the App top-level pager (#2724).
 *
 * The spatial model is unchanged: `Sessions ← Terminal → Workspace`, and the
 * gesture is an accelerator over visible controls. What changed is *when* the
 * shell is allowed to act on a touch and what it does while it holds one.
 *
 * **The edge band is a bounded exception on top of the work-surface
 * exclusion.** #473 asked for "edge-only shell swipes (~24px)"; #748 rejected
 * a band that was the *only* place a page may start. #1049 added the
 * work-surface start gate, and #1081 re-admitted the shell's own edges as an
 * exception so the gesture remained reachable on the Terminal screen. That
 * split still owns where a page may begin: shell chrome keeps its whole width;
 * a work surface keeps its interior and yields only a bounded band after the
 * platform's own edge guard, in the one direction that edge's layer arrives
 * from. #2724's physical-device finding moved that band inward: the outermost
 * strip belongs to Safari/Android back navigation, which the page cannot
 * cancel, so the shell stops competing for it.
 *
 * #2724 adds the in-flight half of the contract: a touch is not navigation the
 * moment it lands. It is a candidate until it has moved past
 * {@link SWIPE_SLOP_PX} without turning into a vertical drag; only then is a
 * destination frozen. Reversals clamp the preview to zero instead of ending
 * the gesture, and release (or genuine cancellation) is the only thing that
 * commits or snaps back. These numbers are the *initial* hypotheses from the
 * approved mobile prototype; device validation (SC-07) may revise them.
 *
 * `docs/design/interaction/app.md` carries the product-facing version, and
 * `edgeBand.ts` owns why the band is scoped the way it is. This module owns
 * the numbers.
 */

/** Movement before a candidate may become a shell navigation or a scroll. */
export const SWIPE_SLOP_PX = 12;

/**
 * Vertical dominance. A drag whose vertical travel exceeds this fraction of
 * its horizontal travel is content's: scrolling wins, and the gesture cannot
 * later become a page in the same pointer sequence.
 */
export const SWIPE_VERTICAL_DOMINANCE = 0.85;

/** Minimum release travel that commits any navigation. */
export const SWIPE_COMMIT_MIN_PX = 64;

/** The other half of the commit threshold: a fraction of the shell width. */
export const SWIPE_COMMIT_FRACTION = 0.18;

/** A fast flick may commit at this shorter travel... */
export const SWIPE_FLICK_MIN_PX = 40;

/** ...but only at or above this mean absolute velocity toward the target. */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.45;

/**
 * The most of the shell a drag may reveal. The Terminal must stay readable
 * under the incoming layer, so the preview stops here rather than sliding a
 * layer fully across before release.
 */
export const SWIPE_MAX_REVEAL_FRACTION = 0.8;

/**
 * Damped travel when there is no destination at all (the edge of the pager,
 * or no Workspace before a Session exists). It is feedback that the gesture is
 * recognised and cannot go anywhere, not a page preview.
 */
export const SWIPE_RESIST_FACTOR = 0.18;

/** The cap on that damped travel, in pixels. */
export const SWIPE_RESIST_MAX_PX = 24;

/** Shell settle animation duration; mirrors `--nession-motion-shell-duration`. */
export const SWIPE_SETTLE_MS = 180;

/**
 * The outer strip that belongs to the platform's own edge gesture (#2724).
 *
 * iPhone Safari's back swipe is recognised from the screen edge by the OS
 * before the page sees a cancelable move. A shell band that starts at the
 * edge therefore loses the gesture to the browser — measured on a physical
 * device on 2026-11-05. The shell starts its band *after* this guard instead
 * of competing for the same pixels; the guard is deliberately not a larger
 * shell band.
 */
export const EDGE_PLATFORM_GUARD_PX = 24;

/**
 * The width of the shell edge band that may claim a horizontal drag which
 * started over a work surface (#1081, #2724).
 *
 * 28px is the middle of the 24–32px #473 proposed and #1081 re-proposed. It
 * is a *starting* value; device validation (SC-07) decides whether it stays.
 * The band begins after {@link EDGE_PLATFORM_GUARD_PX}; see `edgeBand.ts`.
 */
export const EDGE_BAND_PX = 28;

/** The travel needed to commit at `shellWidth`; the larger of the two rules. */
export function swipeCommitThreshold(shellWidth: number): number {
  return Math.max(SWIPE_COMMIT_MIN_PX, shellWidth * SWIPE_COMMIT_FRACTION);
}
