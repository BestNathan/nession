import { useSessionCapabilityFacts } from '@/app/useSessionCapabilityFacts';
import {
  resolveCapsuleCapabilities,
  type CapsuleCapabilityContribution,
  type CapsuleCapabilityInput,
} from '@/app/capsulePresence';
import type { CapabilityFacts } from '@/product/capability';

export interface CapsuleCapability {
  facts: CapabilityFacts | undefined;
  capabilities: CapsuleCapabilityContribution;
}

/**
 * Observe the session once and resolve the capsule's contribution from it.
 *
 * The Workspace panel and the capsule read the same observations, so they are
 * made here instead of twice: a capability cannot be active in the capsule and
 * absent in the Workspace for the same session.
 */
export function useCapsuleCapability(
  input: Omit<CapsuleCapabilityInput, 'facts'>,
): CapsuleCapability {
  const facts = useSessionCapabilityFacts(input.session);
  return { facts, capabilities: resolveCapsuleCapabilities({ ...input, facts }) };
}
