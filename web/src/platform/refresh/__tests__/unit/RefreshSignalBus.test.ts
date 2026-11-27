import { describe, expect, it } from 'vitest';
import { RefreshSignalBus } from '../../RefreshSignalBus';
import { RefreshTelemetry } from '../../RefreshTelemetry';
import type { RefreshTelemetryEvent } from '../../PullController';
import type { RefreshReason } from '../../types';

describe('RefreshSignalBus — resume dedupe (SC-02)', () => {
  it('delivers foreground and reconnect to every subscriber', () => {
    let time = 0;
    const bus = new RefreshSignalBus(() => time);
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => { seen.push(event.signal); });

    bus.emit({ signal: 'foreground' });
    time = 5_000;
    bus.emit({ signal: 'reconnect', generation: 2 });
    expect(seen).toEqual(['foreground', 'reconnect']);

    unsubscribe();
    bus.emit({ signal: 'foreground' });
    expect(seen).toEqual(['foreground', 'reconnect']);
    expect(bus.listenerCount).toBe(0);
  });

  it('suppresses a foreground read that a reconnect already covered', () => {
    let time = 0;
    const bus = new RefreshSignalBus(() => time);
    const seen: string[] = [];
    bus.subscribe((event) => { seen.push(event.signal); });

    bus.emit({ signal: 'reconnect' });
    time = 200;
    bus.emit({ signal: 'foreground' });
    expect(seen).toEqual(['reconnect']);

    // Outside the dedupe window a genuine later foreground still reads.
    time = 2_000;
    bus.emit({ signal: 'foreground' });
    expect(seen).toEqual(['reconnect', 'foreground']);
  });

  it('does not suppress reconnect behind foreground', () => {
    const bus = new RefreshSignalBus(() => 0);
    const seen: string[] = [];
    bus.subscribe((event) => { seen.push(event.signal); });
    bus.emit({ signal: 'foreground' });
    bus.emit({ signal: 'reconnect' });
    expect(seen).toEqual(['foreground', 'reconnect']);
  });
});

function event(
  kind: RefreshTelemetryEvent['kind'],
  reason: RefreshReason = 'manual',
  label = 'session-list',
  latencyMs?: number,
): RefreshTelemetryEvent {
  return { label, reason, kind, at: 10, ...(latencyMs === undefined ? {} : { latencyMs }) };
}

describe('RefreshTelemetry — low-cardinality aggregation (SC-07)', () => {
  it('aggregates pulls, merges, failures and drops by surface and reason', () => {
    const telemetry = new RefreshTelemetry();
    telemetry.record(event('pull'));
    telemetry.record(event('pull'));
    telemetry.record(event('coalesced'));
    telemetry.record(event('applied', 'manual', 'session-list', 40));
    telemetry.record(event('failed', 'manual', 'session-list', 90));
    telemetry.record(event('dropped', 'interval'));
    telemetry.record(event('pull', 'interval'));

    const rows = telemetry.snapshot();
    const manual = rows.find((row) => row.reason === 'manual');
    const interval = rows.find((row) => row.reason === 'interval');
    expect(manual?.pulls).toBe(2);
    expect(manual?.coalesced).toBe(1);
    expect(manual?.applied).toBe(1);
    expect(manual?.failed).toBe(1);
    expect(manual?.latencyTotalMs).toBe(130);
    expect(manual?.latencySamples).toBe(2);
    expect(manual?.lastSuccessAt).toBe(10);
    expect(interval?.pulls).toBe(1);
    expect(interval?.dropped).toBe(1);
  });

  it('bounds label cardinality instead of tracking session or path values', () => {
    const telemetry = new RefreshTelemetry();
    for (let i = 0; i < 200; i += 1) {
      telemetry.record(event('pull', 'manual', `surface-${i}`));
    }
    const rows = telemetry.snapshot();
    expect(rows.length).toBeLessThanOrEqual(65);
    expect(rows.some((row) => row.label === 'other')).toBe(true);
  });

  it('returns copies so a caller cannot mutate the counters', () => {
    const telemetry = new RefreshTelemetry();
    telemetry.record(event('pull'));
    const rows = telemetry.snapshot();
    rows[0].pulls = 999;
    expect(telemetry.snapshot()[0].pulls).toBe(1);
    telemetry.clear();
    expect(telemetry.snapshot()).toEqual([]);
  });
});