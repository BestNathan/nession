import type {
  CapabilityId,
  CapabilityPresence,
  CapabilitySnapshot,
} from '@/product/capability';

export interface WorkspacePresentationItem {
  snapshot: CapabilitySnapshot;
  presence: CapabilityPresence;
}

export interface WorkspacePresentationModel {
  /** The explicitly opened capability, even when it has become hidden/unavailable. */
  opened?: WorkspacePresentationItem;
  /**
   * Every lifecycle-visible capability that has a Workspace view, in registry order.
   *
   * Workspace no longer has a second disclosure owner. #1347 retired the old
   * direct-slot cap / More model; the bounded Capsule row itself owns overflow
   * through horizontal scrolling.
   */
  items: WorkspacePresentationItem[];
}

export interface WorkspacePresentationInput {
  snapshots: readonly CapabilitySnapshot[];
  presences: readonly CapabilityPresence[];
  openedCapabilityId?: CapabilityId | null;
  /** Capability ids that have a concrete Workspace view binding. */
  viewBoundCapabilityIds: ReadonlySet<CapabilityId>;
}

/**
 * Nession-owned Workspace presentation policy.
 *
 * Capability state is resolved upstream, then presence decides hidden vs visible.
 * Workspace adds exactly one rule: only capabilities with a Workspace view may
 * enter its navigation row. The row preserves registry order and never re-ranks,
 * caps, or partitions entries into a second disclosure path.
 */
export function buildWorkspacePresentationModel({
  snapshots,
  presences,
  openedCapabilityId,
  viewBoundCapabilityIds,
}: WorkspacePresentationInput): WorkspacePresentationModel {
  const presenceById = new Map(
    presences.map((presence) => [presence.capabilityId, presence]),
  );

  const allItems = snapshots.flatMap((snapshot) => {
    const presence = presenceById.get(snapshot.id);
    return presence ? [{ snapshot, presence }] : [];
  });

  return {
    opened: openedCapabilityId
      ? allItems.find((item) => item.snapshot.id === openedCapabilityId)
      : undefined,
    items: allItems.filter(
      (item) =>
        item.presence.level !== 'hidden' &&
        viewBoundCapabilityIds.has(item.snapshot.id),
    ),
  };
}
