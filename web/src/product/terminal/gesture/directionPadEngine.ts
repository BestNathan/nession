/**
 * Pure, platform-independent direction-pad interaction engine (#2657).
 *
 * The touch adapter owns DOM events; this engine owns gesture state and the
 * key clock. It never reads xterm state, never writes ANSI bytes, and never
 * mutates the DOM — the product's semantic-key authority stays in
 * `TerminalInteractionController`.
 *
 * The state machine is `idle → pending → armed ↔ moving → idle`. Pending is
 * the long-press window; armed means the pad owns the finger but no direction
 * has been chosen yet (the center dead zone); moving is a chosen direction
 * with a repeat clock running.
 */

export type DirectionPadDirection = 'up' | 'down' | 'left' | 'right';

export type DirectionPadPhase = 'idle' | 'pending' | 'armed' | 'moving';

/** Thresholds and clock values the product approved for #2657. */
export interface DirectionPadConfig {
  /** Stationary time before the pad becomes armed. */
  readonly holdMs: number;
  /** Travel that surrenders a still-pending touch to native scrolling. */
  readonly pendingTravelPx: number;
  /** Distance from the origin that enters a direction. */
  readonly enterPx: number;
  /** Smaller distance that returns to the center and stops repeating. */
  readonly exitPx: number;
  /** Distance boundaries for the speed bands (one fewer than `rates`). */
  readonly speedEdges: readonly number[];
  /** Distance hysteresis at every band boundary. */
  readonly speedHysteresisPx: number;
  /** How much the current axis must win by before the axis may switch. */
  readonly axisSwitchRatio: number;
  /** Keys per second for each speed band, slowest first. */
  readonly rates: readonly number[];
}

export const DIRECTION_PAD_CONFIG: DirectionPadConfig = Object.freeze({
  holdMs: 380,
  pendingTravelPx: 12,
  enterPx: 24,
  exitPx: 17,
  speedEdges: Object.freeze([48, 76, 108]),
  speedHysteresisPx: 5,
  axisSwitchRatio: 1.28,
  rates: Object.freeze([1, 2, 4, 8]),
});

export interface DirectionPadState {
  readonly phase: DirectionPadPhase;
  /** The touch identifier that owns this gesture, or null while idle. */
  readonly fingerId: number | null;
  readonly originX: number;
  readonly originY: number;
  readonly x: number;
  readonly y: number;
  readonly direction: DirectionPadDirection | null;
  /** Index into `config.rates`; -1 when no direction is chosen. */
  readonly gear: number;
  /** Current keys-per-second rate; 0 when no direction is chosen. */
  readonly rate: number;
  /** Arrows emitted for this gesture. */
  readonly count: number;
  /** Diagnostic reason for the current phase. */
  readonly reason: string;
}

export interface DirectionPadMoveResult {
  /**
   * Whether the pad owns this move. False while pending (native gestures keep
   * the event) and after a surrender/cancel.
   */
  readonly owned: boolean;
  /** Whether the tracked finger still belongs to a live gesture. */
  readonly active: boolean;
  readonly direction?: DirectionPadDirection | null;
  readonly rate?: number;
}

export type DirectionPadTimer = unknown;

export interface DirectionPadEngineOptions {
  onState: (state: DirectionPadState) => void;
  onArrow: (direction: DirectionPadDirection, state: DirectionPadState) => void;
  /** Monotonic clock; injectable so the repeat schedule is testable. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => DirectionPadTimer;
  clearTimer?: (timer: DirectionPadTimer) => void;
  config?: DirectionPadConfig;
}

export interface DirectionPadEngine {
  start(fingerId: number, x: number, y: number): boolean;
  move(fingerId: number, x: number, y: number): DirectionPadMoveResult;
  end(fingerId: number, reason?: string): boolean;
  cancel(reason?: string): boolean;
  snapshot(): DirectionPadState;
  readonly config: DirectionPadConfig;
}

const IDLE_MOVE: DirectionPadMoveResult = Object.freeze({ owned: false, active: false });

function initialState(count = 0): DirectionPadState {
  return {
    phase: 'idle',
    fingerId: null,
    originX: 0,
    originY: 0,
    x: 0,
    y: 0,
    direction: null,
    gear: -1,
    rate: 0,
    count,
    reason: 'ready',
  };
}

/** Choose a direction, preferring the current axis until the other wins by a margin. */
function pickDirection(
  dx: number,
  dy: number,
  previous: DirectionPadDirection | null,
  axisSwitchRatio: number,
): DirectionPadDirection {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (previous !== null) {
    const vertical = previous === 'up' || previous === 'down';
    if (vertical && ay * axisSwitchRatio >= ax && dy !== 0) {
      return dy < 0 ? 'up' : 'down';
    }
    if (!vertical && ax * axisSwitchRatio >= ay && dx !== 0) {
      return dx < 0 ? 'left' : 'right';
    }
  }
  return ax >= ay ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
}

class DirectionPadGesture implements DirectionPadEngine {
  readonly config: DirectionPadConfig;
  private readonly onState: (state: DirectionPadState) => void;
  private readonly onArrow: (direction: DirectionPadDirection, state: DirectionPadState) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => DirectionPadTimer;
  private readonly clearTimer: (timer: DirectionPadTimer) => void;

  private state: DirectionPadState = initialState();
  private holdTimer: DirectionPadTimer | null = null;
  private repeatTimer: DirectionPadTimer | null = null;
  private lastKeyAt = 0;
  private generation = 0;

  constructor({
    onState,
    onArrow,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    config = DIRECTION_PAD_CONFIG,
  }: DirectionPadEngineOptions) {
    this.onState = onState;
    this.onArrow = onArrow;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.config = config;
  }

  snapshot(): DirectionPadState {
    return this.state;
  }

  start(fingerId: number, x: number, y: number): boolean {
    if (this.state.phase !== 'idle' || !Number.isFinite(fingerId)
      || !Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }
    const token = ++this.generation;
    this.state = {
      ...initialState(this.state.count),
      phase: 'pending',
      fingerId,
      originX: x,
      originY: y,
      x,
      y,
      reason: 'hold pending',
    };
    this.publish();
    this.holdTimer = this.setTimer(() => {
      if (token !== this.generation || this.state.phase !== 'pending') {
        return;
      }
      this.holdTimer = null;
      this.state = { ...this.state, phase: 'armed', reason: 'armed: touch captured' };
      this.publish();
    }, this.config.holdMs);
    return true;
  }

  move(fingerId: number, x: number, y: number): DirectionPadMoveResult {
    if (this.state.phase === 'idle' || this.state.fingerId !== fingerId
      || !Number.isFinite(x) || !Number.isFinite(y)) {
      return IDLE_MOVE;
    }

    const dx = x - this.state.originX;
    const dy = y - this.state.originY;
    const distance = Math.hypot(dx, dy);

    if (this.state.phase === 'pending') {
      return this.movePending(x, y, distance);
    }

    const previous = this.state.direction;
    const threshold = previous === null ? this.config.enterPx : this.config.exitPx;
    const direction = distance < threshold
      ? null
      : pickDirection(dx, dy, previous, this.config.axisSwitchRatio);
    const gear = direction === null
      ? -1
      : this.gearFor(distance, direction === previous ? this.state.gear : 0);
    const rate = direction === null ? 0 : this.config.rates[gear];
    const directionChanged = direction !== previous;
    const rateChanged = rate !== this.state.rate;

    this.state = {
      ...this.state,
      x,
      y,
      phase: direction === null ? 'armed' : 'moving',
      direction,
      gear,
      rate,
      reason: direction === null ? 'center: paused' : `${direction} @ ${rate}/s`,
    };

    if (directionChanged) {
      this.clearRepeatTimer();
      if (direction !== null) {
        this.emitCurrent();
        this.schedule();
      }
    } else if (rateChanged && direction !== null) {
      // Changing speed re-anchors the next tick; it never emits immediately.
      this.schedule();
    } else if (direction === null) {
      this.clearRepeatTimer();
    }

    this.publish();
    return { owned: true, active: true, direction, rate };
  }

  end(fingerId: number, reason = 'release'): boolean {
    if (this.state.phase === 'idle' || this.state.fingerId !== fingerId) {
      return false;
    }
    this.cancel(reason);
    return true;
  }

  cancel(reason = 'cancel'): boolean {
    const hadGesture = this.state.phase !== 'idle';
    this.generation += 1;
    this.clearHoldTimer();
    this.clearRepeatTimer();
    this.state = { ...initialState(this.state.count), reason };
    if (hadGesture) {
      this.publish();
    }
    return hadGesture;
  }

  private movePending(x: number, y: number, distance: number): DirectionPadMoveResult {
    if (distance > this.config.pendingTravelPx) {
      this.cancel('pre-arm movement: native gesture');
      return IDLE_MOVE;
    }
    this.state = { ...this.state, x, y };
    this.publish();
    return { owned: false, active: true };
  }

  private publish(): void {
    this.onState(this.state);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.clearTimer(this.holdTimer);
    }
    this.holdTimer = null;
  }

  private clearRepeatTimer(): void {
    if (this.repeatTimer !== null) {
      this.clearTimer(this.repeatTimer);
    }
    this.repeatTimer = null;
  }

  private gearFor(distance: number, previousGear: number): number {
    let gear = Math.max(0, previousGear);
    // A Schmitt trigger per boundary, including a multi-band jump in one move.
    while (gear < this.config.speedEdges.length
      && distance >= this.config.speedEdges[gear] + this.config.speedHysteresisPx) {
      gear += 1;
    }
    while (gear > 0
      && distance < this.config.speedEdges[gear - 1] - this.config.speedHysteresisPx) {
      gear -= 1;
    }
    return gear;
  }

  private emitCurrent(): void {
    const { phase, direction } = this.state;
    if (phase !== 'moving' || direction === null) {
      return;
    }
    this.lastKeyAt = this.now();
    this.state = { ...this.state, count: this.state.count + 1 };
    this.onArrow(direction, this.state);
    this.publish();
  }

  /**
   * The repeat clock is anchored to `lastKeyAt`, not to the last touchmove:
   * a finger that keeps moving must not postpone repeats forever.
   */
  private schedule(): void {
    this.clearRepeatTimer();
    if (this.state.phase !== 'moving' || this.state.direction === null) {
      return;
    }
    const token = this.generation;
    const delay = Math.max(0, this.lastKeyAt + 1000 / this.state.rate - this.now());
    this.repeatTimer = this.setTimer(() => {
      this.repeatTimer = null;
      if (token !== this.generation || this.state.phase !== 'moving'
        || this.state.direction === null) {
        return;
      }
      const remaining = this.lastKeyAt + 1000 / this.state.rate - this.now();
      if (remaining > 2) {
        // The timer fired early; wait out the remainder rather than emitting.
        this.schedule();
        return;
      }
      // One key per tick. A suspended timer (background tab, long stall) does
      // not catch up with a burst.
      this.emitCurrent();
      this.schedule();
    }, delay);
  }
}

/**
 * Create one gesture engine.
 *
 * `onArrow` is called synchronously on the same task as the state change that
 * caused it (direction entry, direction change, or a repeat tick), so a caller
 * that logs or forwards keys sees them in the same order the engine decided
 * them. A repeat tick emits at most one key; a late timer never catches up.
 */
export function createDirectionPadEngine(
  options: DirectionPadEngineOptions,
): DirectionPadEngine {
  return new DirectionPadGesture(options);
}
