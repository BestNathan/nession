import {
  resolveCapabilityDisclosure,
  type CapabilityId,
  type CapabilityPresence,
  type CapabilitySnapshot,
} from '@/features/capabilities';

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
  };
}
