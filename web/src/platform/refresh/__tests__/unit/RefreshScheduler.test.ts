import { describe, expect, it } from 'vitest';
import { RefreshScheduler, type RefreshRegistration } from '../../RefreshScheduler';
import { FakeClock } from '../helpers';

interface Probe extends RefreshRegistration {
  owner: object;
  target?: string;
  starts: number;
  dues: number;
  lastPriority: string | null;
}

function probe(target?: string): Probe {
  const registration: Probe = {
    owner: {},
    starts: 0,
    dues: 0,
    lastPriority: null,
    ...(target === undefined ? {} : { target }),
    start(priority) { registration.starts += 1; registration.lastPriority = priority; },
    due() { registration.dues += 1; },
  };
  return registration;
}

function setup(options: { maxInFlight?: number; maxPerTarget?: number } = {}) {
  const clock = new FakeClock();
  const scheduler = new RefreshScheduler({ clock, ...options });
  return { clock, scheduler };
}

describe('RefreshScheduler — in-flight budget (SC-07)', () => {
  it('caps concurrent reads globally at four', () => {
    const { scheduler } = setup();
    const probes = Array.from({ length: 6 }, () => probe());
    for (const p of probes) { scheduler.register(p); scheduler.enqueue(p.owner, 'auto'); }

    expect(scheduler.inFlightCount).toBe(4);
    expect(probes.map((p) => p.starts)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(scheduler.queueLength).toBe(2);
  });

  it('frees a slot on release and dispatches the next queued controller', () => {
    const { scheduler } = setup();
    const probes = Array.from({ length: 5 }, () => probe());
    for (const p of probes) { scheduler.register(p); scheduler.enqueue(p.owner, 'auto'); }

    scheduler.release(probes[0].owner);
    expect(probes[4].starts).toBe(1);
    expect(scheduler.inFlightCount).toBe(4);
  });

  it('caps concurrent reads per routing target at two', () => {
    const { scheduler } = setup();
    const same = Array.from({ length: 3 }, () => probe('agent-1'));
    const other = probe('agent-2');
    for (const p of [...same, other]) { scheduler.register(p); scheduler.enqueue(p.owner, 'auto'); }

    expect(same.map((p) => p.starts)).toEqual([1, 1, 0]);
    expect(other.starts).toBe(1);
    expect(scheduler.inFlightCount).toBe(3);
  });

  it('does not grant a second slot to a controller already reading', () => {
    const { scheduler } = setup();
    const p = probe();
    scheduler.register(p);
    scheduler.enqueue(p.owner, 'auto');
    scheduler.enqueue(p.owner, 'manual');

    expect(p.starts).toBe(1);
    expect(scheduler.queueLength).toBe(1);
    scheduler.release(p.owner);
    expect(p.starts).toBe(2);
    expect(p.lastPriority).toBe('manual');
  });
});

describe('RefreshScheduler — queue bounds, priority and fairness (SC-07)', () => {
  it('keeps one bounded queue entry per controller and only raises priority', () => {
    const { scheduler } = setup({ maxInFlight: 1 });
    const blocker = probe();
    const p = probe();
    scheduler.register(blocker);
    scheduler.register(p);
    scheduler.enqueue(blocker.owner, 'auto');

    scheduler.enqueue(p.owner, 'auto');
    scheduler.enqueue(p.owner, 'auto');
    scheduler.enqueue(p.owner, 'manual');
    expect(scheduler.queueLength).toBe(1);

    scheduler.release(blocker.owner);
    expect(p.starts).toBe(1);
    expect(p.lastPriority).toBe('manual');
  });

  it('serves a manual ask ahead of queued automatic reads', () => {
    const { scheduler } = setup({ maxInFlight: 1 });
    const blocker = probe();
    const auto = probe();
    const manual = probe();
    for (const p of [blocker, auto, manual]) { scheduler.register(p); }
    scheduler.enqueue(blocker.owner, 'auto');
    scheduler.enqueue(auto.owner, 'auto');
    scheduler.enqueue(manual.owner, 'manual');

    scheduler.release(blocker.owner);
    expect(manual.starts).toBe(1);
    expect(auto.starts).toBe(0);
  });

  it('serves automatic reads round-robin so a chatty list cannot starve others', () => {
    const { scheduler } = setup({ maxInFlight: 1 });
    const order: string[] = [];
    const named = (name: string): Probe => {
      const p = probe();
      p.start = (priority) => { order.push(name); p.starts += 1; p.lastPriority = priority; };
      return p;
    };
    const a = named('a');
    const b = named('b');
    const c = named('c');
    for (const p of [a, b, c]) { scheduler.register(p); }

    scheduler.enqueue(a.owner, 'auto');
    scheduler.enqueue(b.owner, 'auto');
    scheduler.enqueue(c.owner, 'auto');
    scheduler.release(a.owner);
    scheduler.release(b.owner);
    expect(order).toEqual(['a', 'b', 'c']);

    // `c` still holds the only slot. Queue in reverse arrival order: service
    // follows who waited longest, not who asked first.
    scheduler.enqueue(b.owner, 'auto');
    scheduler.enqueue(a.owner, 'auto');
    scheduler.release(c.owner);
    expect(order).toEqual(['a', 'b', 'c', 'a']);
    scheduler.release(a.owner);
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  it('withdraws a queued intent without touching a running read', () => {
    const { scheduler } = setup({ maxInFlight: 1 });
    const running = probe();
    const queued = probe();
    scheduler.register(running);
    scheduler.register(queued);
    scheduler.enqueue(running.owner, 'auto');
    scheduler.enqueue(queued.owner, 'auto');

    scheduler.cancelRequest(queued.owner);
    expect(scheduler.queueLength).toBe(0);
    scheduler.release(running.owner);
    expect(queued.starts).toBe(0);
    expect(scheduler.inFlightCount).toBe(0);
  });

  it('ignores requests from an unregistered controller', () => {
    const { scheduler } = setup();
    const p = probe();
    scheduler.enqueue(p.owner, 'manual');
    expect(scheduler.queueLength).toBe(0);
    expect(p.starts).toBe(0);
  });
});

describe('RefreshScheduler — due times on one timer (SC-02/SC-07)', () => {
  it('shares a single timer across every armed controller', () => {
    const { clock, scheduler } = setup();
    const probes = Array.from({ length: 3 }, () => probe());
    for (const p of probes) { scheduler.register(p); }
    scheduler.arm(probes[0].owner, 1_000);
    scheduler.arm(probes[1].owner, 2_000);
    scheduler.arm(probes[2].owner, 3_000);

    expect(clock.pendingTimers).toBe(1);
    clock.advance(1_000);
    expect(probes.map((p) => p.dues)).toEqual([1, 0, 0]);
    clock.advance(2_000);
    expect(probes.map((p) => p.dues)).toEqual([1, 1, 1]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('re-arming replaces the previous due time rather than stacking timers', () => {
    const { clock, scheduler } = setup();
    const p = probe();
    scheduler.register(p);
    scheduler.arm(p.owner, 1_000);
    scheduler.arm(p.owner, 5_000);
    expect(clock.pendingTimers).toBe(1);

    clock.advance(1_000);
    expect(p.dues).toBe(0);
    clock.advance(4_000);
    expect(p.dues).toBe(1);
  });

  it('drops due times and frees the slot when a controller unregisters', () => {
    const { clock, scheduler } = setup({ maxInFlight: 1 });
    const p = probe();
    const waiting = probe();
    scheduler.register(p);
    scheduler.register(waiting);
    scheduler.enqueue(p.owner, 'auto');
    scheduler.arm(p.owner, 1_000);
    scheduler.enqueue(waiting.owner, 'auto');

    scheduler.unregister(p.owner);
    expect(waiting.starts).toBe(1);
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(p.dues).toBe(0);
    expect(scheduler.registrationCount).toBe(1);
  });

  it('stops every timer on dispose', () => {
    const { clock, scheduler } = setup();
    const p = probe();
    scheduler.register(p);
    scheduler.arm(p.owner, 1_000);
    scheduler.dispose();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(p.dues).toBe(0);
  });
});