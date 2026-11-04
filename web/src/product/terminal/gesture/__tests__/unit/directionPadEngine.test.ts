import { describe, expect, it } from 'vitest';
import {
  createDirectionPadEngine,
  type DirectionPadDirection,
  type DirectionPadState,
} from '../../directionPadEngine';

/**
 * A manual clock and timer queue.
 *
 * The engine's contract is about *when* keys are emitted, so the test has to
 * own time: real timers would make a 1/2/4/8 keys-per-second schedule a flaky
 * wall-clock race, and `vi.useFakeTimers` would still let the engine call
 * `performance.now()` behind the test's back.
 */
function createHarness() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fire: () => void }>();
  const arrows: Array<{ direction: DirectionPadDirection; at: number }> = [];
  const states: DirectionPadState[] = [];

  const engine = createDirectionPadEngine({
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { at: now + ms, fire: fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    onArrow: (direction) => {
      arrows.push({ direction, at: now });
    },
    onState: (state) => {
      states.push(state);
    },
  });

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      let next: { id: number; at: number; fire: () => void } | null = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) {
          next = { id, at: timer.at, fire: timer.fire };
        }
      }
      if (next === null) {
        break;
      }
      timers.delete(next.id);
      now = next.at;
      next.fire();
    }
    now = target;
  }

  return {
    engine,
    advance,
    arrows,
    states,
    get now() {
      return now;
    },
  };
}

describe('direction pad engine', () => {
  it('arms on a stationary hold without sending a key', () => {
    const h = createHarness();
    expect(h.engine.start(1, 100, 200)).toBe(true);
    expect(h.engine.snapshot().phase).toBe('pending');

    h.advance(379);
    expect(h.engine.snapshot().phase).toBe('pending');

    h.advance(1);
    expect(h.engine.snapshot().phase).toBe('armed');
    expect(h.engine.snapshot().direction).toBeNull();
    expect(h.arrows).toEqual([]);
  });

  it('surrenders a pending touch once it travels past the pre-arm slop', () => {
    const h = createHarness();
    h.engine.start(7, 100, 100);

    const result = h.engine.move(7, 113, 100);

    expect(result).toEqual({ owned: false, active: false });
    expect(h.engine.snapshot().phase).toBe('idle');
    h.advance(1_000);
    expect(h.arrows).toEqual([]);
  });

  it('emits exactly one semantic arrow when the finger leaves the enter dead zone', () => {
    const h = createHarness();
    h.engine.start(1, 100, 300);
    h.advance(380);

    expect(h.engine.move(1, 100, 275)).toMatchObject({ owned: true, active: true, direction: 'up' });
    expect(h.arrows.map((a) => a.direction)).toEqual(['up']);

    // 20px from the origin: inside the 24px entry radius, but past the 17px
    // exit radius, so the chosen direction must not chatter.
    expect(h.engine.move(1, 112, 284)).toMatchObject({ direction: 'up' });
    expect(h.arrows.map((a) => a.direction)).toEqual(['up']);
  });

  it('keeps the selected axis until the other axis clearly dominates', () => {
    const h = createHarness();
    h.engine.start(1, 200, 400);
    h.advance(380);

    // Mostly vertical but slightly right: up wins.
    h.engine.move(1, 215, 370);
    expect(h.engine.snapshot().direction).toBe('up');

    // A mild rightward bias does not flip the axis (1.28 hysteresis).
    h.engine.move(1, 235, 365);
    expect(h.engine.snapshot().direction).toBe('up');

    // A clearly horizontal move does.
    h.engine.move(1, 275, 365);
    expect(h.engine.snapshot().direction).toBe('right');
    expect(h.arrows.map((a) => a.direction)).toEqual(['up', 'right']);
  });

  it('stops at the contracted center and restarts when the finger leaves it again', () => {
    const h = createHarness();
    h.engine.start(1, 100, 300);
    h.advance(380);
    h.engine.move(1, 140, 300);
    expect(h.engine.snapshot().direction).toBe('right');

    h.engine.move(1, 125, 300); // 25px: inside the 24px entry but outside 17px exit
    expect(h.engine.snapshot().direction).toBe('right');

    h.engine.move(1, 112, 300); // 12px: inside the exit radius
    expect(h.engine.snapshot().direction).toBeNull();
    expect(h.engine.snapshot().phase).toBe('armed');

    const arrowsBeforeRestart = h.arrows.length;
    h.engine.move(1, 130, 300);
    expect(h.engine.snapshot().direction).toBe('right');
    expect(h.arrows.length).toBe(arrowsBeforeRestart + 1);
  });

  it('repeats at four bounded distance speeds without emitting on a speed change', () => {
    const h = createHarness();
    h.engine.start(1, 200, 400);
    h.advance(380);

    // 50px: 1/s. The first key is immediate.
    h.engine.move(1, 250, 400);
    expect(h.arrows).toHaveLength(1);
    expect(h.engine.snapshot().rate).toBe(1);

    // Crossing into the 8/s band does not add an extra key at the crossing.
    h.engine.move(1, 315, 400);
    expect(h.engine.snapshot().rate).toBe(8);
    expect(h.arrows).toHaveLength(1);

    // The repeat clock still counts from the last emitted key.
    h.advance(125);
    expect(h.arrows).toHaveLength(2);

    h.advance(125 * 7);
    expect(h.arrows).toHaveLength(9);
  });

  it('anchors repeats to the last emitted key, not to the latest touchmove', () => {
    const h = createHarness();
    h.engine.start(1, 200, 400);
    h.advance(380);

    h.engine.move(1, 250, 400); // 1/s, key at t=380
    expect(h.arrows).toHaveLength(1);

    // Keep moving — without changing direction or crossing a band — for more
    // than two seconds. Each move must not postpone the repeat.
    for (let i = 0; i < 20; i += 1) {
      h.advance(100);
      h.engine.move(1, 250 + (i % 3), 400);
    }

    expect(h.arrows.length).toBeGreaterThanOrEqual(3);
    const times = h.arrows.map((a) => a.at);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBe(1_000);
    }
  });

  it('continues repeating while the finger is held still in a direction', () => {
    const h = createHarness();
    h.engine.start(1, 200, 400);
    h.advance(380);
    h.engine.move(1, 300, 400); // 100px -> 4/s
    expect(h.engine.snapshot().rate).toBe(4);

    h.advance(1_000);
    expect(h.arrows).toHaveLength(5); // immediate + four repeats
  });

  it('does not amplify a stalled clock into a burst', () => {
    let now = 0;
    let scheduled: { at: number; fire: () => void } | null = null;
    const arrows: DirectionPadDirection[] = [];
    const engine = createDirectionPadEngine({
      now: () => now,
      setTimer: (fn, ms) => {
        scheduled = { at: now + ms, fire: fn };
        return scheduled;
      },
      clearTimer: (timer) => {
        if (scheduled === timer) {
          scheduled = null;
        }
      },
      onArrow: (direction) => arrows.push(direction),
      onState: () => {},
    });

    engine.start(1, 0, 0);
    now = 380;
    if (scheduled === null) { throw new Error('hold timer missing'); }
    const hold = scheduled as { at: number; fire: () => void };
    hold.fire();
    engine.move(1, 100, 0); // 4/s
    expect(arrows).toHaveLength(1);

    // The timer fires five seconds late, as it would after a suspended tab.
    now += 5_000;
    if (scheduled === null) { throw new Error('repeat timer missing'); }
    const repeat = scheduled as { at: number; fire: () => void };
    repeat.fire();

    expect(arrows).toHaveLength(2);
    expect((scheduled as { at: number } | null)?.at).toBe(now + 250);
  });

  it('stops the repeater on center return, release and cancellation', () => {
    const h = createHarness();
    h.engine.start(1, 200, 400);
    h.advance(380);
    h.engine.move(1, 300, 400);
    expect(h.arrows).toHaveLength(1);

    h.engine.move(1, 200, 400);
    h.advance(5_000);
    expect(h.arrows).toHaveLength(1);

    h.engine.move(1, 300, 400);
    expect(h.arrows).toHaveLength(2);
    expect(h.engine.end(1, 'released')).toBe(true);
    h.advance(5_000);
    expect(h.arrows).toHaveLength(2);
    expect(h.engine.snapshot().phase).toBe('idle');

    h.engine.start(2, 0, 0);
    h.advance(380);
    h.engine.move(2, 100, 0);
    expect(h.arrows).toHaveLength(3);
    expect(h.engine.cancel('visibility')).toBe(true);
    h.advance(5_000);
    expect(h.arrows).toHaveLength(3);
  });

  it('ignores moves and ends from a finger that does not own the gesture', () => {
    const h = createHarness();
    expect(h.engine.start(1, 100, 100)).toBe(true);

    expect(h.engine.move(2, 50, 50)).toEqual({ owned: false, active: false });
    expect(h.engine.end(2)).toBe(false);
    expect(h.engine.snapshot().fingerId).toBe(1);

    // A second start attempt cannot replace a live gesture.
    expect(h.engine.start(3, 0, 0)).toBe(false);
    expect(h.engine.snapshot().fingerId).toBe(1);
  });
});
