import {
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_MAX_PER_TARGET,
  systemClock,
  type RefreshClock,
} from './types';

/** Manual work outranks every automatic read; within a class, service is fair. */
export type RefreshPriority = 'manual' | 'auto';

/**
 * One live controller's seam into the scheduler. The scheduler holds no
 * business data and no snapshot — only this callback pair and a due time.
 */
export interface RefreshRegistration {
  /** Controller identity. Also the queue key: one entry per live controller. */
  readonly owner: object;
  /** Routing/Agent target for the per-target budget, read at dispatch time so
   *  a context change is honoured without re-registering. */
  readonly target?: string;
  /** A slot was granted. The controller starts exactly one read here. */
  start(priority: RefreshPriority): void;
  /** An armed due time arrived. The controller decides whether to request. */
  due(): void;
}

export interface RefreshSchedulerOptions {
  clock?: RefreshClock;
  maxInFlight?: number;
  maxPerTarget?: number;
}

interface QueueEntry {
  priority: RefreshPriority;
  /** Arrival order, the FIFO tie-break inside one priority class. */
  seq: number;
}

/**
 * The one place that decides *when* a queued read may start (#4602 §3).
 *
 * It owns three things and nothing else: a bounded in-flight budget (global and
 * per routing target), one bounded queue entry per live controller with manual
 * priority and fair automatic service, and due times for periodic reads on a
 * single timer — so no view installs its own `setInterval`.
 *
 * Fairness is round-robin by last service, not by registration order: a
 * controller that just read goes behind ones that have waited longer, which is
 * what stops a chatty list from starving the rest under a full queue.
 */
export class RefreshScheduler {
  private readonly clock: RefreshClock;
  private readonly maxInFlight: number;
  private readonly maxPerTarget: number;

  private readonly registrations = new Map<object, RefreshRegistration>();
  private readonly queue = new Map<object, QueueEntry>();
  private readonly running = new Set<object>();
  private readonly targetCounts = new Map<string, number>();
  private readonly lastServed = new Map<object, number>();
  private readonly dueTimes = new Map<object, number>();

  private enqueueSeq = 0;
  private serveSeq = 0;
  private timer: number | null = null;
  private timerDueAt = 0;
  private dispatching = false;
  private disposed = false;

  constructor(options: RefreshSchedulerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxPerTarget = options.maxPerTarget ?? DEFAULT_MAX_PER_TARGET;
  }

  get inFlightCount(): number {
    return this.running.size;
  }

  get queueLength(): number {
    return this.queue.size;
  }

  get registrationCount(): number {
    return this.registrations.size;
  }

  register(registration: RefreshRegistration): void {
    if (this.disposed) { return; }
    this.registrations.set(registration.owner, registration);
  }

  unregister(owner: object): void {
    this.registrations.delete(owner);
    this.queue.delete(owner);
    this.dueTimes.delete(owner);
    this.lastServed.delete(owner);
    if (this.running.delete(owner)) {
      this.decrementTarget(owner);
    }
    this.rescheduleTimer();
    this.dispatch();
  }

  /** Ask for a slot. Repeat requests merge into the one bounded entry and only
   *  ever raise its priority — a manual ask behind an automatic one is served
   *  as manual. */
  enqueue(owner: object, priority: RefreshPriority): void {
    if (this.disposed || !this.registrations.has(owner)) { return; }
    const existing = this.queue.get(owner);
    if (existing) {
      if (priority === 'manual') { existing.priority = 'manual'; }
    } else {
      this.enqueueSeq += 1;
      this.queue.set(owner, { priority, seq: this.enqueueSeq });
    }
    this.dispatch();
  }

  /** Withdraw a queued intent that was never granted a slot (a complete push
   *  made it redundant, or the context retired). Does not touch a running read. */
  cancelRequest(owner: object): void {
    this.queue.delete(owner);
  }

  /** The read settled (applied, failed, superseded or cancelled). Frees the
   *  slot and lets the next queued controller run. */
  release(owner: object): void {
    if (!this.running.delete(owner)) { return; }
    this.decrementTarget(owner);
    this.serveSeq += 1;
    this.lastServed.set(owner, this.serveSeq);
    this.dispatch();
  }

  /** Arm the next periodic due time for a controller, replacing any previous
   *  one. All due times share the scheduler's single timer. */
  arm(owner: object, dueAt: number): void {
    if (this.disposed || !this.registrations.has(owner)) { return; }
    this.dueTimes.set(owner, dueAt);
    this.rescheduleTimer();
  }

  disarm(owner: object): void {
    if (this.dueTimes.delete(owner)) {
      this.rescheduleTimer();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.registrations.clear();
    this.queue.clear();
    this.running.clear();
    this.targetCounts.clear();
    this.lastServed.clear();
    this.dueTimes.clear();
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private targetOf(owner: object): string | undefined {
    return this.registrations.get(owner)?.target;
  }

  private decrementTarget(owner: object): void {
    const target = this.targetOf(owner);
    if (target === undefined) { return; }
    const next = (this.targetCounts.get(target) ?? 1) - 1;
    if (next <= 0) { this.targetCounts.delete(target); } else { this.targetCounts.set(target, next); }
  }

  /** Next eligible entry: manual first (FIFO), then the longest-waiting
   *  automatic controller whose target still has budget. */
  private pickNext(): object | null {
    let best: object | null = null;
    let bestEntry: QueueEntry | null = null;
    for (const [owner, entry] of this.queue) {
      // One read per controller: a stronger intent queued behind a live read
      // waits for its slot instead of opening a second concurrent request.
      if (this.running.has(owner)) { continue; }
      const target = this.targetOf(owner);
      if (target !== undefined && (this.targetCounts.get(target) ?? 0) >= this.maxPerTarget) {
        continue;
      }
      if (bestEntry === null) { best = owner; bestEntry = entry; continue; }
      if (entry.priority !== bestEntry.priority) {
        if (entry.priority === 'manual') { best = owner; bestEntry = entry; }
        continue;
      }
      if (entry.priority === 'manual') {
        if (entry.seq < bestEntry.seq) { best = owner; bestEntry = entry; }
        continue;
      }
      const served = this.lastServed.get(owner) ?? 0;
      const bestServed = this.lastServed.get(best as object) ?? 0;
      if (served < bestServed || (served === bestServed && entry.seq < bestEntry.seq)) {
        best = owner;
        bestEntry = entry;
      }
    }
    return best;
  }

  private dispatch(): void {
    // `start()` can settle synchronously (a cancelled or already-fenced read)
    // and re-enter through release(); loop instead of recursing.
    if (this.dispatching) { return; }
    this.dispatching = true;
    try {
      while (this.running.size < this.maxInFlight) {
        const owner = this.pickNext();
        if (owner === null) { break; }
        const entry = this.queue.get(owner);
        const registration = this.registrations.get(owner);
        if (!entry || !registration) { this.queue.delete(owner); continue; }
        this.queue.delete(owner);
        this.running.add(owner);
        const target = registration.target;
        if (target !== undefined) {
          this.targetCounts.set(target, (this.targetCounts.get(target) ?? 0) + 1);
        }
        registration.start(entry.priority);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private rescheduleTimer(): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const dueAt of this.dueTimes.values()) {
      if (dueAt < earliest) { earliest = dueAt; }
    }
    if (!Number.isFinite(earliest)) {
      if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
      return;
    }
    if (this.timer !== null && this.timerDueAt === earliest) { return; }
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); }
    this.timerDueAt = earliest;
    this.timer = this.clock.setTimeout(() => this.fireDue(), Math.max(0, earliest - this.clock.now()));
  }

  private fireDue(): void {
    this.timer = null;
    const now = this.clock.now();
    const due: RefreshRegistration[] = [];
    for (const [owner, dueAt] of [...this.dueTimes]) {
      if (dueAt <= now) {
        this.dueTimes.delete(owner);
        const registration = this.registrations.get(owner);
        if (registration) { due.push(registration); }
      }
    }
    for (const registration of due) { registration.due(); }
    this.rescheduleTimer();
  }
}