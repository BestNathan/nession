import {
  resolveCapabilityDisclosure,
  resolveCapabilityPresences,
  type CapabilityDisclosureEntry,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilityPresence,
  type CapabilitySnapshot,
} from '@/features/capabilities';
import type {
  CapsuleCapabilityDisclosure,
  CapsuleCapabilityPresence,
} from '@/features/terminal/capsule/types';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import type { Experience } from '@/app/workspace/workspaceContext';

/** The capability the capsule may show — narrowed to the states that earn it. */
export interface CapsuleCapabilitySelection {
  id: CapabilityId;
  label: string;
  state: 'relevant' | 'active';
}

/** The capsule's partition of capability presence — one rule, capsule's own limit. */
function capsuleDisclosure(snapshots: readonly CapabilitySnapshot[]) {
  const presences = resolveCapabilityPresences(snapshots, { surface: 'capsule' });
  return resolveCapabilityDisclosure(presences, { directLimit: 1 });
}

function selectionFrom(
  snapshots: readonly CapabilitySnapshot[],
  direct: readonly CapabilityPresence[],
): CapsuleCapabilitySelection | undefined {
  const [selected] = direct;
  if (!selected) {
    return undefined;
  }

  const snapshot = snapshots.find((candidate) => candidate.id === selected.capabilityId);
  if (!snapshot || (snapshot.state !== 'relevant' && snapshot.state !== 'active')) {
    return undefined;
  }

  return { id: snapshot.id, label: snapshot.title, state: snapshot.state };
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
  return selectionFrom(snapshots, capsuleDisclosure(snapshots).direct);
}

/** Everything the capsule presence needs from the shell, plus its two actions. */
/** What the capsule renders: the chip that earned presence, and the rest on demand. */
export interface CapsuleCapabilityContribution {
  /** The capability that earned the capsule's chip, if any. At most one. */
  capability?: CapsuleCapabilityPresence;
  /** Visible capabilities with no chip — the capsule's discovery entry. */
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
  const selected = selectionFrom(snapshots, disclosure.direct);

  const activate = (id: CapabilityId) => {
    input.onToolChange(id);
    input.onSurfaceChange();
  };

  const entries: CapabilityDisclosureEntry[] = disclosure.discoverable.flatMap((presence) => {
    const snapshot = snapshots.find((candidate) => candidate.id === presence.capabilityId);
    return snapshot ? [{ id: snapshot.id, title: snapshot.title, state: snapshot.state }] : [];
  });

  return {
    capability: selected
      ? {
        ...selected,
        onActivate: () => activate(selected.id),
      }
      : undefined,
    disclosure: entries.length > 0 ? { entries, onSelect: activate } : undefined,
  };
}
