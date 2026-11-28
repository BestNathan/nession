// Reachability probe contract (#4618).
//
// The probe service owns scheduling, cancellation, candidate measurement,
// cache and publication. It observes whether an HTTP path (or, for a legacy
// peer, a WS upgrade) responds from THIS browser; it never decides routes,
// clears a WS failure budget, or attaches a Session. Route policy and the
// transport authority consume these observations as facts, not commands.

/** Whether the last settled observation reached the candidate. */
export type Reachability = 'unknown' | 'reachable' | 'unreachable';

/** How a candidate was measured. HTTP is the canonical path; legacy-ws is the
 *  bounded compatibility probe for a peer that advertises no `probe_url`. */
export type ProbeMethod = 'http' | 'legacy-ws';

/** Why a probe settled non-reachable. Bounded enum — never a URL or raw error
 *  text. `blocked-or-network` is deliberately ambiguous: a browser cannot tell
 *  CORS/TLS/mixed-content policy from a physically down network, so the probe
 *  reports "no response in this observation", not proof the network is down. */
export type ProbeFailureReason =
  | 'timeout'
  | 'blocked-or-network'
  | 'invalid-response'
  | 'http-error'
  | 'unsupported'
  | 'cancelled';

/** What woke a refresh. Bounded enum for diagnostics (no raw event payload). */
export type ProbeTrigger =
  | 'mount'
  | 'periodic'
  | 'foreground'
  | 'pageshow'
  | 'online'
  | 'network-change'
  | 'inventory'
  | 'transport-loss'
  | 'retry-failure'
  | 'manual';

/** One advertised candidate the browser may probe. `probeUrl` is the
 *  owner-approved HTTP endpoint; absent means the legacy WS compatibility path. */
export interface ProbeCandidate {
  /** Stable identity within the target — the normalized WS URL. */
  addressId: string;
  wsUrl: string;
  probeUrl?: string | null;
}

/** A logical probe target: the active Server or one Agent. Membership is
 *  authoritative — addresses removed from the inventory are retired. */
export interface ProbeTarget {
  targetId: string;
  kind: 'server' | 'agent';
  addresses: ProbeCandidate[];
}

/** Per-address probe state. The key is scoped by logical target + normalized
 *  candidate identity. Generations fence obsolete results: a stale request
 *  finally can never clear a newer task. */
export interface AddressProbeState {
  targetId: string;
  addressId: string;
  wsUrl: string;
  probeUrl?: string | null;
  inventoryGeneration: number;
  networkEpoch: number;
  probeGeneration: number;
  probing: boolean;
  reachability: Reachability;
  latencyMs: number | null;
  measuredAt: number | null;
  lastReachableAt: number | null;
  method: ProbeMethod;
  failureReason?: ProbeFailureReason;
}

/** Immutable snapshot for React's useSyncExternalStore. `version` advances on
 *  every publication so subscribers re-read; `states` is keyed by
 *  {@link probeStateKey}. The map is replaced (never mutated) on publication. */
export interface ProbeSnapshot {
  version: number;
  states: ReadonlyMap<string, AddressProbeState>;
}

/** A bounded, redacted probe fact for client diagnostics (#4618, #4437 policy).
 *
 *  Never carries a URL, IP, auth token or raw Session/Agent ID: `targetKind`,
 *  `trigger`, `method`, `result` and `failureReason` are bounded enums, and the
 *  generation/epoch counters correlate an episode without naming a host. The
 *  consumer decides where this goes. */
export interface ProbeDiagnostic {
  event:
    | 'refresh'
    | 'probe-settled'
    | 'probe-cancelled'
    | 'round-complete'
    | 'reachability-change';
  targetKind: 'server' | 'agent';
  trigger?: ProbeTrigger;
  method?: ProbeMethod;
  result?: Reachability;
  failureReason?: ProbeFailureReason;
  durationMs?: number;
  inventoryGeneration?: number;
  networkEpoch?: number;
  probeGeneration?: number;
  /** In-flight high-water mark observed for the round (bounded queue fact). */
  queueHighWater?: number;
  /** Count of reachability changes in the round, for diagnostics only. */
  reachabilityChanges?: number;
}

/** Default periodic maintenance interval: 5 minutes (#4618 explicit default). */
export const DEFAULT_PROBE_INTERVAL_MS = 300_000;

/** Repeated signals coalesce into one effective refresh within this window. */
export const PROBE_DEBOUNCE_MS = 500;

/** Per-candidate HTTP measurement deadline. */
export const PROBE_HTTP_DEADLINE_MS = 3_000;

/** Global concurrent probe flights across all targets. */
export const PROBE_MAX_GLOBAL_IN_FLIGHT = 8;

/** Concurrent probe flights within one target. */
export const PROBE_MAX_PER_TARGET_IN_FLIGHT = 4;

/** Configurable interval bounds. 0 disables periodic work (event-driven
 *  recovery stays armed); a positive interval is clamped to a finite range. */
export const PROBE_MIN_INTERVAL_MS = 30_000;
export const PROBE_MAX_INTERVAL_MS = 3_600_000;

/** The state-map key: logical target + normalized candidate identity. */
export function probeStateKey(targetId: string, addressId: string): string {
  return `${targetId}::${addressId}`;
}

/** Clamp a configured interval to a finite bound. 0 (or negative) disables
 *  periodic probing; event-driven recovery is unaffected. */
export function clampProbeInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.min(PROBE_MAX_INTERVAL_MS, Math.max(PROBE_MIN_INTERVAL_MS, Math.round(ms)));
}
