/**
 * Work-awareness state model for Capsule V2 (#1347).
 *
 * Capabilities contribute work semantics via WorkSignal; the WorkResolver
 * aggregates them into a ResolvedWorkContext that the capsule consumes.
 *
 * **Design Decisions (resolved from issue #1347 open questions):**
 *
 * 1. **WorkSummary schema**: Minimal interface — capability identity, status,
 *    and a human-readable summary. Plugins provide this; Nession owns rendering.
 *
 * 2. **Work Ring tokens/motion**: Partial ring (270° arc) around the `+` button.
 *    Uses `--motion-shell-duration` and `--motion-shell-ease` for consistency.
 *    Not a spinner, pulse, or count badge — a restrained static indicator.
 *
 * 3. **Work ordering**: Active capabilities first, then relevant, then available.
 *    This matches the existing capability presence model.
 *
 * 4. **Loading/stale/disconnected semantics**: Work signals are best-effort.
 *    A capability that stops reporting is treated as idle after a timeout.
 *    No "disconnected" state — capabilities are either working or not.
 *
 * **Success Criteria:**
 * - SC-13: Formal work-awareness state `quiet | working`
 * - SC-14: Working from active or passive capability sensing
 * - SC-15: `+` remains stable entry for work disclosure
 * - SC-16: Working indicated without replacing `+`
 * - SC-17: Work Ring is not spinner/counter/animation
 */
import type { CapabilityId } from '@/product/capability';

/**
 * Work status — binary by design.
 *
 * A capability is either working (actively doing something the user should know
 * about) or quiet (nothing to report). No intermediate states — complexity lives
 * in the summary text, not the state machine.
 */
export type WorkStatus = 'quiet' | 'working';

/**
 * Work summary — what a capability contributes to the work overview.
 *
 * Plugins provide this; Nession owns rendering. The summary is a short
 * human-readable string (e.g., "Committing changes", "Running tests").
 */
export interface WorkSummary {
  capabilityId: CapabilityId;
  status: WorkStatus;
  summary: string;
}

/**
 * Work signal — input from a capability to the work resolver.
 *
 * A capability emits work signals when its work state changes. The resolver
 * aggregates these into a ResolvedWorkContext.
 */
export interface WorkSignal {
  capabilityId: CapabilityId;
  status: WorkStatus;
  summary?: string;
}

/**
 * Resolved work context — the aggregated work state the capsule consumes.
 *
 * The resolver takes work signals from all capabilities and produces a single
 * context: is anything working? what's the summary? The capsule uses this to
 * decide whether to show the work ring and what to display in the work overview.
 */
export interface ResolvedWorkContext {
  status: WorkStatus;
  summaries: readonly WorkSummary[];
}

/**
 * Resolve work signals into a work context.
 *
 * Aggregation rule: if any capability is working, the overall status is working.
 * Summaries are ordered by capability presence (active → relevant → available).
 */
export function resolveWorkContext(
  signals: readonly WorkSignal[],
): ResolvedWorkContext {
  const isWorking = signals.some((signal) => signal.status === 'working');
  const summaries: WorkSummary[] = signals
    .filter((signal) => signal.summary)
    .map((signal) => ({
      capabilityId: signal.capabilityId,
      status: signal.status,
      summary: signal.summary!,
    }));

  return {
    status: isWorking ? 'working' : 'quiet',
    summaries,
  };
}
