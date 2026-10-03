import type { CapabilityId } from '@/product/capability';
import { terminalKeysContext } from '@/product/terminal/terminalKeys';

/**
 * How a capability contributes *context* semantics to the capsule (#1347
 * SC-37/40).
 *
 * The sibling of `workSignals.ts`, and the two are deliberately the same
 * shape — a binding senses, the shell aggregates, the Context Disclosure
 * renders both kinds in one list — because the requirement's second half is
 * that work-sensed and context-sensed capabilities **share one protocol**:
 * sensed -> Context Disclosure -> capability-defined Peek, with no
 * capability-specific branch anywhere in between.
 *
 * What differs is only the input. A work binding reads observations of the
 * session (the pane's foreground command); a context binding reads the surface
 * the user is holding. Neither lights the Work Ring by itself: the ring means
 * *work*, and Terminal Keys is not working — it is relevant because the device
 * has no keyboard (SC-37).
 */
export interface CapabilityContextBinding {
  id: CapabilityId;
  /**
   * Turn the surface context into a ContextSignal, or `null` when the
   * capability has nothing to report here. Quiet is the absence of a signal.
   */
  sense: (context: CapabilitySenseContext) => ContextSignal | null;
}

/** The surface-owned context a binding may read. */
export interface CapabilitySenseContext {
  sessionId?: string;
  experience?: 'web' | 'app';
}

/** What a context-sensed capability reports: who, and one line of why. */
export interface ContextSignal {
  capabilityId: CapabilityId;
  summary: string;
}

/**
 * Capabilities that can report context, in registration order.
 */
const CAPSULE_CONTEXT_BINDINGS: readonly CapabilityContextBinding[] = [terminalKeysContext];

/**
 * Aggregate every contribution's signal from one context.
 *
 * The `bindings` parameter exists so a test can prove the seam is generic — a
 * binding the collector has never seen flows through by shape, not by name.
 * Production never passes it.
 */
export function collectContextSignals(
  context: CapabilitySenseContext,
  bindings: readonly CapabilityContextBinding[] = CAPSULE_CONTEXT_BINDINGS,
): ContextSignal[] {
  const signals: ContextSignal[] = [];
  for (const binding of bindings) {
    const signal = binding.sense(context);
    if (signal) {
      signals.push(signal);
    }
  }
  return signals;
}
