import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeScheduler } from '../../ProbeScheduler';
import { probeStateKey, type ProbeDiagnostic, type ProbeTarget } from '../../types';

interface PendingProbe {
  url: string;
  resolve: (result: { reachability: 'reachable' | 'unreachable'; latencyMs: number | null; failureReason?: string }) => void;
}

const control = vi.hoisted(() => ({
  httpPending: [] as PendingProbe[],
  httpCalls: [] as string[],
  legacyCalls: [] as string[],
}));

vi.mock('../../httpProbe', () => ({
  measureHttpProbe: (url: string, opts?: { signal?: AbortSignal }) => {
    control.httpCalls.push(url);
    return new Promise((resolve) => {
      const entry: PendingProbe = { url, resolve };
      control.httpPending.push(entry);
      opts?.signal?.addEventListener('abort', () => {
        const index = control.httpPending.indexOf(entry);
        if (index >= 0) {
          control.httpPending.splice(index, 1);
        }
        resolve({ reachability: 'unreachable', latencyMs: null, failureReason: 'cancelled' });
      });
    });
  },
  isHttpProbeUrl: (url: string) => /^https?:\/\//i.test(url),
}));

vi.mock('@/shared/lib/addressSelection', () => ({
  measureLatency: (url: string, opts?: { timeoutMs?: number }) => {
    control.legacyCalls.push(url);
    return new Promise((resolve) => {
      const entry: PendingProbe = { url, resolve: (r) => resolve({ url, latencyMs: r.latencyMs }) };
      control.httpPending.push(entry);
      // The legacy WS double has no abort signal; the scheduler fences its
      // result by generation instead.
      void opts;
    });
  },
}));

function httpTarget(targetId: string, urls: string[]): ProbeTarget {
  return {
    targetId,
    kind: 'agent',
    addresses: urls.map((url) => ({
      addressId: url,
      wsUrl: url,
      probeUrl: url.replace(/^ws/, 'http').replace(/\/ws$/, '/probe'),
    })),
  };
}

async function settle(url: string, reachable: boolean, latencyMs: number | null = 10): Promise<void> {
  const index = control.httpPending.findIndex((p) => p.url === url);
  if (index < 0) {
    throw new Error(`no pending probe for ${url}; pending=${control.httpPending.map((p) => p.url).join(',')}`);
  }
  const [entry] = control.httpPending.splice(index, 1);
  entry.resolve(reachable
    ? { reachability: 'reachable', latencyMs }
    : { reachability: 'unreachable', latencyMs: null, failureReason: 'blocked-or-network' });
  await vi.advanceTimersByTimeAsync(0);
}

async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

describe('ProbeScheduler (#4618)', () => {
  let diagnostics: ProbeDiagnostic[];
  let scheduler: ProbeScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    control.httpPending.length = 0;
    control.httpCalls.length = 0;
    control.legacyCalls.length = 0;
    diagnostics = [];
    scheduler = new ProbeScheduler({ onDiagnostic: (d) => diagnostics.push(d) });
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('SC-02 scheduling', () => {
    it('probes a healthy visible target every 300000ms by default', async () => {
      scheduler.setIntervalMs(300_000);
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(1);
      await settle('http://a/probe', true);

      await vi.advanceTimersByTimeAsync(300_000);
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(2);
      expect(diagnostics.some((d) => d.event === 'refresh' && d.trigger === 'periodic')).toBe(true);
    });

    it('honors a configured interval and disables periodic at 0', async () => {
      scheduler.setIntervalMs(60_000);
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      await settle('http://a/probe', true);
      await vi.advanceTimersByTimeAsync(60_000);
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(2);

      scheduler.setIntervalMs(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(control.httpCalls).toHaveLength(2); // periodic disabled, no new round
    });

    it('foreground, online and manual refresh probe again even with unchanged URLs', async () => {
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      await settle('http://a/probe', true);

      scheduler.setVisible(false);
      scheduler.setVisible(true); // foreground
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(2);
      await settle('http://a/probe', true);

      scheduler.handleOnline();
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(3);
      await settle('http://a/probe', true);

      scheduler.refresh('agent-a', 'manual');
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(4);
    });

    it('suspends periodic work while hidden and stops retired targets', async () => {
      scheduler.setIntervalMs(300_000);
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      await settle('http://a/probe', true);

      scheduler.setVisible(false);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(control.httpCalls).toHaveLength(1); // hidden: no periodic

      scheduler.setVisible(true);
      await fireDebounce();
      await settle('http://a/probe', true);
      scheduler.unregisterTarget('agent-a');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(control.httpCalls).toHaveLength(2); // retired: no further work
    });

    it('coalesces repeated signals into one round and never polls the whole fleet', async () => {
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      scheduler.registerTarget(httpTarget('agent-b', ['ws://b/ws']));
      scheduler.refresh('agent-a', 'manual');
      scheduler.refresh('agent-a', 'transport-loss');
      scheduler.refresh('agent-a', 'retry-failure');
      await fireDebounce();
      // One effective round for agent-a (one address), agent-b untouched by the
      // agent-a triggers.
      expect(control.httpCalls.filter((u) => u.includes('a/probe'))).toHaveLength(1);
      expect(control.httpCalls.filter((u) => u.includes('b/probe'))).toHaveLength(1); // mount only
    });
  });

  describe('SC-03 incremental publication and bounds', () => {
    it('publishes fast candidate A before slow B settles; B writes its own result', async () => {
      const seen: number[] = [];
      scheduler.subscribe(() => seen.push(scheduler.getSnapshot().version));
      scheduler.registerTarget(httpTarget('agent-a', ['ws://fast/ws', 'ws://slow/ws']));
      await fireDebounce();
      expect(control.httpCalls).toHaveLength(2);

      await settle('http://fast/probe', true, 5);
      const fastState = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://fast/ws'));
      const slowState = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://slow/ws'));
      expect(fastState?.reachability).toBe('reachable');
      expect(fastState?.latencyMs).toBe(5);
      expect(slowState?.probing).toBe(true);
      expect(slowState?.reachability).toBe('unknown'); // B not settled yet
      expect(seen.length).toBeGreaterThan(0);

      await settle('http://slow/probe', true, 900);
      const slowAfter = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://slow/ws'));
      expect(slowAfter?.reachability).toBe('reachable');
      expect(slowAfter?.latencyMs).toBe(900);
    });

    it('keeps the last result while a new round is pending', async () => {
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      await settle('http://a/probe', true, 7);
      scheduler.refresh('agent-a', 'manual');
      await fireDebounce();
      const pending = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://a/ws'));
      expect(pending?.probing).toBe(true);
      expect(pending?.reachability).toBe('reachable'); // last result retained
      expect(pending?.latencyMs).toBe(7);
    });

    it('bounds per-target and global in-flight probes', async () => {
      const many = Array.from({ length: 12 }, (_, i) => `ws://h${i}/ws`);
      scheduler.registerTarget(httpTarget('agent-a', many));
      await fireDebounce();
      // Per-target cap 4: only 4 of the 12 addresses are in flight.
      expect(control.httpCalls).toHaveLength(4);
      await settle('http://h0/probe', true);
      expect(control.httpCalls).toHaveLength(5); // one slot freed → next queued
    });

    it('fences a stale inventory result so it cannot overwrite newer membership', async () => {
      // The legacy WS path has no abort signal, so a superseded measurement can
      // genuinely arrive late — the generation fence must discard it.
      scheduler.registerTarget({
        targetId: 'agent-a',
        kind: 'agent',
        addresses: [{ addressId: 'ws://old/ws', wsUrl: 'ws://old/ws', probeUrl: null }],
      });
      await fireDebounce();
      expect(control.legacyCalls).toEqual(['ws://old/ws']);
      // Membership changes while the old legacy probe is still in flight.
      scheduler.registerTarget({
        targetId: 'agent-a',
        kind: 'agent',
        addresses: [{ addressId: 'ws://new/ws', wsUrl: 'ws://new/ws', probeUrl: null }],
      });
      await fireDebounce();
      // The old probe finally answers — it must not publish or resurrect.
      await settle('ws://old/ws', true, 1);
      expect(scheduler.getSnapshot().states.has(probeStateKey('agent-a', 'ws://old/ws'))).toBe(false);
      await settle('ws://new/ws', true, 2);
      const newState = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://new/ws'));
      expect(newState?.reachability).toBe('reachable');
      expect(newState?.latencyMs).toBe(2);
    });

    it('fences a stale network-epoch result', async () => {
      scheduler.registerTarget(httpTarget('agent-a', ['ws://a/ws']));
      await fireDebounce();
      scheduler.handleNetworkChange(); // advances epoch, fences the in-flight round
      await fireDebounce(); // aborts the old round, starts the new one
      // The aborted old round must not have published a verdict.
      const mid = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://a/ws'));
      expect(mid?.reachability).toBe('unknown');
      await settle('http://a/probe', true, 3);
      const state = scheduler.getSnapshot().states.get(probeStateKey('agent-a', 'ws://a/ws'));
      expect(state?.reachability).toBe('reachable');
      expect(state?.latencyMs).toBe(3);
    });

    it('uses the bounded legacy WS path for a peer with no probe_url', async () => {
      scheduler.registerTarget({
        targetId: 'legacy',
        kind: 'agent',
        addresses: [{ addressId: 'ws://legacy/ws', wsUrl: 'ws://legacy/ws', probeUrl: null }],
      });
      await fireDebounce();
      expect(control.legacyCalls).toEqual(['ws://legacy/ws']);
      expect(control.httpCalls).toHaveLength(0);
    });
  });
});
