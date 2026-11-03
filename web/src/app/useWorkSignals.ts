import { useMemo } from 'react';
import type { CapabilityFacts } from '@/product/capability';
import {
  resolveWorkContext,
  type ResolvedWorkContext,
} from '@/product/terminal/capsule/workAwareness';
import { collectWorkSignals } from '@/app/workSignals';

/**
 * Aggregate capability-contributed work signals into a ResolvedWorkContext.
 *
 * The shell's half of the work-awareness chain (#1347 SC-14/19): every
 * registered `CapabilityWorkBinding` senses the same observed facts, and this
 * resolves whatever comes back. Nothing here names a capability — the signal,
 * its id and its summary all belong to the contribution (`app/workSignals.ts`
 * is the registry), so a second capability reports work without this file
 * changing.
 *
 * The input is the facts object `useCapsuleCapability` already derives, not a
 * Session: the Workspace panel and the capsule read the same observations, so
 * they are made once, and the disclosed context cannot disagree with the
 * capability list for the same session.
 *
 * Graceful degradation: no facts or no signals resolves to the quiet context.
 * That is the current state for every Session (#2663): no capability reports a
 * verified activity signal yet.
 */
export function useWorkSignals(facts: CapabilityFacts | undefined): ResolvedWorkContext {
  return useMemo(() => resolveWorkContext(collectWorkSignals(facts)), [facts]);
}
