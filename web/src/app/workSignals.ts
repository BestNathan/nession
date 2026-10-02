import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { WorkSignal } from '@/product/terminal/capsule/workAwareness';
import { claudeCodeWork } from '@/capabilities/claude-code';

/**
 * How a capability contributes work semantics to the capsule (#1347 SC-14/19).
 *
 * The requirement's chain is `capability → WorkSignal → WorkResolver →
 * ResolvedWorkContext`, and this is its first link: the capability owns *what*
 * working means for it — the matcher, the status, the human summary — and the
 * shell only aggregates. `useWorkSignals` used to synthesize the signal in the
 * app layer and name Claude Code to do it, which made the chain a Claude
 * special case: a second capability could not report work without editing the
 * shell. Re-review #2 on #1347 rejected exactly that.
 *
 * `sense` is a **pure function of observed facts**, not a hook. Passive
 * sensing reads what the agent already reports (the pane's foreground command
 * is in `CapabilityFacts.sessionForegroundCommand`); a capability with an
 * active producer feeds the same facts shape from its own observation before
 * calling this, so the formal `quiet | working` model (SC-13) never learns
 * which kind it is answering.
 *
 * The same composition rule as `capsuleProjections.ts` applies: the binding
 * type and the registry live here because declaring contributions by value is
 * the surface owner's job (PRINCIPLE #5); the capability imports this type
 * type-only and exports its binding from its own `contribution.tsx`. A second
 * capability arrives by writing its `sense` and adding one line to the list —
 * nothing in the collector can name it, which is the property the review
 * asked for.
 */
export interface CapabilityWorkBinding {
  id: CapabilityId;
  /**
   * Turn observed facts into a WorkSignal, or `null` when the capability has
   * nothing to report. Quiet is the absence of a signal — a binding must not
   * emit `{ status: 'quiet' }` entries for sessions it is idle in, or the Work
   * Overview would fill with non-work.
   */
  sense: (facts: CapabilityFacts | undefined) => WorkSignal | null;
}

/**
 * Capabilities that can report work, in registration order.
 */
const CAPSULE_WORK_BINDINGS: readonly CapabilityWorkBinding[] = [claudeCodeWork];

/**
 * Aggregate every contribution's signal from one observation.
 *
 * The `bindings` parameter exists so a test can prove the seam is generic —
 * a binding the collector has never seen flows through by shape, not by name.
 * Production never passes it.
 */
export function collectWorkSignals(
  facts: CapabilityFacts | undefined,
  bindings: readonly CapabilityWorkBinding[] = CAPSULE_WORK_BINDINGS,
): WorkSignal[] {
  const signals: WorkSignal[] = [];
  for (const binding of bindings) {
    const signal = binding.sense(facts);
    if (signal) {
      signals.push(signal);
    }
  }
  return signals;
}
