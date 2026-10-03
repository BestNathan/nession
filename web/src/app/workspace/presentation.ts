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
  /**
   * Visible capabilities allowed into direct chrome, in registration order.
   *
   * One list, not an opened-first split: the opened capability's privilege is
   * *membership* — it keeps a direct slot even past the cap — not placement.
   * Activation is drawn on the entry (selected state), never by moving it
   * (owner follow-up, 2026-10-03).
   */
  direct: WorkspacePresentationItem[];
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
 * Every list here comes back in registration order — the disclosure resolver
 * may lead with the pinned capability, and that ordering is deliberately
 * undone, because a surface places entries by registration and marks the
 * opened one in place (owner follow-up, 2026-10-03).
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

  const registrationOrder = new Map(snapshots.map((snapshot, index) => [snapshot.id, index]));
  const direct = disclosure.direct
    .flatMap((presence) => {
      const item = itemById.get(presence.capabilityId);
      return item ? [item] : [];
    })
    .sort(
      (a, b) =>
        (registrationOrder.get(a.snapshot.id) ?? 0) - (registrationOrder.get(b.snapshot.id) ?? 0),
    );

  return {
    opened: openedCapabilityId ? itemById.get(openedCapabilityId) : undefined,
    direct,
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
