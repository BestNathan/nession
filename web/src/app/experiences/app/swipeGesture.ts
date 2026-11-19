import { edgeBandSide, edgeOwnsDrag, platformGuardSide, type EdgeSide, type ShellBounds } from './edgeBand';
import {
  SWIPE_FLICK_MIN_PX,
  SWIPE_FLICK_VELOCITY_PX_PER_MS,
  SWIPE_INNER_MAX_REVEAL_PX,
  SWIPE_MAX_REVEAL_FRACTION,
  SWIPE_RESIST_FACTOR,
  SWIPE_RESIST_MAX_PX,
  SWIPE_SLOP_PX,
  SWIPE_VERTICAL_DOMINANCE,
  swipeCommitThreshold,
} from './gesture';
import { hasActiveSelectionWithin, isInteractiveOwner, isWorkSurface } from './workSurface';

/**
 * The App shell's swipe state machine (#2724).
 *
 * Deliberately free of React and DOM listeners: the event binding and the
 * settle animation belong to `useSwipePager`. What lives here is the part the
 * prototype proved — a physical touch is one owned contact from start to end,
 * ownership is not assumed at touchstart, the axis is decided once, and a
 * claimed destination is frozen until release.
 *
 * ```text
 * idle -> candidate -> navigation -> (release) committed | cancelled
 *                   \-> content    (the surface keeps the touch)
 *                   \-> resisting  (horizontal, but no destination)
 * ```
 *
 * `content` and `resisting` are not dead ends a later move can revive into a
 * *different* page: a vertical drag is the surface's for the rest of the
 * contact, and a resisting drag may only claim the direction that became
 * valid, with its destination frozen from that point on.
 */

export type SwipePhase =
  | 'idle'
  | 'candidate'
  | 'navigation'
  | 'resisting'
  | 'settling'
  | 'content';

export type SwipeDirection = -1 | 0 | 1;

/** Which way an inner Workspace stack gesture would move (#3971). */
export type InnerSwipeAction = 'pop' | 'forward';

/**
 * What an inner Workspace stack can do at the current depth.
 *
 * The capability reports the *destination titles*, not just booleans: the
 * transient preview names where the gesture lands, and a title is only present
 * when a real destination exists. A leftward contact with no forward title
 * must yield or resist rather than enter something unknown.
 */
export interface InnerStackState {
  /** Title of the depth a right swipe would pop to, or null at the root. */
  pop: string | null;
  /** Title of the recorded forward destination, or null when none exists. */
  forward: string | null;
}

/** The part of a native touch this machine needs. */
export interface SwipeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

export interface SwipeSnapshot {
  phase: SwipePhase;
  offset: number;
  destinationIndex: number | null;
  /** The inner stack operation this contact would commit, if any. */
  innerAction: InnerSwipeAction | null;
  /** The destination's own title, for the transient preview. */
  destinationLabel: string | null;
  direction: SwipeDirection;
  /** Why the machine last changed ownership or ended. Null before any outcome. */
  reason: string | null;
}

export interface SwipeMoveResult {
  snapshot: SwipeSnapshot;
  /**
   * True once the shell owns the horizontal drag. The caller must call
   * `preventDefault` on a non-passive listener so nested Terminal/TUI/Peek
   * scrolling does not consume the same pixels.
   */
  preventDefault: boolean;
}

export interface SwipeEndResult {
  outcome: 'none' | 'commit' | 'snapback';
  destinationIndex: number | null;
  /** The inner Workspace stack operation a commit should run, if any. */
  innerAction: InnerSwipeAction | null;
  reason: string;
  /** Travel toward the frozen destination at release, in pixels. */
  travel: number;
  /** Mean speed over the whole contact, in px/ms. */
  velocity: number;
  threshold: number;
}

export interface SwipeGestureOptions {
  /**
   * The shell's horizontal extent, read when the touch starts. The edge band
   * and the commit threshold are both relative to the App shell, never to the
   * window (#1081).
   */
  getShellBounds: () => ShellBounds | null;
  getIndex: () => number;
  getPageCount: () => number;
  /** False while the current layer's depth owns its own leave (#1051). */
  shellMayPage: () => boolean;
  /**
   * What the active Workspace depth's inner stack can do, or `null` when it has
   * none (#3971). Inner destinations outrank the outer spatial pager for a
   * claimed contact: at a pushed depth, a right swipe pops the capability's own
   * stack, and a left swipe forwards only to a recorded destination. This is
   * the same coordinator — there is never a second touch owner.
   */
  getInnerStack?: () => InnerStackState | null;
  now?: () => number;
}

/** One resolved destination for a claimed contact. */
type SwipeDestination =
  | { kind: 'page'; index: number }
  | { kind: 'inner'; action: InnerSwipeAction; title: string };

function directionOf(dx: number): SwipeDirection {
  if (dx > 0) {
    return 1;
  }
  return dx < 0 ? -1 : 0;
}

function resist(dx: number): number {
  const sign = Math.sign(dx);
  return sign * Math.min(Math.abs(dx) * SWIPE_RESIST_FACTOR, SWIPE_RESIST_MAX_PX);
}

export class SwipeGesture {
  private readonly options: SwipeGestureOptions;
  private readonly clock: () => number;

  private phase: SwipePhase = 'idle';
  private offset = 0;
  private destinationIndex: number | null = null;
  private innerAction: InnerSwipeAction | null = null;
  private destinationLabel: string | null = null;
  private direction: SwipeDirection = 0;
  private reason: string | null = null;

  private identifier: number | null = null;
  private edge: EdgeSide | null = null;
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private lastX = 0;
  private shellWidth = 0;

  constructor(options: SwipeGestureOptions) {
    this.options = options;
    this.clock = options.now ?? (() => performance.now());
  }

  snapshot(): SwipeSnapshot {
    return {
      phase: this.phase,
      offset: this.offset,
      destinationIndex: this.destinationIndex,
      innerAction: this.innerAction,
      destinationLabel: this.destinationLabel,
      direction: this.direction,
      reason: this.reason,
    };
  }

  /** The `Touch.identifier` currently tracked, if any. */
  trackedIdentifier(): number | null {
    return this.identifier;
  }

  /** True while this machine holds a contact for `identifier`. */
  isTracking(identifier: number): boolean {
    return this.identifier !== null && this.identifier === identifier;
  }

  /**
   * Begin a candidate contact. Returns false when this touch is not the
   * shell's at all; that is a refusal, not a cancellation, and the caller
   * must not log it as one.
   */
  start(touch: SwipeTouch): boolean {
    if (this.phase !== 'idle' || this.identifier !== null) {
      return false;
    }

    // The contact may become either an outer page or an inner Workspace stack
    // move (#3971). Both are one coordinator; only when neither has anywhere to
    // go does the shell refuse the candidate.
    if (!this.options.shellMayPage() && !this.innerStackHasDestination()) {
      this.reason = 'shell-standdown';
      return false;
    }

    // An interactive owner keeps its touch even inside the shell edge band:
    // the user aimed at a control, a field, an open panel or a nested
    // horizontal scroller (#2724).
    if (isInteractiveOwner(touch.target)) {
      this.reason = 'interactive-owner';
      return false;
    }

    // A live text selection is the surface's own drag (#2724).
    if (hasActiveSelectionWithin(touch.target)) {
      this.reason = 'selection';
      return false;
    }

    const bounds = this.options.getShellBounds();

    // The outer platform guard is the OS's for every target, not only over a
    // work surface: on the Terminal screen the very edge is shell/terminal
    // chrome, and claiming it there still loses to Safari's back gesture
    // (#2724, physical iPhone finding).
    if (bounds !== null && platformGuardSide(touch.clientX, bounds) !== null) {
      this.reason = 'platform-guard';
      return false;
    }

    let edge: EdgeSide | null = null;
    if (isWorkSurface(touch.target)) {
      // The work surface owns its interior; only the band after the platform
      // guard yields to the shell, and then only in the direction that edge
      // arrives from.
      if (bounds === null) {
        this.reason = 'unmeasurable-shell';
        return false;
      }
      edge = edgeBandSide(touch.clientX, bounds);
      if (edge === null) {
        this.reason = 'surface-interior';
        return false;
      }
    }

    this.phase = 'candidate';
    this.identifier = touch.identifier;
    this.edge = edge;
    this.startX = touch.clientX;
    this.startY = touch.clientY;
    this.lastX = touch.clientX;
    this.startTime = this.clock();
    this.offset = 0;
    this.destinationIndex = null;
    this.innerAction = null;
    this.destinationLabel = null;
    this.direction = 0;
    this.reason = null;
    this.shellWidth = bounds === null ? 0 : Math.max(0, bounds.right - bounds.left);
    return true;
  }

  /** True when the active depth can move within its own stack in either way. */
  private innerStackHasDestination(): boolean {
    const inner = this.options.getInnerStack?.() ?? null;
    return inner !== null && (inner.pop !== null || inner.forward !== null);
  }

  move(touch: SwipeTouch): SwipeMoveResult {
    const unchanged = { snapshot: this.snapshot(), preventDefault: false };
    if (
      this.identifier === null
      || touch.identifier !== this.identifier
      || this.phase === 'idle'
      || this.phase === 'content'
      || this.phase === 'settling'
    ) {
      return unchanged;
    }

    this.lastX = touch.clientX;
    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;

    if (this.phase === 'candidate') {
      if (Math.hypot(dx, dy) < SWIPE_SLOP_PX) {
        return unchanged;
      }
      if (this.giveToContent(dx, dy)) {
        return { snapshot: this.snapshot(), preventDefault: false };
      }
      if (this.edge !== null && !edgeOwnsDrag(this.edge, dx)) {
        return this.surrender('edge-direction');
      }

      const destination = this.destinationFor(dx);
      if (destination === null) {
        // Horizontal, but the pager has nowhere to go. Stay damping rather
        // than claim a page: the same contact may still reverse into a
        // direction that does exist.
        this.phase = 'resisting';
        this.direction = directionOf(dx);
        this.offset = resist(dx);
        this.reason = 'no-destination';
        return { snapshot: this.snapshot(), preventDefault: true };
      }
      this.claim(destination, dx);
      return { snapshot: this.snapshot(), preventDefault: true };
    }

    if (this.phase === 'resisting') {
      if (this.giveToContent(dx, dy)) {
        return { snapshot: this.snapshot(), preventDefault: false };
      }
      if (this.edge !== null && !edgeOwnsDrag(this.edge, dx)) {
        return this.surrender('edge-direction');
      }
      const destination = this.destinationFor(dx);
      if (destination !== null) {
        this.claim(destination, dx);
      } else {
        this.direction = directionOf(dx);
        this.offset = resist(dx);
      }
      return { snapshot: this.snapshot(), preventDefault: true };
    }

    // Navigation: destination and direction are frozen at claim. Travel
    // against that direction clamps the preview to zero; it never settles,
    // because only release decides commit or snapback.
    const forward = Math.max(0, dx * this.direction);
    this.offset = this.direction * Math.min(forward, this.maxReveal());
    return { snapshot: this.snapshot(), preventDefault: true };
  }

  end(touch?: SwipeTouch): SwipeEndResult {
    if (this.identifier === null) {
      return this.result('none', 'idle', 0, 0);
    }
    if (touch !== undefined) {
      this.lastX = touch.clientX;
    }

    const phase = this.phase;
    const destination = this.destinationIndex;
    const innerAction = this.innerAction;
    const direction = this.direction;

    if (phase === 'navigation' && (destination !== null || innerAction !== null)) {
      const travel = Math.max(0, (this.lastX - this.startX) * direction);
      const duration = Math.max(1, this.clock() - this.startTime);
      const velocity = travel / duration;
      const threshold = swipeCommitThreshold(this.shellWidth);
      const byDistance = travel >= threshold;
      const byVelocity =
        travel >= SWIPE_FLICK_MIN_PX && velocity >= SWIPE_FLICK_VELOCITY_PX_PER_MS;
      const commit = byDistance || byVelocity;
      const reason = byDistance ? 'distance' : byVelocity ? 'velocity' : 'below-threshold';
      this.reset(reason);
      return {
        outcome: commit ? 'commit' : 'snapback',
        destinationIndex: destination,
        innerAction: commit ? innerAction : null,
        reason,
        travel,
        velocity,
        threshold,
      };
    }

    if (phase === 'resisting') {
      const travel = Math.max(0, (this.lastX - this.startX) * direction);
      const duration = Math.max(1, this.clock() - this.startTime);
      this.reset('no-destination');
      return {
        outcome: 'snapback',
        destinationIndex: null,
        innerAction: null,
        reason: 'no-destination',
        travel,
        velocity: travel / duration,
        threshold: swipeCommitThreshold(this.shellWidth),
      };
    }

    if (phase === 'candidate') {
      this.reset('candidate');
      return this.result('none', 'candidate', 0, 0);
    }

    this.reset('content');
    return this.result('none', 'content', 0, 0);
  }

  /**
   * Give up the contact for `reason`. Used for a genuine native
   * `touchcancel`, multitouch, ownership loss, or the shell standing down.
   */
  cancel(reason: string): SwipeSnapshot {
    if (this.identifier === null && this.phase === 'idle') {
      this.reason = reason;
      return this.snapshot();
    }
    this.reset(reason);
    return this.snapshot();
  }

  private giveToContent(dx: number, dy: number): boolean {
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_VERTICAL_DOMINANCE) {
      this.reset('vertical');
      return true;
    }
    return false;
  }

  private surrender(reason: string): SwipeMoveResult {
    this.reset(reason);
    return { snapshot: this.snapshot(), preventDefault: false };
  }

  private claim(destination: SwipeDestination, dx: number): void {
    this.phase = 'navigation';
    this.destinationIndex = destination.kind === 'page' ? destination.index : null;
    this.innerAction = destination.kind === 'inner' ? destination.action : null;
    this.destinationLabel = destination.kind === 'inner' ? destination.title : null;
    this.direction = directionOf(dx);
    this.reason = null;
    this.offset = this.direction * Math.min(Math.abs(dx), this.maxReveal());
  }

  /**
   * The destination this horizontal direction would reach, or `null` when it
   * runs off the end.
   *
   * Inner Workspace stack moves outrank the outer pager (#3971): at a pushed
   * depth a rightward contact pops exactly one level, and a leftward one moves
   * forward only to a destination the capability recorded. When the inner stack
   * has nothing in that direction, the outer spatial pager is asked next — so
   * the Workspace root still pages back to the Terminal, and a leftward contact
   * with no forward destination simply has nowhere to go.
   */
  private destinationFor(dx: number): SwipeDestination | null {
    const direction = directionOf(dx);
    if (direction === 0) {
      return null;
    }
    const inner = this.options.getInnerStack?.() ?? null;
    if (inner !== null) {
      if (direction > 0 && inner.pop !== null) {
        return { kind: 'inner', action: 'pop', title: inner.pop };
      }
      if (direction < 0 && inner.forward !== null) {
        return { kind: 'inner', action: 'forward', title: inner.forward };
      }
    }
    const next = this.options.getIndex() - direction;
    return next >= 0 && next < this.options.getPageCount()
      ? { kind: 'page', index: next }
      : null;
  }

  private maxReveal(): number {
    if (this.innerAction !== null) {
      return SWIPE_INNER_MAX_REVEAL_PX;
    }
    if (this.shellWidth <= 0) {
      // No measurable shell: let the geometry clamp rather than inventing a
      // width. The commit threshold still has its 64px floor.
      return Number.POSITIVE_INFINITY;
    }
    return this.shellWidth * SWIPE_MAX_REVEAL_FRACTION;
  }

  private result(
    outcome: SwipeEndResult['outcome'],
    reason: string,
    travel: number,
    velocity: number,
  ): SwipeEndResult {
    return {
      outcome,
      destinationIndex: null,
      innerAction: null,
      reason,
      travel,
      velocity,
      threshold: swipeCommitThreshold(this.shellWidth),
    };
  }

  private reset(reason: string): void {
    this.phase = 'idle';
    this.offset = 0;
    this.destinationIndex = null;
    this.innerAction = null;
    this.destinationLabel = null;
    this.direction = 0;
    this.identifier = null;
    this.edge = null;
    this.reason = reason;
  }
}
