/**
 * One-finger axis lock for touch gestures (#2659, #3523).
 *
 * Two independent owners need the same answer to "is this drag vertical or
 * horizontal?": the Terminal's local scroll routing and the App Experience's
 * keyboard-avoidance scrollport. The slop and the lock-once rule are therefore
 * one shared primitive rather than two copies that could drift and let a single
 * finger be claimed twice.
 *
 * The axis is decided only once the finger leaves the slop circle; after that a
 * later move cannot revive the other axis for the rest of that contact.
 */

/** Finger travel (px) before a gesture's axis is decided. */
export const TOUCH_AXIS_SLOP_PX = 8;

export type TouchScrollAxis = 'undecided' | 'vertical' | 'horizontal';

export interface TouchAxisTracker {
  startX: number;
  startY: number;
  axis: TouchScrollAxis;
}

export function beginTouchAxis(clientX: number, clientY: number): TouchAxisTracker {
  return { startX: clientX, startY: clientY, axis: 'undecided' };
}

/**
 * Advance the tracker toward `point` and return the locked axis.
 *
 * `undecided` means the finger is still inside the slop circle. The tracker is
 * mutated only at the moment the lock is taken, so callers that care about the
 * raw pixel delta can keep their own `lastY` and stay out of this decision.
 */
export function lockTouchAxis(
  tracker: TouchAxisTracker,
  point: { clientX: number; clientY: number },
): TouchScrollAxis {
  if (tracker.axis !== 'undecided') {
    return tracker.axis;
  }
  const dx = Math.abs(point.clientX - tracker.startX);
  const dy = Math.abs(point.clientY - tracker.startY);
  if (Math.max(dx, dy) < TOUCH_AXIS_SLOP_PX) {
    return 'undecided';
  }
  tracker.axis = dy >= dx ? 'vertical' : 'horizontal';
  return tracker.axis;
}
