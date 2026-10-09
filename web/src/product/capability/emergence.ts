import type { CapabilityId } from './model';
import type { CapabilityPresence } from './presence';

export interface EmergenceInput {
  presences: readonly CapabilityPresence[];
  /** The capability the user chose in the Context Capsule, if any. */
  chosen?: CapabilityId | null;
}

/**
 * Which capability is showing beside the capsule, if any.
 *
 * **There is one depth and one source.** A capability appears when the user
 * chose it in the Context Capsule, and it appears as its Peek — the detail.
 * Nothing emerges on its own.
 *
 * This replaced a two-input resolver that also emerged a capability the Session
 * was *observed running*. That branch was removed as unreachable rather than as
 * unwanted: it required `state === 'active'` and not work-sensed, and
 * `claude-code` is the only capability in the tree that can return `'active'`
 * (`capabilities/claude-code/contribution.tsx`) while being the only work
 * binding — and its `sense` reports `working` under exactly the condition that
 * makes it `active`. So the branch could never fire, and the Signal depth it
 * produced had exactly one reachable source left: stepping back out of a Peek,
 * which is the residue the owner asked to remove.
 *
 * Replaced rather than guarded, for the reason the module already states
 * elsewhere: an input kept "just in case" is one that re-creates the decision
 * for reasons the decision does not have.
 *
 * The presence check stays. "The registry says this capability is hidden here"
 * is still a real answer, and the capsule must not show what it was told to
 * hide. Order, priority and thresholds are still absent on purpose — there is
 * now nothing to order.
 */
export function resolveCapabilityProjection({
  presences,
  chosen,
}: EmergenceInput): CapabilityId | undefined {
  if (!chosen) {
    return undefined;
  }
  const shown = presences.some(
    (presence) => presence.capabilityId === chosen && presence.level !== 'hidden',
  );
  return shown ? chosen : undefined;
}
