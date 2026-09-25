/**
 * Gesture constants for the App top-level pager.
 *
 * **There is still no edge band, and that is now a decision with a successor
 * rather than a standalone rebuttal.** #473 asked for "edge-only shell swipes
 * (~24px)"; #748 rejected the band because requiring a start within 24px of
 * the screen edge narrows the gesture to about a tenth of the surface and
 * makes it undiscoverable. That reasoning stands — the gesture keeps its whole
 * width.
 *
 * What #473 was actually pointing at was a real gap, and #1049 (decision 1)
 * closed it with a **start gate instead of a band**: `onTouchStart` in
 * `useSwipePager` declines to begin at all when the touch lands inside a work
 * surface — the terminal viewport, a CodeMirror editor, a `textarea`, or the
 * capsule (`isWorkSurface`, `workSurface.ts`).
 *
 * The axis lock alone could not close it. `#748`'s edge cases put the
 * discrimination in the axis lock ("drags start in the terminal region;
 * |dx| > |dy| enters a horizontal gesture"), but the lock only decides *after*
 * a touch has already been captured — so the first horizontal pixels of an
 * xterm selection, a CodeMirror selection, or a capsule drag were spent on the
 * shell before the working surface ever saw them. Discriminating before the
 * gesture starts is what "the shell must define where top-level navigation is
 * allowed to start" requires.
 *
 * `docs/design/interaction/app.md` was on the old side of this — it said
 * "swipe right from the Terminal surface", the whole surface. That sentence is
 * corrected in the same change: the gesture still spans the whole shell
 * chrome, but it stops where the work begins.
 */
export const SWIPE_COMMIT_PX = 80;
