// React-free per-address reachability probe scheduler (#4618).
//
// Owns scheduling, cancellation, candidate measurement, cache and publication.
// UI hooks subscribe/trigger; they never own a background task. The scheduler
// observes reachability and publishes it incrementally — each address settles
// on its own, never behind a Promise.all barrier. It does not decide routes,
// clear a WS failure budget, or attach a Session: those authorities consume the
// published facts.
//
// Fences: inventoryGeneration (membership), probeGeneration (refresh round) and
// networkEpoch (meaningful network invalidation) retire obsolete results. A
// stale request finally can never overwrite a newer task's state.

import { measureLatency } from '@/shared/lib/addressSelection';
import { measureHttpProbe } from './httpProbe';
import {
  PROBE_DEBOUNCE_MS,
  PROBE_HTTP_DEADLINE_MS,
  PROBE_MAX_GLOBAL_IN_FLIGHT,
  PROBE_MAX_PER_TARGET_IN_FLIGHT,
  probeStateKey,
  type AddressProbeState,
  type ProbeCandidate,
  type ProbeDiagnostic,
  type ProbeSnapshot,
  type ProbeTarget,
  type ProbeTrigger,
} from './types';

type Timer = ReturnType<typeof setTimeout>;

interface ProbeTask {
  addressId: string;
  probeGeneration: number;
  inventoryGeneration: number;
  networkEpoch: number;
  trigger: ProbeTrigger;
}

interface Flight {
  addressId: string;
  probeGeneration: number;
  controller: AbortController;
}

interface TargetEntry {
  kind: 'server' | 'agent';
  addresses: ProbeCandidate[];
  inventoryGeneration: number;
  probeGeneration: number;
  debounceTimer: Timer | null;
  pendingTrigger: ProbeTrigger | null;
  queue: ProbeTask[];
  flights: Map<string, Flight>;
}

export interface ProbeSchedulerOptions {
  /** Periodic maintenance interval; 0 disables the timer (events stay armed). */
  intervalMs?: number;
  onDiagnostic?: (diagnostic: ProbeDiagnostic) => void;
}

const EMPTY_SNAPSHOT: ProbeSnapshot = { version: 0, states: new Map() };

export class ProbeScheduler {
  private readonly targets = new Map<string, TargetEntry>();
  private readonly refCounts = new Map<string, number>();
  private snapshot: ProbeSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private networkEpoch = 0;
  private globalInFlight = 0;
  private queueHighWater = 0;
  private periodicTimer: Timer | null = null;
  private intervalMs: number;
  private visible = true;
  private offline = false;
  private disposed = false;
  private started = false;
  private readonly onDiagnostic?: (diagnostic: ProbeDiagnostic) => void;
  private detachLifecycle: (() => void) | null = null;

  constructor(options: ProbeSchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 0;
    this.onDiagnostic = options.onDiagnostic;
  }

  // ── Subscription (React bridge) ──────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProbeSnapshot => this.snapshot;

  /** Current states for one target, in inventory order. */
  targetStates(targetId: string): AddressProbeState[] {
    const entry = this.targets.get(targetId);
    if (!entry) {
      return [];
    }
    return entry.addresses
      .map((a) => this.snapshot.states.get(probeStateKey(targetId, a.addressId)))
      .filter((s): s is AddressProbeState => s !== undefined);
  }

  // ── Target membership ────────────────────────────────────────────────────

  registerTarget(target: ProbeTarget): void {
    if (this.disposed) {
      return;
    }
    const existing = this.targets.get(target.targetId);
    if (existing) {
      const changed = membershipChanged(existing.addresses, target.addresses);
      existing.kind = target.kind;
      existing.addresses = target.addresses;
      if (changed) {
        existing.inventoryGeneration += 1;
        this.retireRemovedStates(target.targetId, existing);
        this.syncSurvivingGenerations(target.targetId, existing);
        this.refresh(target.targetId, 'inventory');
      }
    } else {
      const entry: TargetEntry = {
        kind: target.kind,
        addresses: target.addresses,
        inventoryGeneration: 1,
        probeGeneration: 0,
        debounceTimer: null,
        pendingTrigger: null,
        queue: [],
        flights: new Map(),
      };
      this.targets.set(target.targetId, entry);
      this.seedStates(target.targetId, entry);
      this.refresh(target.targetId, 'mount');
    }
    this.ensurePeriodic();
  }

  unregisterTarget(targetId: string): void {
    const entry = this.targets.get(targetId);
    if (!entry) {
      return;
    }
    this.cancelTargetWork(entry);
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    this.targets.delete(targetId);
    this.removeTargetStates(targetId);
    this.ensurePeriodic();
    this.publish();
  }

  /**
   * Ref-counted membership for shared targets. Several subscribers (an attach
   * dialog preview and the attached Session, or two Sessions on one Agent)
   * acquire the same logical target; the target is retired only when the last
   * subscriber releases it. Single-flight and coalescing span all of them.
   */
  acquireTarget(target: ProbeTarget): void {
    this.refCounts.set(target.targetId, (this.refCounts.get(target.targetId) ?? 0) + 1);
    this.registerTarget(target);
  }

  releaseTarget(targetId: string): void {
    const count = (this.refCounts.get(targetId) ?? 0) - 1;
    if (count > 0) {
      this.refCounts.set(targetId, count);
      return;
    }
    this.refCounts.delete(targetId);
    this.unregisterTarget(targetId);
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  /** Request a refresh; repeated signals coalesce into one effective round. */
  refresh(targetId: string | null, trigger: ProbeTrigger): void {
    if (this.disposed) {
      return;
    }
    const ids = targetId === null ? [...this.targets.keys()] : [targetId];
    for (const id of ids) {
      const entry = this.targets.get(id);
      if (!entry) {
        continue;
      }
      // Coalesce without endless postponement: the first signal arms the
      // window; later signals update the label but keep the original deadline,
      // so a storm of errors cannot starve the refresh.
      entry.pendingTrigger = trigger;
      if (entry.debounceTimer === null) {
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          const fired = entry.pendingTrigger ?? trigger;
          entry.pendingTrigger = null;
          this.doRefresh(id, fired);
        }, PROBE_DEBOUNCE_MS);
      }
    }
  }

  /** A real transport loss wakes recovery probing for the target. */
  noteTransportLoss(targetId: string): void {
    this.refresh(targetId, 'transport-loss');
  }

  /** A bounded retry failure wakes reassessment (does not reset any budget). */
  noteRetryFailure(targetId: string): void {
    this.refresh(targetId, 'retry-failure');
  }

  // ── Network lifecycle ────────────────────────────────────────────────────

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.refresh(null, 'foreground');
      this.ensurePeriodic();
    } else {
      this.clearPeriodic();
    }
  }

  handleOnline(): void {
    if (this.disposed) {
      return;
    }
    const wasOffline = this.offline;
    this.offline = false;
    if (wasOffline) {
      // Meaningful invalidation: the network observation changed.
      this.networkEpoch += 1;
    }
    this.refresh(null, 'online');
    this.ensurePeriodic();
  }

  handleOffline(): void {
    if (this.disposed) {
      return;
    }
    this.offline = true;
    this.clearPeriodic();
  }

  handleNetworkChange(): void {
    if (this.disposed || this.offline) {
      return;
    }
    this.networkEpoch += 1;
    this.refresh(null, 'network-change');
  }

  handlePageShow(): void {
    this.refresh(null, 'pageshow');
  }

  /** Reconfigure the periodic interval (0 disables). Event triggers unaffected. */
  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
    this.ensurePeriodic();
  }

  /** Attach browser lifecycle listeners. Idempotent; no-op without a DOM. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }
    const onVisibility = () => this.setVisible(document.visibilityState === 'visible');
    const onPageShow = () => this.handlePageShow();
    const onOnline = () => this.handleOnline();
    const onOffline = () => this.handleOffline();
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    const onConnectionChange = () => this.handleNetworkChange();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    connection?.addEventListener('change', onConnectionChange);
    this.visible = document.visibilityState === 'visible';
    this.offline = typeof navigator.onLine === 'boolean' ? !navigator.onLine : false;
    this.detachLifecycle = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      connection?.removeEventListener('change', onConnectionChange);
    };
    this.ensurePeriodic();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearPeriodic();
    this.detachLifecycle?.();
    this.detachLifecycle = null;
    for (const entry of this.targets.values()) {
      this.cancelTargetWork(entry);
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
    }
    this.targets.clear();
    this.refCounts.clear();
    this.snapshot = EMPTY_SNAPSHOT;
    this.listeners.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private doRefresh(targetId: string, trigger: ProbeTrigger): void {
    const entry = this.targets.get(targetId);
    if (!entry || this.disposed) {
      return;
    }
    entry.probeGeneration += 1;
    const generation = entry.probeGeneration;
    // Cancel flights from a superseded round; the newest round wins.
    for (const flight of entry.flights.values()) {
      if (flight.probeGeneration !== generation) {
        flight.controller.abort();
      }
    }
    for (const address of entry.addresses) {
      const live = entry.flights.get(address.addressId);
      if (live && live.probeGeneration === generation) {
        continue; // one effective flight per address
      }
      entry.queue.push({
        addressId: address.addressId,
        probeGeneration: generation,
        inventoryGeneration: entry.inventoryGeneration,
        networkEpoch: this.networkEpoch,
        trigger,
      });
    }
    this.diagnose({
      event: 'refresh',
      targetKind: entry.kind,
      trigger,
      probeGeneration: generation,
      inventoryGeneration: entry.inventoryGeneration,
      networkEpoch: this.networkEpoch,
    });
    this.pump(targetId);
  }

  private pump(targetId: string): void {
    const entry = this.targets.get(targetId);
    if (!entry || this.disposed) {
      return;
    }
    while (
      entry.queue.length > 0
      && this.globalInFlight < PROBE_MAX_GLOBAL_IN_FLIGHT
      && entry.flights.size < PROBE_MAX_PER_TARGET_IN_FLIGHT
    ) {
      const task = entry.queue.shift();
      if (!task) {
        break;
      }
      // A queued task whose round was superseded while waiting is dropped.
      if (task.probeGeneration !== entry.probeGeneration) {
        continue;
      }
      this.startFlight(targetId, entry, task);
    }
    this.queueHighWater = Math.max(this.queueHighWater, this.globalInFlight);
  }

  private startFlight(targetId: string, entry: TargetEntry, task: ProbeTask): void {
    const candidate = entry.addresses.find((a) => a.addressId === task.addressId);
    if (!candidate) {
      return;
    }
    const controller = new AbortController();
    const flight: Flight = {
      addressId: task.addressId,
      probeGeneration: task.probeGeneration,
      controller,
    };
    entry.flights.set(task.addressId, flight);
    this.globalInFlight += 1;

    // Mark probing but KEEP the last settled result while the new round runs.
    this.mutateState(targetId, task.addressId, (prev) => ({
      ...(prev ?? this.unknownState(targetId, entry, candidate)),
      probing: true,
      probeGeneration: task.probeGeneration,
      inventoryGeneration: task.inventoryGeneration,
      networkEpoch: task.networkEpoch,
    }));

    const method = candidate.probeUrl ? 'http' : 'legacy-ws';
    const measurement = candidate.probeUrl
      ? measureHttpProbe(candidate.probeUrl, {
        deadlineMs: PROBE_HTTP_DEADLINE_MS,
        signal: controller.signal,
      })
      : measureLatency(candidate.wsUrl, { timeoutMs: PROBE_HTTP_DEADLINE_MS }).then((r) => ({
        reachability: r.latencyMs !== null ? 'reachable' as const : 'unreachable' as const,
        latencyMs: r.latencyMs,
        failureReason: r.latencyMs === null ? 'blocked-or-network' as const : undefined,
      }));

    void measurement.then((result) => {
      this.settleFlight(targetId, task, flight, { method, result });
    });
  }

  private settleFlight(
    targetId: string,
    task: ProbeTask,
    flight: Flight,
    outcome: {
      method: 'http' | 'legacy-ws';
      result: { reachability: 'reachable' | 'unreachable'; latencyMs: number | null; failureReason?: AddressProbeState['failureReason'] };
    },
  ): void {
    const { method, result } = outcome;
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const entry = this.targets.get(targetId);
    if (entry) {
      const live = entry.flights.get(task.addressId);
      if (live === flight) {
        entry.flights.delete(task.addressId);
      }
    }

    const stale = this.disposed
      || !entry
      || entry.probeGeneration !== task.probeGeneration
      || entry.inventoryGeneration !== task.inventoryGeneration
      || this.networkEpoch !== task.networkEpoch
      || !entry.addresses.some((a) => a.addressId === task.addressId);

    if (stale) {
      this.diagnose({
        event: 'probe-cancelled',
        targetKind: entry?.kind ?? 'agent',
        method,
        probeGeneration: task.probeGeneration,
        inventoryGeneration: task.inventoryGeneration,
        networkEpoch: task.networkEpoch,
      });
      if (entry) {
        this.pump(targetId);
      }
      return;
    }

    const now = Date.now();
    const key = probeStateKey(targetId, task.addressId);
    const previous = this.snapshot.states.get(key);
    const changed = previous?.reachability !== result.reachability;
    this.mutateState(targetId, task.addressId, (prev) => ({
      ...(prev ?? this.unknownState(targetId, entry, entry.addresses.find((a) => a.addressId === task.addressId)!)),
      probing: false,
      reachability: result.reachability,
      latencyMs: result.latencyMs,
      measuredAt: now,
      lastReachableAt: result.reachability === 'reachable'
        ? now
        : (prev?.lastReachableAt ?? null),
      method,
      failureReason: result.reachability === 'reachable' ? undefined : result.failureReason,
      probeGeneration: task.probeGeneration,
      inventoryGeneration: task.inventoryGeneration,
      networkEpoch: task.networkEpoch,
    }));

    this.diagnose({
      event: 'probe-settled',
      targetKind: entry.kind,
      method,
      result: result.reachability,
      failureReason: result.failureReason,
      durationMs: result.latencyMs ?? undefined,
      probeGeneration: task.probeGeneration,
      inventoryGeneration: task.inventoryGeneration,
      networkEpoch: task.networkEpoch,
      queueHighWater: this.queueHighWater,
    });
    if (changed) {
      this.diagnose({
        event: 'reachability-change',
        targetKind: entry.kind,
        result: result.reachability,
        probeGeneration: task.probeGeneration,
        networkEpoch: task.networkEpoch,
      });
    }

    if (entry.flights.size === 0 && entry.queue.length === 0) {
      this.diagnose({
        event: 'round-complete',
        targetKind: entry.kind,
        probeGeneration: task.probeGeneration,
        queueHighWater: this.queueHighWater,
      });
      this.queueHighWater = 0;
    }
    this.pump(targetId);
  }

  // ── State helpers ────────────────────────────────────────────────────────

  private unknownState(
    targetId: string,
    entry: TargetEntry,
    candidate: ProbeCandidate,
  ): AddressProbeState {
    return {
      targetId,
      addressId: candidate.addressId,
      wsUrl: candidate.wsUrl,
      probeUrl: candidate.probeUrl ?? null,
      inventoryGeneration: entry.inventoryGeneration,
      networkEpoch: this.networkEpoch,
      probeGeneration: entry.probeGeneration,
      probing: false,
      reachability: 'unknown',
      latencyMs: null,
      measuredAt: null,
      lastReachableAt: null,
      method: candidate.probeUrl ? 'http' : 'legacy-ws',
    };
  }

  private seedStates(targetId: string, entry: TargetEntry): void {
    const next = new Map(this.snapshot.states);
    for (const candidate of entry.addresses) {
      const key = probeStateKey(targetId, candidate.addressId);
      if (!next.has(key)) {
        next.set(key, this.unknownState(targetId, entry, candidate));
      }
    }
    this.snapshot = { version: this.snapshot.version + 1, states: next };
  }

  private mutateState(
    targetId: string,
    addressId: string,
    update: (prev: AddressProbeState | undefined) => AddressProbeState,
  ): void {
    const key = probeStateKey(targetId, addressId);
    const next = new Map(this.snapshot.states);
    next.set(key, update(next.get(key)));
    this.snapshot = { version: this.snapshot.version + 1, states: next };
    this.notify();
  }

  private retireRemovedStates(targetId: string, entry: TargetEntry): void {
    const keep = new Set(entry.addresses.map((a) => probeStateKey(targetId, a.addressId)));
    const next = new Map(this.snapshot.states);
    for (const key of [...next.keys()]) {
      if (key.startsWith(`${targetId}::`) && !keep.has(key)) {
        next.delete(key);
      }
    }
    this.snapshot = { version: this.snapshot.version + 1, states: next };
  }

  private syncSurvivingGenerations(targetId: string, entry: TargetEntry): void {
    const next = new Map(this.snapshot.states);
    for (const candidate of entry.addresses) {
      const key = probeStateKey(targetId, candidate.addressId);
      const prev = next.get(key);
      if (prev) {
        next.set(key, { ...prev, inventoryGeneration: entry.inventoryGeneration, probeUrl: candidate.probeUrl ?? null });
      } else {
        next.set(key, this.unknownState(targetId, entry, candidate));
      }
    }
    this.snapshot = { version: this.snapshot.version + 1, states: next };
  }

  private removeTargetStates(targetId: string): void {
    const next = new Map(this.snapshot.states);
    for (const key of [...next.keys()]) {
      if (key.startsWith(`${targetId}::`)) {
        next.delete(key);
      }
    }
    this.snapshot = { version: this.snapshot.version + 1, states: next };
  }

  private cancelTargetWork(entry: TargetEntry): void {
    for (const flight of entry.flights.values()) {
      flight.controller.abort();
    }
    entry.queue.length = 0;
  }

  private publish(): void {
    this.snapshot = { version: this.snapshot.version + 1, states: new Map(this.snapshot.states) };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private ensurePeriodic(): void {
    this.clearPeriodic();
    if (
      this.disposed
      || this.intervalMs <= 0
      || !this.visible
      || this.offline
      || this.targets.size === 0
    ) {
      return;
    }
    this.periodicTimer = setInterval(() => {
      this.refresh(null, 'periodic');
    }, this.intervalMs);
  }

  private clearPeriodic(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private diagnose(diagnostic: ProbeDiagnostic): void {
    const callback = this.onDiagnostic;
    if (!callback) {
      return;
    }
    try {
      callback(diagnostic);
    } catch {
      // Diagnostics are best-effort and stay out of the recovery path.
    }
  }
}

/** Whether two candidate lists differ in membership or probe endpoint. Order
 *  alone is not a membership change (the advertisement priority sort is stable
 *  but a re-render may reorder); identity + probeUrl is what the probe reads. */
function membershipChanged(a: ProbeCandidate[], b: ProbeCandidate[]): boolean {
  if (a.length !== b.length) {
    return true;
  }
  const key = (c: ProbeCandidate) => `${c.addressId}::${c.probeUrl ?? ''}`;
  const set = new Set(a.map(key));
  return b.some((c) => !set.has(key(c)));
}

/** Redacted by construction: bounded enums and generation counters only — no
 *  URL, IP, token or raw Session/Agent ID (#4618, #4437 policy). */
function logProbeDiagnostic(diagnostic: ProbeDiagnostic): void {
  console.info('[probe]', diagnostic);
}

/** The shared browser-session probe service. Tests construct isolated instances. */
export const probeScheduler = new ProbeScheduler({ onDiagnostic: logProbeDiagnostic });
