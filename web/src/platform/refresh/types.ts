/**
 * Shared vocabulary for the frontend pull/refresh lifecycle (#4602).
 *
 * This layer owns *when* a read happens and *whether its answer may still be
 * published*. It owns no business data: the snapshot type `T`, the query scope,
 * filters, pagination and the Jotai/React state a list lives in all stay with
 * the Product/Capability that already owns them. There is deliberately no
 * resource registry, cache key space or cross-Agent consistency protocol here.
 */

/** Why a read was requested. `manual`/`retry` are user-initiated and stronger
 *  than every automatic reason; the scheduler and the pending-intent merge both
 *  order on that strength rather than on arrival order. */
export type RefreshReason =
  | 'mount'
  | 'activate'
  | 'foreground'
  | 'reconnect'
  | 'interval'
  | 'invalidate'
  | 'mutation'
  | 'manual'
  | 'retry';

/**
 * What became of one requested read.
 *
 * - `applied`    — the snapshot was published under a live guard.
 * - `superseded` — a newer push/request owns the answer; nothing was published.
 * - `failed`     — the read errored or timed out; last known data is retained.
 * - `cancelled`  — no read was made (retired context, inactive, disabled, abort).
 * - `partial`    — an authoritative but incomplete answer (e.g. `stale_agents`).
 *
 * A caller must never read `superseded`/`cancelled` as success, and a `partial`
 * answer is not a clean one.
 */
export type PullOutcome = 'applied' | 'superseded' | 'failed' | 'cancelled' | 'partial';

/** Reasons that a user asked for, which outrank queued automatic reads. */
export const STRONG_REASONS: readonly RefreshReason[] = ['manual', 'retry'];

export function isStrongReason(reason: RefreshReason): boolean {
  return STRONG_REASONS.includes(reason);
}

/** The transport/lifecycle facts a pull may read. `signal` aborts when the
 *  controller retires the context; a transport that cannot abort is still
 *  logically fenced by the controller, so a late completion cannot publish. */
export interface PullContext {
  reason: RefreshReason;
  signal: AbortSignal;
  /** True when the caller asked for the authoritative re-query (`force`). */
  force: boolean;
}

export interface PullRefreshPolicy {
  /** Periodic cadence while mounted/active/visible/connected/enabled. Omit for
   *  demand-only surfaces (Git per #4455). */
  intervalMs?: number;
  /** Floor between automatic reads of the same scope. Manual skips it. */
  minIntervalMs?: number;
  /** Bounded wait for one read. Required: an unbounded pull holds a slot. */
  timeoutMs: number;
  onForeground: boolean;
  onReconnect: boolean;
  onActivate: boolean;
  /** Routing/Agent target for the per-target concurrency budget, when known. */
  target?: string;
  /** Automatic exponential retry after a failure. Off for expensive or
   *  externally rate-limited reads that must not amplify load. */
  autoRetry?: boolean;
  /** Longest a burst of invalidations may defer the trailing read. */
  coalesceMs?: number;
}

/** Observable per-controller status. It feeds UI; it never owns domain state. */
export interface PullStatus {
  /** First read of this context has not settled yet (no data to show). */
  loading: boolean;
  /** A read is in flight or queued for this context. */
  refreshing: boolean;
  /** Last known data may be behind the authority (failure/disconnect). */
  stale: boolean;
  /** Epoch ms of the last authoritative publication, or null before any. */
  lastSuccessAt: number | null;
  error: string | null;
}

export const INITIAL_PULL_STATUS: PullStatus = {
  loading: false,
  refreshing: false,
  stale: false,
  lastSuccessAt: null,
  error: null,
};

/** Injectable time, so every lifecycle test is deterministic. */
export interface RefreshClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export const systemClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

/** Default budgets (#4602 §3). Initial policy values, not platform promises. */
export const DEFAULT_MAX_IN_FLIGHT = 4;
export const DEFAULT_MAX_PER_TARGET = 2;
export const DEFAULT_COALESCE_MS = 500;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Automatic retry backoff 1/2/4/8… capped at 30s, with jitter. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;
/** ~10% cadence jitter so many controllers do not align into a burst. */
export const JITTER_RATIO = 0.1;

export function jittered(ms: number, random: () => number = Math.random): number {
  const spread = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - spread + random() * spread * 2));
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  return jittered(raw, random);
}