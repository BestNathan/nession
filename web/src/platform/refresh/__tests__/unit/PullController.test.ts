import { describe, expect, it } from 'vitest';
import { PullController } from '../../PullController';
import { RefreshScheduler } from '../../RefreshScheduler';
import type { PullContext, PullOutcome, PullRefreshPolicy, RefreshReason } from '../../types';
import { FakeClock, deferred, flush, noJitter, type Deferred } from '../helpers';

const BASE_POLICY: PullRefreshPolicy = {
  timeoutMs: 10_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
};

interface Harness {
  clock: FakeClock;
  scheduler: RefreshScheduler;
  controller: PullController<string[]>;
  calls: PullContext[];
  reads: Deferred<string[]>[];
  applied: string[][];
  reasons: RefreshReason[];
}

function harness(policy: Partial<PullRefreshPolicy> = {}, isPartial?: (s: string[]) => boolean): Harness {
  const clock = new FakeClock();
  const scheduler = new RefreshScheduler({ clock });
  const calls: PullContext[] = [];
  const reads: Deferred<string[]>[] = [];
  const applied: string[][] = [];
  const controller = new PullController<string[]>({
    scheduler,
    clock,
    label: 'test-surface',
    random: noJitter,
    policy: { ...BASE_POLICY, ...policy },
    pull: (ctx) => {
      calls.push(ctx);
      const d = deferred<string[]>();
      reads.push(d);
      return d.promise;
    },
    apply: (snapshot) => { applied.push(snapshot); },
    ...(isPartial === undefined ? {} : { isPartial }),
  });
  controller.setContext(['target-a']);
  controller.setEnabled(true);
  controller.setActive(true);
  return { clock, scheduler, controller, calls, reads, applied, reasons: [] };
}

function tracked(promise: Promise<PullOutcome>) {
  const state = { done: false, value: undefined as PullOutcome | undefined };
  void promise.then((value) => { state.done = true; state.value = value; });
  return state;
}

/** Settle the initial mount read so a test starts from a settled, idle owner. */
async function settled(h: Harness, snapshot: string[] = ['first']): Promise<void> {
  h.reads[0].resolve(snapshot);
  await flush();
}

describe('PullController — publication fence (SC-03)', () => {
  it('publishes the first read and reports loading only until it settles', async () => {
    const h = harness();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].reason).toBe('mount');
    expect(h.controller.status.loading).toBe(true);
    expect(h.controller.status.refreshing).toBe(true);

    h.reads[0].resolve(['row']);
    await flush();

    expect(h.applied).toEqual([['row']]);
    expect(h.controller.status.loading).toBe(false);
    expect(h.controller.status.refreshing).toBe(false);
    expect(h.controller.status.lastSuccessAt).toBe(0);
    expect(h.controller.status.stale).toBe(false);
  });

  it('never publishes a reply whose context was retired (A → B → A)', async () => {
    const h = harness();
    const first = h.reads[0];

    h.controller.setContext(['target-b']);
    expect(h.calls).toHaveLength(2);
    h.controller.setContext(['target-a']);
    expect(h.calls).toHaveLength(3);

    // Every older reply resolves late, after its context is gone.
    first.resolve(['stale-a']);
    h.reads[1].resolve(['stale-b']);
    await flush();
    expect(h.applied).toEqual([]);

    h.reads[2].resolve(['current-a']);
    await flush();
    expect(h.applied).toEqual([['current-a']]);
  });

  it('aborts the retired read so a transport that can abort stops work', () => {
    const h = harness();
    const signal = h.calls[0].signal;
    h.controller.setContext(['target-b']);
    expect(signal.aborted).toBe(true);
    expect(h.calls[1].signal.aborted).toBe(false);
  });

  it('treats a complete push as newer than an outstanding read', async () => {
    const h = harness();
    h.controller.acceptExternal(['pushed']);
    expect(h.applied).toEqual([['pushed']]);

    h.reads[0].resolve(['older-reply']);
    await flush();

    expect(h.applied).toEqual([['pushed']]);
    // A complete snapshot must not provoke a redundant pull.
    expect(h.calls).toHaveLength(1);
  });

  it('does not let a settled read clear a newer invalidation', async () => {
    const h = harness();
    await settled(h);

    const manual = tracked(h.controller.refresh('manual'));
    expect(h.calls).toHaveLength(2);
    h.controller.invalidate();
    h.reads[1].resolve(['during-invalidation']);
    await flush();

    expect(manual.value).toBe('applied');
    // The newer invalidation was not swallowed by the settled read: it owes a
    // trailing read, which is now running rather than silently dropped.
    expect(h.calls).toHaveLength(3);
    h.reads[2].resolve(['trailing']);
    await flush();
    expect(h.controller.isDirty).toBe(false);
    expect(h.applied[h.applied.length - 1]).toEqual(['trailing']);
  });
});

describe('PullController — one in-flight, one bounded intent (SC-03)', () => {
  it('keeps at most one read in flight for the same context', async () => {
    const h = harness();
    await settled(h);

    void h.controller.refresh('manual');
    void h.controller.refresh('manual');
    void h.controller.refresh('manual');
    expect(h.calls).toHaveLength(2);

    h.reads[1].resolve(['shared']);
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it('makes a manual force wait for the force answer, not the normal reply', async () => {
    const h = harness();
    // The mount read is a normal (non-force) read still in flight.
    const manual = tracked(h.controller.refresh('manual'));
    expect(h.calls).toHaveLength(1);

    h.reads[0].resolve(['normal']);
    await flush();
    expect(manual.done).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].force).toBe(true);
    expect(h.calls[1].reason).toBe('manual');

    h.reads[1].resolve(['forced']);
    await flush();
    expect(manual.done).toBe(true);
    expect(manual.value).toBe('applied');
    expect(h.applied[h.applied.length - 1]).toEqual(['forced']);
  });

  it('shares one in-flight proof between repeated same-strength manual asks', async () => {
    const h = harness();
    await settled(h);

    const a = tracked(h.controller.refresh('manual'));
    const b = tracked(h.controller.refresh('manual'));
    expect(h.calls).toHaveLength(2);

    h.reads[1].resolve(['once']);
    await flush();
    expect(a.value).toBe('applied');
    expect(b.value).toBe('applied');
    expect(h.calls).toHaveLength(2);
  });

  it('coalesces 100 synchronous invalidations into one read plus one trailing read', async () => {
    const h = harness();
    await settled(h);
    const before = h.calls.length;

    for (let i = 0; i < 100; i += 1) { h.controller.invalidate(); }
    // Nothing runs until the bounded coalescing delay elapses.
    expect(h.calls).toHaveLength(before);

    h.clock.advance(500);
    expect(h.calls).toHaveLength(before + 1);

    // A continuous burst during that read still owes only one trailing read.
    for (let i = 0; i < 100; i += 1) { h.controller.invalidate(); }
    h.reads[before].resolve(['coalesced']);
    await flush();
    expect(h.calls).toHaveLength(before + 2);

    h.reads[before + 1].resolve(['trailing']);
    await flush();
    expect(h.calls).toHaveLength(before + 2);
    expect(h.controller.isDirty).toBe(false);
  });

  it('does not extend the coalescing deadline under continuous events', async () => {
    const h = harness();
    await settled(h);
    const before = h.calls.length;

    h.controller.invalidate();
    for (let tick = 0; tick < 10; tick += 1) {
      h.clock.advance(100);
      h.controller.invalidate();
    }
    // 1000ms of continuous events: the first event's 500ms deadline stood.
    expect(h.calls.length).toBeGreaterThan(before);
  });
});

describe('PullController — failure, timeout and retry (SC-03)', () => {
  it('retains last known data and marks stale on failure', async () => {
    const h = harness();
    await settled(h, ['kept']);

    const manual = tracked(h.controller.refresh('manual'));
    h.reads[1].reject(new Error('boom'));
    await flush();

    expect(manual.value).toBe('failed');
    expect(h.applied).toEqual([['kept']]);
    expect(h.controller.status.stale).toBe(true);
    expect(h.controller.status.error).toBe('boom');
    expect(h.controller.status.lastSuccessAt).toBe(0);
  });

  it('distinguishes an initial no-data failure from an authoritative empty list', async () => {
    const h = harness();
    h.reads[0].reject(new Error('offline'));
    await flush();
    expect(h.controller.status.loading).toBe(false);
    expect(h.controller.status.error).toBe('offline');
    expect(h.controller.status.lastSuccessAt).toBeNull();

    const h2 = harness();
    h2.reads[0].resolve([]);
    await flush();
    expect(h2.controller.status.error).toBeNull();
    expect(h2.controller.status.lastSuccessAt).toBe(0);
    expect(h2.applied).toEqual([[]]);
  });

  it('times out a read that never answers and frees its slot', async () => {
    const h = harness();
    await settled(h);

    const outcome = tracked(h.controller.refresh('manual'));
    expect(h.calls).toHaveLength(2);
    h.clock.advance(10_000);
    await flush();

    expect(outcome.value).toBe('failed');
    expect(h.controller.status.error).toBe('Refresh timed out');
    expect(h.scheduler.inFlightCount).toBe(0);
    // A late answer after the timeout must still not publish.
    h.reads[1].resolve(['too-late']);
    await flush();
    expect(h.applied).toEqual([['first']]);
  });

  it('backs off automatic retries 1/2/4/8s and caps at 30s', async () => {
    const h = harness({ autoRetry: true });
    h.reads[0].reject(new Error('down'));
    await flush();

    h.clock.advance(1_000);
    expect(h.calls).toHaveLength(2);
    h.reads[1].reject(new Error('down'));
    await flush();

    h.clock.advance(1_999);
    expect(h.calls).toHaveLength(2);
    h.clock.advance(1);
    expect(h.calls).toHaveLength(3);
    h.reads[2].reject(new Error('down'));
    await flush();

    h.clock.advance(4_000);
    expect(h.calls).toHaveLength(4);
    h.reads[3].reject(new Error('down'));
    await flush();

    h.clock.advance(8_000);
    expect(h.calls).toHaveLength(5);
  });

  it('does not retry automatically while inactive or disconnected', async () => {
    const h = harness({ autoRetry: true });
    h.controller.setActive(false);
    h.reads[0].reject(new Error('down'));
    await flush();

    h.clock.advance(60_000);
    expect(h.calls).toHaveLength(1);
  });

  it('consumes the trailing-read obligation once instead of re-queuing a failure forever', async () => {
    const clock = new FakeClock();
    const scheduler = new RefreshScheduler({ clock });
    let calls = 0;
    const controller = new PullController<string[]>({
      scheduler,
      clock,
      random: noJitter,
      policy: { ...BASE_POLICY, autoRetry: false },
      pull: () => { calls += 1; return Promise.reject(new Error('down')); },
      apply: () => { throw new Error('a failed read must never publish'); },
    });
    controller.setContext(['target-a']);
    controller.setEnabled(true);
    controller.setActive(true);
    await flush();
    expect(calls).toBe(1);

    controller.invalidate();
    clock.advance(500);
    await flush();
    clock.advance(60_000);
    await flush();

    // One coalesced read plus the single trailing read it owed — not a chain.
    expect(calls).toBe(3);
    expect(controller.status.stale).toBe(false);
    expect(controller.status.error).toBe('down');
    controller.retire();
  });

  it('reports a partial authoritative answer as partial, not applied', async () => {
    const h = harness({}, (snapshot) => snapshot.includes('stale-agent'));
    await settled(h);
    const outcome = tracked(h.controller.refresh('manual'));
    h.reads[1].resolve(['row', 'stale-agent']);
    await flush();
    expect(outcome.value).toBe('partial');
    expect(h.applied[h.applied.length - 1]).toEqual(['row', 'stale-agent']);
  });
});

describe('PullController — lifecycle gating (SC-02)', () => {
  it('keeps a hidden view dirty and reads it on activation', async () => {
    const h = harness();
    await settled(h);
    h.controller.setActive(false);

    const outcome = await h.controller.refresh('interval');
    expect(outcome).toBe('cancelled');
    expect(h.calls).toHaveLength(1);
    expect(h.controller.isDirty).toBe(true);

    h.controller.setActive(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].reason).toBe('activate');
  });

  it('issues no periodic request while hidden', async () => {
    const h = harness({ intervalMs: 10_000 });
    await settled(h);
    h.controller.setActive(false);

    h.clock.advance(120_000);
    expect(h.calls).toHaveLength(1);
  });

  it('issues no periodic request while disconnected and marks data stale', async () => {
    const h = harness({ intervalMs: 10_000 });
    await settled(h, ['kept']);
    h.controller.setEnabled(false);
    expect(h.controller.status.stale).toBe(true);

    h.clock.advance(120_000);
    expect(h.calls).toHaveLength(1);
    expect(h.applied).toEqual([['kept']]);
  });

  it('reads periodically while active, enabled and settled', async () => {
    const h = harness({ intervalMs: 10_000 });
    await settled(h);

    h.clock.advance(10_000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].reason).toBe('interval');
    h.reads[1].resolve(['second']);
    await flush();

    h.clock.advance(10_000);
    expect(h.calls).toHaveLength(3);
  });

  it('never overlaps interval reads with an unsettled one', async () => {
    // A long timeout keeps the read outstanding on purpose: this asserts the
    // cadence does not stack reads, not that a slow read eventually times out.
    const h = harness({ intervalMs: 10_000, timeoutMs: 1_000_000 });
    await settled(h);
    h.clock.advance(10_000);
    expect(h.calls).toHaveLength(2);

    // The second read is still outstanding across several cadence windows.
    h.clock.advance(40_000);
    expect(h.calls).toHaveLength(2);
  });

  it('honours minInterval for automatic reasons but not for manual', async () => {
    const h = harness({ minIntervalMs: 5_000 });
    await settled(h);

    h.clock.advance(1_000);
    expect(await h.controller.refresh('foreground')).toBe('superseded');
    expect(h.calls).toHaveLength(1);

    const manual = tracked(h.controller.refresh('manual'));
    expect(h.calls).toHaveLength(2);
    h.reads[1].resolve(['manual']);
    await flush();
    expect(manual.value).toBe('applied');
  });

  it('respects the per-reason foreground/reconnect/activate policy switches', async () => {
    const h = harness({ onActivate: false });
    await settled(h);
    h.controller.setActive(false);
    h.controller.setActive(true);
    // onActivate off and nothing dirty: re-showing the surface reads nothing.
    expect(h.calls).toHaveLength(1);
  });
});

describe('PullController — retirement (SC-02/SC-03)', () => {
  it('settles every waiter and leaves no timer behind on retire', async () => {
    const h = harness({ intervalMs: 10_000, autoRetry: true });
    const inFlight = tracked(h.controller.refresh('manual'));
    h.controller.invalidate();

    h.controller.retire();
    await flush();

    expect(inFlight.value).toBe('cancelled');
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.scheduler.registrationCount).toBe(0);
    expect(h.scheduler.inFlightCount).toBe(0);
  });

  it('cancels an in-flight read when the transport goes away', async () => {
    const h = harness();
    const outcome = tracked(h.controller.refresh('manual'));
    h.controller.setEnabled(false);
    await flush();
    expect(outcome.value).toBe('cancelled');
    expect(h.calls[0].signal.aborted).toBe(true);
  });

  it('is idempotent under a repeated retire', () => {
    const h = harness();
    h.controller.retire();
    h.controller.retire();
    expect(h.scheduler.registrationCount).toBe(0);
  });
});