/**
 * Gesture constants for the App spatial pager.
 *
 * There is deliberately no edge band. `interaction/app.md` says "swipe right
 * from the Terminal surface" — the whole surface, not a strip at its edge —
 * and #748's edge cases put the discrimination in the axis lock instead
 * ("drags start in the terminal region; |dx| > |dy| enters a horizontal
 * gesture"). Requiring a start within 24px of the screen edge narrowed a
 * documented gesture to about a tenth of the surface and made it
 * undiscoverable.
 */
export const SWIPE_COMMIT_PX = 80;
