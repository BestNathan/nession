import {
  resolveCapabilityDisclosure,
  resolveCapabilityPresences,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilitySnapshot,
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

/**
 * Pick the single capability the capsule may show, if any.
 *
 * The capsule is not a toolbar: a registered capability earns nothing just by
 * existing (prose: terminal-capsule.md), and however many capabilities qualify,
 * the capsule shows at most one. Both come from the shared disclosure rule,
 * read with a limit of one — the capsule does not get its own discovery policy,
 * only its own number.
 *
 * Registration order is the only tie-break, so the choice stays deterministic
 * rather than depending on resolution order.
 */
export function selectCapsuleCapability(
  snapshots: readonly CapabilitySnapshot[],
): CapsuleCapabilitySelection | undefined {
  const presences = resolveCapabilityPresences(snapshots, { surface: 'capsule' });
  const [selected] = resolveCapabilityDisclosure(presences, { directLimit: 1 }).direct;
  if (!selected) {
    return undefined;
  }

  const snapshot = snapshots.find((candidate) => candidate.id === selected.capabilityId);
  if (!snapshot || (snapshot.state !== 'relevant' && snapshot.state !== 'active')) {
    return undefined;
  }

  return { id: snapshot.id, label: snapshot.title, state: snapshot.state };
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

  const selected = selectCapsuleCapability(snapshots);
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
