import {
  resolveCapabilityPresences,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilitySnapshot,
  type CapabilityState,
} from '@/features/capabilities';
import type { CapsuleCapabilityPresence } from '@/features/terminal/capsule/types';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import type { Experience, WorkspaceToolId } from '@/app/workspace/toolTypes';

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

/** Everything the capsule presence needs from the shell, plus its two actions. */
export interface CapsuleCapabilityInput {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onToolChange: (id: WorkspaceToolId) => void;
  /** Reveal the surface the capability lives on. */
  onSurfaceChange: () => void;
}

/**
 * Resolve the capsule's one capability contribution, if any earned it.
 *
 * Same capability resolution the Workspace presentation consumes, read for the
 * `capsule` surface: the capsule cannot invent presence the registry did not
 * grant, and it shows at most one chip (see `selectCapsuleCapability`).
 *
 * Activation hands the capability back to the Workspace — the capsule reports
 * that something is relevant here; opening it belongs to the surface that owns
 * the capability's view.
 */
export function resolveCapsuleCapabilityPresence(
  input: CapsuleCapabilityInput,
): CapsuleCapabilityPresence | undefined {
  const { snapshots } = resolveWorkspaceCapabilities({
    session: input.session,
    agent: input.agent,
    agents: input.agents,
    domain: input.domain,
    fileOps: input.fileOps,
    experience: input.experience,
    facts: input.facts,
    onToolChange: input.onToolChange,
  });

  const selected = selectCapsuleCapability(capsuleCapabilityCandidates(snapshots));
  if (!selected) {
    return undefined;
  }

  return {
    id: selected.id,
    label: selected.label,
    state: selected.state,
    onActivate: () => {
      input.onToolChange(selected.id);
      input.onSurfaceChange();
    },
  };
}
