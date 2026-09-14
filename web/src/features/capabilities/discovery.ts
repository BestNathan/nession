import type { CapabilityId } from './model';
import type { CapabilityPresence, CapabilityPresenceLevel } from './presence';

/**
 * Presence levels that can hold a direct slot when the surface has room.
 *
 * `discoverable` is deliberately absent: a capability earns a slot by being
 * relevant or active, never by being registered or installed.
 */
const DIRECT_LEVELS: readonly CapabilityPresenceLevel[] = ['prominent', 'contextual'];

const LEVEL_RANK: Record<CapabilityPresenceLevel, number> = {
  hidden: 0,
  discoverable: 1,
  contextual: 2,
  prominent: 3,
};

export interface CapabilityDisclosureOptions {
  /**
   * How many capabilities may hold direct presence on this surface. The number
   * is the surface's own policy; the rule that produces it is not.
   */
  directLimit: number;
  /**
   * Capabilities the surface has already opened. They keep a slot ahead of
   * stronger candidates, so opening a view never loses its own chrome.
   */
  pinned?: readonly CapabilityId[];
}

/** Every presence, sorted into exactly one bucket. */
export interface CapabilityDisclosure {
  /** Earned a direct slot, best first. */
  direct: CapabilityPresence[];
  /** Visible, but reachable only through explicit disclosure. */
  discoverable: CapabilityPresence[];
  /** Earned no presence on this surface at all. */
  hidden: CapabilityPresence[];
}

/**
 * The single source of "what may take a slot, what must be disclosed, what is
 * absent" for every surface.
 *
 * Surfaces differ in how many slots they have and what they pin — not in the
 * rule. Workspace, capsule, and any surface added later read this one function,
 * so a new surface cannot quietly invent a second discovery policy.
 */
export function resolveCapabilityDisclosure(
  presences: readonly CapabilityPresence[],
  options: CapabilityDisclosureOptions,
): CapabilityDisclosure {
  const limit = Math.max(0, options.directLimit);
  const pinned = new Set(options.pinned ?? []);
  const visible = presences.filter((presence) => presence.level !== 'hidden');

  const direct = visible
    .filter(
      (presence) =>
        pinned.has(presence.capabilityId) || DIRECT_LEVELS.includes(presence.level),
    )
    .sort(
      (a, b) =>
        Number(pinned.has(b.capabilityId)) - Number(pinned.has(a.capabilityId))
        || LEVEL_RANK[b.level] - LEVEL_RANK[a.level],
    )
    .slice(0, limit);

  const directIds = new Set(direct.map((presence) => presence.capabilityId));

  return {
    direct,
    discoverable: visible.filter((presence) => !directIds.has(presence.capabilityId)),
    hidden: presences.filter((presence) => presence.level === 'hidden'),
  };
}
