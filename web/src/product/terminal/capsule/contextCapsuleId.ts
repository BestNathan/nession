/**
 * The Context Capsule's DOM id (#1347 SC-41).
 *
 * One constant in its own module so the two ends of `aria-controls` cannot
 * drift: the trigger lives in the composer row and the surface lives in the
 * dock, and they are never in the same file.
 */
export const CONTEXT_CAPSULE_ID = 'capsule-context-disclosure';
