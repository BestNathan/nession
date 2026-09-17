import {
  resolveCapabilityDisclosure,
  resolveCapabilityPresences,
  type CapabilityDisclosureEntry,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilitySnapshot,
} from '@/features/capabilities';
import type {
  CapsuleCapabilityDisclosure,
} from '@/product/terminal/capsule/types';
import type { DomainState } from '@/product/session/model/domainState';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import type { Experience } from '@/app/workspace/workspaceContext';

/** The capsule's partition of capability presence — one rule, capsule's own limit.
 *
 *  The limit is **zero**: the capsule has no direct slot. Capability state is
 *  expressed inside the `+` expansion instead (terminal-capsule.md, decision of
 *  2026-09-16 / #748), so every present capability is discoverable and the
 *  resting capsule is identical whatever the capability states are.
 */
function capsuleDisclosure(snapshots: readonly CapabilitySnapshot[]) {
  const presences = resolveCapabilityPresences(snapshots, { surface: 'capsule' });
  return resolveCapabilityDisclosure(presences, { directLimit: 0 });
}

/** Everything the capsule presence needs from the shell, plus its two actions. */
/** What the capsule renders: no resting slot; every present capability is in `+`. */
export interface CapsuleCapabilityContribution {
  /** Reachable capabilities, each carrying its state so `+` can mark it. */
  disclosure?: CapsuleCapabilityDisclosure;
}

export interface CapsuleCapabilityInput {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onToolChange: (id: CapabilityId) => void;
  /** Reveal the surface the capability lives on. */
  onSurfaceChange: () => void;
}

/**
 * Resolve what the capsule may show: at most one chip, plus what is reachable
 * on demand.
 *
 * Same capability resolution the Workspace presentation consumes, read for the
 * `capsule` surface: the capsule cannot invent presence the registry did not
 * grant, and it shows at most one chip (see `selectCapsuleCapability`).
 *
 * Activation hands the capability back to the Workspace — the capsule reports
 * that something is relevant here; opening it belongs to the surface that owns
 * the capability's view.
 */
export function resolveCapsuleCapabilities(
  input: CapsuleCapabilityInput,
): CapsuleCapabilityContribution {
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

  const disclosure = capsuleDisclosure(snapshots);

  const activate = (id: CapabilityId) => {
    input.onToolChange(id);
    input.onSurfaceChange();
  };

  const entries: CapabilityDisclosureEntry[] = disclosure.discoverable.flatMap((presence) => {
    const snapshot = snapshots.find((candidate) => candidate.id === presence.capabilityId);
    return snapshot ? [{ id: snapshot.id, title: snapshot.title, state: snapshot.state }] : [];
  });

  return {
    disclosure: entries.length > 0 ? { entries, onSelect: activate } : undefined,
  };
}
