import type { RefreshTelemetryEvent } from './PullController';
import type { RefreshReason } from './types';

export interface RefreshAggregate {
  label: string;
  reason: RefreshReason;
  pulls: number;
  coalesced: number;
  applied: number;
  partial: number;
  failed: number;
  superseded: number;
  cancelled: number;
  dropped: number;
  /** Sum and count of read latencies, so a mean is derivable without keeping
   *  every sample. */
  latencyTotalMs: number;
  latencySamples: number;
  lastSuccessAt: number | null;
}

/** Bounded label cardinality: a surface name, never a session id or path. */
const MAX_LABELS = 64;
const UNKNOWN_LABEL = 'other';

function emptyAggregate(label: string, reason: RefreshReason): RefreshAggregate {
  return {
    label,
    reason,
    pulls: 0,
    coalesced: 0,
    applied: 0,
    partial: 0,
    failed: 0,
    superseded: 0,
    cancelled: 0,
    dropped: 0,
    latencyTotalMs: 0,
    latencySamples: 0,
    lastSuccessAt: null,
  };
}

/**
 * Aggregated pull lifecycle counters (#4602 SC-07).
 *
 * Deliberately low-cardinality and in-memory: it answers "which surface is
 * reading, how often, and how many reads were merged or dropped" for a debug
 * dump. It is not a monitoring backend and keeps no per-session, per-path or
 * per-query dimension.
 */
export class RefreshTelemetry {
  private readonly aggregates = new Map<string, RefreshAggregate>();
  private readonly labels = new Set<string>();

  record(event: RefreshTelemetryEvent): void {
    let label = event.label;
    if (!this.labels.has(label)) {
      if (this.labels.size >= MAX_LABELS) {
        label = UNKNOWN_LABEL;
      } else {
        this.labels.add(label);
      }
    }
    const key = `${label}|${event.reason}`;
    let aggregate = this.aggregates.get(key);
    if (!aggregate) {
      aggregate = emptyAggregate(label, event.reason);
      this.aggregates.set(key, aggregate);
    }
    switch (event.kind) {
      case 'pull': aggregate.pulls += 1; break;
      case 'coalesced': aggregate.coalesced += 1; break;
      case 'applied': aggregate.applied += 1; break;
      case 'partial': aggregate.partial += 1; break;
      case 'failed': aggregate.failed += 1; break;
      case 'superseded': aggregate.superseded += 1; break;
      case 'cancelled': aggregate.cancelled += 1; break;
      case 'dropped': aggregate.dropped += 1; break;
    }
    if (event.latencyMs !== undefined) {
      aggregate.latencyTotalMs += event.latencyMs;
      aggregate.latencySamples += 1;
    }
    if (event.kind === 'applied' || event.kind === 'partial') {
      aggregate.lastSuccessAt = event.at;
    }
  }

  snapshot(): RefreshAggregate[] {
    return [...this.aggregates.values()].map((aggregate) => ({ ...aggregate }));
  }

  clear(): void {
    this.aggregates.clear();
    this.labels.clear();
  }
}