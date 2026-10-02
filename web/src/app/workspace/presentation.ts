import {
  resolveCapabilityDisclosure,
  type CapabilityId,
  type CapabilityPresence,
  type CapabilitySnapshot,
} from '@/product/capability';

export const WORKSPACE_DIRECT_CAPABILITY_LIMIT = 2;

export interface WorkspacePresentationItem {
  snapshot: CapabilitySnapshot;
  presence: CapabilityPresence;
}

export interface WorkspacePresentationModel {
  /** The explicitly opened capability, even when it has become hidden/unavailable. */
  opened?: WorkspacePresentationItem;
  /** Opened visible capability. It owns the first direct slot. */
  primary: WorkspacePresentationItem[];
  /** Additional relevant/active capabilities allowed into bounded direct chrome. */
  contextual: WorkspacePresentationItem[];
  /** Visible capabilities intentionally revealed through More/discovery. */
  discoverable: WorkspacePresentationItem[];
  /**
   * Capabilities the user cannot act with right now — `unavailable`, which the
   * presence policy resolves to `hidden`.
   *
   * They are neither direct chrome nor disclosure, so the policy has no bucket
   * for them; they are carried here so a surface can render them *inert* rather
   * than drop them. Membership that changes as the work changes is the thing
   * being avoided: an entry that vanishes and reappears is how a reader loses
   * track of what the Workspace holds.
   */
  unavailable: WorkspacePresentationItem[];
}

export interface WorkspacePresentationInput {
  snapshots: readonly CapabilitySnapshot[];
  presences: readonly CapabilityPresence[];
  openedCapabilityId?: CapabilityId | null;
  directLimit?: number;
}

/**
 * Nession-owned Workspace presentation policy.
 *
 * The rule that decides slot / disclosure / absence lives in the capability
 * layer (`resolveCapabilityDisclosure`); what belongs to the Workspace is how
 * many direct slots it has and that the opened capability keeps one of them.
 * Registration order stays deterministic input, but it is not UI placement.
 */
export function buildWorkspacePresentationModel({
  snapshots,
  presences,
  openedCapabilityId,
  directLimit = WORKSPACE_DIRECT_CAPABILITY_LIMIT,
}: WorkspacePresentationInput): WorkspacePresentationModel {
  const items = snapshots.flatMap((snapshot) => {
    const presence = presences.find((candidate) => candidate.capabilityId === snapshot.id);
    return presence ? [{ snapshot, presence }] : [];
  });
  const itemById = new Map(items.map((item) => [item.snapshot.id, item]));

  const disclosure = resolveCapabilityDisclosure(presences, {
    directLimit,
    pinned: openedCapabilityId ? [openedCapabilityId] : [],
  });

  const direct = disclosure.direct.flatMap((presence) => {
    const item = itemById.get(presence.capabilityId);
    return item ? [item] : [];
  });

  return {
    opened: openedCapabilityId ? itemById.get(openedCapabilityId) : undefined,
    primary: direct.filter((item) => item.snapshot.id === openedCapabilityId),
    contextual: direct.filter((item) => item.snapshot.id !== openedCapabilityId),
    discoverable: disclosure.discoverable.flatMap((presence) => {
      const item = itemById.get(presence.capabilityId);
      return item ? [item] : [];
    }),
    unavailable: disclosure.hidden.flatMap((presence) => {
      const item = itemById.get(presence.capabilityId);
      return item ? [item] : [];
    }),
  };
}
