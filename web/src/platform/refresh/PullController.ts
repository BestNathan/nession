import { RefreshScheduler, type RefreshRegistration } from './RefreshScheduler';
import {
  DEFAULT_COALESCE_MS,
  DEFAULT_TIMEOUT_MS,
  INITIAL_PULL_STATUS,
  backoffDelay,
  isStrongReason,
  jittered,
  systemClock,
  type PullContext,
  type PullOutcome,
  type PullRefreshPolicy,
  type PullStatus,
  type RefreshClock,
  type RefreshReason,
} from './types';

type Waiter = (outcome: PullOutcome) => void;

/** Automatic reads that a minimum interval may dedupe. */
const CADENCE_REASONS: readonly RefreshReason[] = ['interval', 'foreground', 'reconnect', 'activate'];

interface Intent {
  reason: RefreshReason;
  force: boolean;
  strong: boolean;
  waiters: Waiter[];
}

interface InFlight {
  seq: number;
  generation: number;
  reason: RefreshReason;
  force: boolean;
  externalRevisionAtStart: number;
  invalidationSeqAtStart: number;
  abort: AbortController;
  timeout: number | null;
  waiters: Waiter[];
  settled: boolean;
  supersededExternally: boolean;
}

/** Low-cardinality lifecycle sample. `label` is a surface name, never a
 *  session id, path or query value (#4602 SC-07). */
export interface RefreshTelemetryEvent {
  label: string;
  reason: RefreshReason;
  kind: 'pull' | 'coalesced' | 'applied' | 'partial' | 'failed' | 'superseded' | 'cancelled' | 'dropped';
  /** Ms from request to settlement, when a read actually ran. */
  latencyMs?: number;
  at: number;
}

export interface PullControllerOptions<T> {
  scheduler: RefreshScheduler;
  pull: (ctx: PullContext) => Promise<T>;
  /** Synchronous guarded publication. Never called for a fenced answer. */
  apply: (snapshot: T) => void;
  policy: PullRefreshPolicy;
  clock?: RefreshClock;
  /** An authoritative but incomplete answer (partial Agent coverage). */
  isPartial?: (snapshot: T) => boolean;
  /**
   * A read was fenced out by a newer push. The answer is still information:
   * an owner with a domain-specific version check may inspect it and call
   * `invalidate()` to owe one trailing read. The controller never publishes it.
   */
  onSuperseded?: (snapshot: T) => void;
  onStatus?: (status: PullStatus) => void;
  onTelemetry?: (event: RefreshTelemetryEvent) => void;
  /** Stable surface name for telemetry aggregation. */
  label?: string;
  random?: () => number;
}

function contextKeyOf(context: readonly unknown[]): string {
  return JSON.stringify(context.map((part) => {
    if (part === null || part === undefined) { return String(part); }
    if (typeof part === 'object') { return JSON.stringify(part); }
    return String(part);
  }));
}

/**
 * One owner's pull lifecycle for one query context (#4602 §1/§3).
 *
 * React-free on purpose: the state machine, fences and budgets are provable
 * with a fake clock and deferred promises, without a renderer in the way.
 *
 * The invariant that matters: **pull and apply are separate**. A read is only
 * published while its generation, request sequence and external revision still
 * agree with the moment it started. A late reply from a retired context, a
 * superseded request or a socket that cannot abort therefore cannot move data
 * backwards, and no `apply` ever runs outside that guard.
 *
 * At most one read is in flight per context and at most one further intent is
 * held. Everything else merges into those two, which is what bounds a burst of
 * invalidations to one current read plus one trailing read.
 */
export class PullController<T> implements RefreshRegistration {
  readonly owner = this;

  private readonly scheduler: RefreshScheduler;
  private readonly clock: RefreshClock;
  private readonly pullFn: (ctx: PullContext) => Promise<T>;
  private readonly applyFn: (snapshot: T) => void;
  private readonly isPartialFn?: (snapshot: T) => boolean;
  private readonly onSuperseded?: (snapshot: T) => void;
  private readonly onStatus?: (status: PullStatus) => void;
  private readonly onTelemetry?: (event: RefreshTelemetryEvent) => void;
  private readonly random: () => number;
  private readonly label: string;
  private policy: PullRefreshPolicy;

  private contextKey = '';
  private generation = 0;
  private requestSeq = 0;
  private externalRevision = 0;
  private invalidationSeq = 0;

  private active = false;
  private enabled = false;
  private disposed = false;
  private dirty = false;
  private hasData = false;
  private retryAttempt = 0;
  private lastReadAt: number | null = null;

  private inFlight: InFlight | null = null;
  private pending: Intent | null = null;
  private coalesceTimer: number | null = null;
  private retryTimer: number | null = null;
  private needsInitialRead = false;

  private statusValue: PullStatus = { ...INITIAL_PULL_STATUS };

  constructor(options: PullControllerOptions<T>) {
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
    this.pullFn = options.pull;
    this.applyFn = options.apply;
    this.policy = options.policy;
    this.isPartialFn = options.isPartial;
    this.onSuperseded = options.onSuperseded;
    this.onStatus = options.onStatus;
    this.onTelemetry = options.onTelemetry;
    this.random = options.random ?? Math.random;
    this.label = options.label ?? 'unknown';
    this.scheduler.register(this);
  }

  get target(): string | undefined {
    return this.policy.target;
  }

  get status(): PullStatus {
    return this.statusValue;
  }

  get isRefreshing(): boolean {
    return this.inFlight !== null || this.pending !== null;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Replace the policy without retiring the context (interval tuning). */
  setPolicy(policy: PullRefreshPolicy): void {
    this.policy = policy;
    if (this.inFlight === null && this.pending === null) { this.armInterval(); }
  }

  /**
   * Declare the owner-local identity this controller reads for. A change
   * retires the old context **immediately** — not after the next paint — so a
   * reply for the previous target can never publish into the new one. A→B→A
   * advances the generation each time and never reuses one.
   */
  setContext(context: readonly unknown[]): void {
    const key = contextKeyOf(context);
    if (key === this.contextKey && this.generation > 0) { return; }
    const first = this.generation === 0;
    this.contextKey = key;
    this.generation += 1;
    if (!first) { this.retireContext(); }
    this.needsInitialRead = true;
    this.maybeInitialRead();
  }

  setActive(active: boolean): void {
    if (this.active === active) { return; }
    this.active = active;
    if (!active) {
      this.scheduler.disarm(this);
      this.clearCoalesceTimer();
      this.dropQueuedAutomatic('cancelled');
      this.emitStatus();
      return;
    }
    if (this.maybeInitialRead()) { return; }
    if (this.policy.onActivate || this.dirty) {
      void this.enqueue({ reason: 'activate', force: false, strong: false });
    }
  }

  /** Owner opt-in folded with transport readiness by the adapter. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) { return; }
    this.enabled = enabled;
    if (!enabled) {
      this.scheduler.disarm(this);
      this.clearCoalesceTimer();
      this.clearRetryTimer();
      this.cancelInFlight('cancelled');
      this.cancelPending('cancelled');
      if (this.hasData) { this.patchStatus({ stale: true }); }
      return;
    }
    if (this.maybeInitialRead()) { return; }
    this.emitStatus();
  }

  /** Explicit read of the current scope. The returned promise settles only when
   *  the read that carries this request settles — a manual force queued behind
   *  a normal read waits for the force answer, not the normal one. */
  refresh(reason: RefreshReason): Promise<PullOutcome> {
    if (this.disposed || !this.enabled) {
      if (!this.disposed && !isStrongReason(reason)) { this.dirty = true; }
      return Promise.resolve('cancelled');
    }
    const strong = isStrongReason(reason);
    if (!this.active && !strong) {
      // A hidden view stays dirty until it is actually shown again.
      this.dirty = true;
      return Promise.resolve('cancelled');
    }
    // The floor dedupes *automatic* resume/cadence signals only. A mutation or
    // invalidation carries new information the user is waiting on, and a
    // manual ask explicitly skips it (#4602 §2).
    if (CADENCE_REASONS.includes(reason) && !this.respectsMinInterval()) {
      this.record('coalesced', reason);
      return Promise.resolve('superseded');
    }

    const invalidating = reason === 'invalidate' || reason === 'mutation';
    if (invalidating) {
      this.invalidationSeq += 1;
      this.dirty = true;
    }

    if (this.inFlight) {
      const current = this.inFlight;
      if (invalidating) {
        // New information landed after this request started: the answer cannot
        // clear the newer dirty flag, and one trailing read is owed.
        return this.enqueue({ reason, force: false, strong: false });
      }
      if (strong && !current.force) {
        // A normal read must not swallow an explicit force ask.
        return this.enqueue({ reason, force: true, strong: true });
      }
      // Same-strength manual shares the in-flight proof; weaker automatic
      // reasons are satisfied by the read already running.
      this.record('coalesced', reason);
      return new Promise<PullOutcome>((resolve) => { current.waiters.push(resolve); });
    }

    if (invalidating && this.coalesceTimer !== null) {
      // Already waiting out a burst; the deadline is not extended.
      this.record('coalesced', reason);
      return this.enqueue({ reason, force: false, strong: false });
    }

    return this.enqueue({ reason, force: strong, strong });
  }

  /** Mark the scope behind the authority without naming a snapshot. Existing
   *  notifications only — this never invents a new push. */
  invalidate(reason: RefreshReason = 'invalidate'): void {
    this.invalidationSeq += 1;
    this.dirty = true;
    if (this.disposed || !this.enabled || !this.active) { return; }
    if (this.inFlight || this.pending) {
      this.record('coalesced', reason);
      return;
    }
    if (this.coalesceTimer !== null) {
      // Continuous events must not starve the read: the first event's deadline
      // stands, later ones only merge.
      this.record('coalesced', reason);
      return;
    }
    const delay = this.policy.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.coalesceTimer = this.clock.setTimeout(() => {
      this.coalesceTimer = null;
      if (this.dirty && this.active && this.enabled && !this.inFlight && !this.pending) {
        void this.enqueue({ reason: 'invalidate', force: false, strong: false });
      }
    }, delay);
  }

  /**
   * A complete current-context snapshot from the existing push channel. It is
   * authoritative, so it publishes under the same fence and marks any older
   * outstanding read superseded. It does not provoke a redundant pull.
   */
  acceptExternal(snapshot: T): void {
    if (this.disposed) { return; }
    this.externalRevision += 1;
    if (this.inFlight) { this.inFlight.supersededExternally = true; }
    this.publish(snapshot);
    this.dirty = false;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.dropQueuedAutomatic('superseded');
    if (!this.inFlight && !this.pending) { this.armInterval(); }
  }

  /** Stop everything this controller owns and settle every waiter. */
  retire(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    // Withdraw the queued intent first: freeing the in-flight slot dispatches
    // the queue, and a disposed controller must not be handed a slot.
    this.cancelPending('cancelled');
    this.cancelInFlight('cancelled');
    this.clearCoalesceTimer();
    this.clearRetryTimer();
    this.scheduler.unregister(this);
  }

  // ── scheduler seam ────────────────────────────────────────────────────────

  start(): void {
    const intent = this.pending;
    this.pending = null;
    if (!intent) { this.scheduler.release(this); return; }
    // A granted slot is still not permission to read: the context may have
    // retired while queued. Every waiter gets an answer either way.
    if (this.disposed || !this.enabled || (!this.active && !intent.strong)) {
      this.scheduler.release(this);
      this.settleWaiters(intent.waiters, 'cancelled');
      this.emitStatus();
      return;
    }
    this.beginPull(intent);
  }

  due(): void {
    if (this.disposed || !this.enabled || !this.active) { return; }
    if (this.inFlight || this.pending) { this.armInterval(); return; }
    void this.enqueue({ reason: 'interval', force: false, strong: false });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private respectsMinInterval(): boolean {
    const min = this.policy.minIntervalMs;
    if (min === undefined || this.lastReadAt === null) { return true; }
    return this.clock.now() - this.lastReadAt >= min;
  }

  /** The first read of a freshly declared context is a `mount`, whichever of
   *  active/enabled arrived last — not an `activate` of a scope never read. */
  private maybeInitialRead(): boolean {
    if (!this.needsInitialRead || !this.active || !this.enabled || this.disposed) { return false; }
    this.needsInitialRead = false;
    void this.enqueue({ reason: 'mount', force: false, strong: false });
    return true;
  }

  private enqueue(intent: Omit<Intent, 'waiters'>): Promise<PullOutcome> {
    let resolve!: (outcome: PullOutcome) => void;
    const promise = new Promise<PullOutcome>((r) => { resolve = r; });
    if (this.pending) {
      // One bounded pending intent: merge reasons, keep the stronger trigger.
      const kept = this.pending;
      if (intent.strong && !kept.strong) { kept.strong = true; }
      if (intent.force) { kept.force = true; }
      if (isStrongReason(intent.reason) || kept.reason === 'interval') { kept.reason = intent.reason; }
      kept.waiters.push(resolve);
      this.record('coalesced', intent.reason);
    } else {
      this.pending = { ...intent, waiters: [resolve] };
    }
    this.scheduler.enqueue(this, this.pending.strong ? 'manual' : 'auto');
    this.emitStatus();
    return promise;
  }

  private beginPull(intent: Intent): void {
    this.requestSeq += 1;
    this.scheduler.disarm(this);
    this.clearCoalesceTimer();
    const abort = new AbortController();
    const flight: InFlight = {
      seq: this.requestSeq,
      generation: this.generation,
      reason: intent.reason,
      force: intent.force,
      externalRevisionAtStart: this.externalRevision,
      invalidationSeqAtStart: this.invalidationSeq,
      abort,
      timeout: null,
      waiters: intent.waiters,
      settled: false,
      supersededExternally: false,
    };
    this.inFlight = flight;
    this.lastReadAt = this.clock.now();
    const startedAt = this.clock.now();
    this.record('pull', intent.reason);
    this.patchStatus({ refreshing: true, loading: !this.hasData });

    flight.timeout = this.clock.setTimeout(() => {
      this.finish(flight, 'failed', startedAt, 'Refresh timed out');
    }, this.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let promise: Promise<T>;
    try {
      promise = this.pullFn({ reason: intent.reason, signal: abort.signal, force: intent.force });
    } catch (error) {
      this.finish(flight, 'failed', startedAt, messageOf(error));
      return;
    }
    promise.then(
      (snapshot) => {
        if (flight.settled) { return; }
        if (flight.generation !== this.generation) {
          this.finish(flight, 'cancelled', startedAt);
          return;
        }
        if (flight.supersededExternally
          || this.externalRevision !== flight.externalRevisionAtStart) {
          this.onSuperseded?.(snapshot);
          this.finish(flight, 'superseded', startedAt);
          return;
        }
        this.publish(snapshot);
        const partial = this.isPartialFn?.(snapshot) ?? false;
        if (this.invalidationSeq === flight.invalidationSeqAtStart) { this.dirty = false; }
        this.retryAttempt = 0;
        this.clearRetryTimer();
        this.finish(flight, partial ? 'partial' : 'applied', startedAt);
      },
      (error: unknown) => {
        if (flight.settled) { return; }
        const outcome: PullOutcome = abort.signal.aborted ? 'cancelled' : 'failed';
        this.finish(flight, outcome, startedAt, outcome === 'failed' ? messageOf(error) : undefined);
      },
    );
  }

  /** The only place a snapshot reaches the owner, always inside the fence. */
  private publish(snapshot: T): void {
    this.applyFn(snapshot);
    this.hasData = true;
    this.patchStatus({
      stale: false,
      error: null,
      lastSuccessAt: this.clock.now(),
      loading: false,
    });
  }

  private finish(flight: InFlight, outcome: PullOutcome, startedAt: number, error?: string): void {
    if (flight.settled || this.inFlight !== flight) { return; }
    flight.settled = true;
    if (flight.timeout !== null) { this.clock.clearTimeout(flight.timeout); flight.timeout = null; }
    this.inFlight = null;

    if (outcome === 'failed') {
      this.patchStatus({ stale: this.hasData, error: error ?? 'Refresh failed' });
      this.scheduleRetry();
    } else if (outcome === 'superseded' || outcome === 'cancelled') {
      this.patchStatus({ error: null });
    }
    this.record(outcome, flight.reason, this.clock.now() - startedAt);

    const waiters = flight.waiters;
    // A trailing read is owed when newer information arrived during this one.
    // The obligation is consumed by queueing it, not by its success: otherwise
    // a read that keeps failing would re-queue itself forever. A failure is
    // recorded as stale and retried on backoff instead.
    if (!this.pending && this.dirty && this.active && this.enabled && !this.disposed) {
      this.dirty = false;
      void this.enqueue({ reason: 'invalidate', force: false, strong: false });
    }
    if (!this.pending && !this.dirty) { this.armInterval(); }
    this.patchStatus({ refreshing: this.pending !== null, loading: false });
    this.scheduler.release(this);
    this.settleWaiters(waiters, outcome);
  }

  private scheduleRetry(): void {
    if (this.policy.autoRetry === false || this.disposed) { return; }
    if (!this.active || !this.enabled) { return; }
    this.clearRetryTimer();
    const delay = backoffDelay(this.retryAttempt, this.random);
    this.retryAttempt += 1;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.active && this.enabled && !this.inFlight && !this.pending) {
        void this.enqueue({ reason: 'retry', force: false, strong: false });
      }
    }, delay);
  }

  private armInterval(): void {
    const interval = this.policy.intervalMs;
    if (interval === undefined || this.disposed || !this.active || !this.enabled) {
      this.scheduler.disarm(this);
      return;
    }
    this.scheduler.arm(this, this.clock.now() + jittered(interval, this.random));
  }

  private cancelInFlight(outcome: PullOutcome): void {
    const flight = this.inFlight;
    if (!flight) { return; }
    flight.settled = true;
    this.inFlight = null;
    if (flight.timeout !== null) { this.clock.clearTimeout(flight.timeout); flight.timeout = null; }
    flight.abort.abort();
    this.record(outcome, flight.reason);
    this.scheduler.release(this);
    this.settleWaiters(flight.waiters, outcome);
  }

  private dropQueuedAutomatic(outcome: PullOutcome): void {
    const intent = this.pending;
    if (!intent || intent.strong) { return; }
    this.cancelPending(outcome);
  }

  /** Withdraw the held intent whatever its strength, settling its waiters. A
   *  retired or disconnected context owes every caller an answer. */
  private cancelPending(outcome: PullOutcome): void {
    const intent = this.pending;
    if (!intent) { return; }
    this.pending = null;
    this.record('dropped', intent.reason);
    this.scheduler.cancelRequest(this);
    this.settleWaiters(intent.waiters, outcome);
  }

  private retireContext(): void {
    this.cancelInFlight('cancelled');
    this.cancelPending('cancelled');
    this.clearCoalesceTimer();
    this.clearRetryTimer();
    this.scheduler.disarm(this);
    this.dirty = false;
    this.hasData = false;
    this.retryAttempt = 0;
    this.lastReadAt = null;
    this.statusValue = { ...INITIAL_PULL_STATUS };
    this.emitStatus();
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer !== null) {
      this.clock.clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private settleWaiters(waiters: readonly Waiter[], outcome: PullOutcome): void {
    for (const waiter of waiters) { waiter(outcome); }
  }

  private patchStatus(patch: Partial<PullStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.statusValue = {
      ...this.statusValue,
      refreshing: this.inFlight !== null || this.pending !== null,
    };
    this.onStatus?.(this.statusValue);
  }

  private record(
    kind: RefreshTelemetryEvent['kind'],
    reason: RefreshReason,
    latencyMs?: number,
  ): void {
    if (!this.onTelemetry) { return; }
    this.onTelemetry({
      label: this.label,
      reason,
      kind,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      at: this.clock.now(),
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}