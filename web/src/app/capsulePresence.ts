import { resolveCapabilityPresences, type CapabilityId, type CapabilitySnapshot, type CapabilityState } from '@/features/capabilities';

/** The capability the capsule may show — narrowed to the states that earn it. */
export interface CapsuleCapabilitySelection {
  id: CapabilityId;
  label: string;
  state: 'relevant' | 'active';
}

/** A capability that may earn lightweight presence in the capsule. */
export interface CapsuleCapabilityCandidate {
  id: CapabilityId;
  label: string;
  state: CapabilityState;
}

const STATE_RANK: Record<CapabilityState, number> = {
  unavailable: 0,
  available: 1,
  relevant: 2,
  active: 3,
};

/**
 * Pick the single capability the capsule may show, if any.
 *
 * The capsule is not a toolbar: a registered capability earns nothing just by
 * existing (`available` has no resting presence — prose: terminal-capsule.md),
 * and however many capabilities qualify, the capsule shows at most one. That
 * bound is what keeps capsule chrome from growing with the capability set.
 *
 * Registration order is the only tie-break, so the choice stays deterministic
 * rather than depending on resolution order.
 */
export function selectCapsuleCapability(
  candidates: readonly CapsuleCapabilityCandidate[],
): CapsuleCapabilitySelection | undefined {
  let selected: CapsuleCapabilitySelection | undefined;

  for (const candidate of candidates) {
    if (candidate.state !== 'relevant' && candidate.state !== 'active') {
      continue;
    }
    if (!selected || STATE_RANK[candidate.state] > STATE_RANK[selected.state]) {
      selected = { id: candidate.id, label: candidate.label, state: candidate.state };
    }
  }

  return selected;
}

/**
 * Resolve capsule candidates from capability snapshots.
 *
 * Presence is resolved for the `capsule` surface, so a capability that earned
 * contextual presence in the Workspace still has to earn it here.
 */
export function capsuleCapabilityCandidates(
  snapshots: readonly CapabilitySnapshot[],
): CapsuleCapabilityCandidate[] {
  const presences = resolveCapabilityPresences(snapshots, { surface: 'capsule' });
  const presenceById = new Map(presences.map((presence) => [presence.capabilityId, presence]));

  return snapshots.flatMap((snapshot) => {
    const presence = presenceById.get(snapshot.id);
    if (!presence || presence.level === 'hidden' || presence.level === 'discoverable') {
      return [];
    }
    return [{ id: snapshot.id, label: snapshot.title, state: snapshot.state }];
  });
}
