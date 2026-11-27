/**
 * App host pull-to-refresh contact decisions (#4602 §4).
 *
 * React-free and DOM-free so the axis lock, threshold and surrender rules are
 * provable without a renderer. The interaction was settled in the published
 * prototype `app-pull-refresh-4602` before this production port; the constants
 * here are the ones that prototype validated, and remain initial proposals to
 * tune by observation.
 *
 * The gesture is an accelerator. The visible header action is the contract, and
 * both call the same current-scope refresh.
 */

/** First movement past this decides the axis for the whole contact. */
export const AXIS_LOCK_PX = 8;
/** Raw vertical travel that commits a refresh on release. */
export const RELEASE_THRESHOLD_PX = 64;
/** Drag resistance applied to the indicator, not to the threshold. */
export const PULL_RESISTANCE = 0.5;
export const MAX_PULL_PX = 96;

export type PullSurface = 'sessions' | 'files' | 'terminal' | 'editor' | 'nested' | 'other';

/** Only a host-owned mutable list at rest may arm the pull. Terminal, editor,
 *  modal and nested scroller contacts belong to their own owners. */
export function isPullEligible(surface: PullSurface): boolean {
  return surface === 'sessions';
}

export interface PullContact {
  eligible: boolean;
  axis: 'vertical' | 'horizontal' | null;
  rawY: number;
  distance: number;
  committed: boolean;
}

export function createPullContact(options: { surface: PullSurface; atTop: boolean }): PullContact {
  return {
    eligible: isPullEligible(options.surface) && options.atTop,
    axis: null,
    rawY: 0,
    distance: 0,
    committed: false,
  };
}

export type PullMoveAction = 'pending' | 'pull' | 'scroll' | 'surrender';

export function movePullContact(
  contact: PullContact,
  dx: number,
  dy: number,
): { action: PullMoveAction; distance: number } {
  contact.rawY = dy;
  if (contact.axis === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) {
      return { action: 'pending', distance: 0 };
    }
    contact.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
  }
  if (contact.axis === 'horizontal') {
    // The outer Sessions/Workspace pager owns this contact.
    return { action: 'surrender', distance: 0 };
  }
  if (!contact.eligible || dy <= 0) {
    return { action: 'scroll', distance: 0 };
  }
  contact.distance = Math.min(MAX_PULL_PX, dy * PULL_RESISTANCE);
  return { action: 'pull', distance: contact.distance };
}

/** Release commits at most once, and only past the raw-travel threshold. */
export function releasePullContact(contact: PullContact): 'commit' | 'cancel' | 'none' {
  if (contact.committed) { return 'none'; }
  const qualifies = contact.axis === 'vertical'
    && contact.eligible
    && contact.rawY >= RELEASE_THRESHOLD_PX;
  if (!qualifies) { return 'cancel'; }
  contact.committed = true;
  return 'commit';
}
