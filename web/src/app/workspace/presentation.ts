import type {
  CapabilityId,
  CapabilityPresence,
  CapabilitySnapshot,
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

function presenceRank(item: WorkspacePresentationItem): number {
  switch (item.presence.level) {
    case 'prominent':
      return 2;
    case 'contextual':
      return 1;
    default:
      return 0;
  }
}

/**
 * Nession-owned Workspace presentation policy.
 *
 * Registration order remains deterministic input, but it is not equivalent to
 * UI placement. Direct chrome is bounded and only the opened capability plus
 * contextual/prominent candidates can enter it. Everything else that is
 * visible is progressively disclosed through discovery.
 */
export function buildWorkspacePresentationModel({
  snapshots,
  presences,
  openedCapabilityId,
  directLimit = WORKSPACE_DIRECT_CAPABILITY_LIMIT,
}: WorkspacePresentationInput): WorkspacePresentationModel {
  const presenceById = new Map(
    presences.map((presence) => [presence.capabilityId, presence]),
  );

  const items = snapshots.flatMap((snapshot) => {
    const presence = presenceById.get(snapshot.id);
    return presence ? [{ snapshot, presence }] : [];
  });

  const opened = openedCapabilityId
    ? items.find((item) => item.snapshot.id === openedCapabilityId)
    : undefined;
  const visible = items.filter((item) => item.presence.level !== 'hidden');
  const limit = Math.max(0, directLimit);

  const primary = opened && opened.presence.level !== 'hidden' && limit > 0
    ? [opened]
    : [];

  const contextualCandidates = visible
    .filter(
      (item) =>
        item.snapshot.id !== openedCapabilityId &&
        (item.presence.level === 'contextual' || item.presence.level === 'prominent'),
    )
    .map((item, index) => ({ item, index }))
    .sort((a, b) => presenceRank(b.item) - presenceRank(a.item) || a.index - b.index)
    .map(({ item }) => item);

  const contextual = contextualCandidates.slice(0, Math.max(0, limit - primary.length));
  const directIds = new Set(
    [...primary, ...contextual].map((item) => item.snapshot.id),
  );
  const discoverable = visible.filter((item) => !directIds.has(item.snapshot.id));

  return {
    opened,
    primary,
    contextual,
    discoverable,
  };
}
