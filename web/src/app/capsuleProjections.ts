import type { ReactNode } from 'react';
import type { CapabilityId } from '@/product/capability';
import { GIT_ID, gitProjection } from '@/capabilities/git';

/**
 * How a capability supplies its Terminal projection body.
 *
 * The capability contributes **content**; the capsule draws the frame and
 * Nession decides whether anything appears at all and at which depth. That is
 * the split `workspace-navigation.md` draws — "Extensions contribute
 * capability. Nession decides whether, where, and how" — and it is why this is
 * a body renderer rather than a component free to place itself.
 *
 * The exact shape is provisional by design. `#826` Q6 deferred freezing it
 * until a second implementation exists, so this is written to be replaced
 * rather than extended: nothing outside this file and the capability's own
 * `contribution.tsx` depends on its fields.
 */
export interface CapsuleProjectionBinding {
  id: CapabilityId;
  body: (props: {
    agentId: string | undefined;
    sessionId: string | undefined;
    depth: 'signal' | 'peek';
    onFocusChange: (resourceId?: string) => void;
  }) => ReactNode;
}

/**
 * Capabilities that can say anything in the Terminal, in registration order.
 *
 * Only these get a Signal when chosen in the capability entry. Everything else
 * keeps the behaviour it had: choosing it opens its Workspace view. A capability
 * absent from this list is not broken — it simply has no shallower depth to
 * deepen into, which is exactly what `capability-emergence.md` means by a
 * Terminal-local capability stopping at the Terminal.
 */
const CAPSULE_PROJECTIONS: readonly CapsuleProjectionBinding[] = [gitProjection];

export function projectionBindingFor(id: CapabilityId): CapsuleProjectionBinding | undefined {
  return CAPSULE_PROJECTIONS.find((binding) => binding.id === id);
}

/**
 * Capabilities that have a Terminal depth, for the entry to mark.
 *
 * The capability entry shows every reachable capability; this says which of them
 * will emerge beside the capsule rather than switching surface, so the
 * difference is discoverable before the tap rather than as a surprise.
 */
export const CAPSULE_PROJECTION_IDS: readonly CapabilityId[] = CAPSULE_PROJECTIONS.map(
  (binding) => binding.id,
);

export { GIT_ID };
