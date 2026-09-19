import type { CapabilityId, CapabilitySnapshot } from './model';
import type { CapabilityPresence } from './presence';

/**
 * How much of a capability is on screen.
 *
 * A second axis, deliberately not folded into `CapabilityState`. Lifecycle
 * answers "does this capability exist and matter here?"; depth answers "how much
 * of it is Nession showing?". A capability can be `active` while showing only a
 * Signal, or merely `relevant` and opened all the way to Workspace — collapsing
 * the two into one enum cannot express either sentence
 * (`docs/design/capability-emergence.md`).
 */
export type DisclosureDepth = 'dormant' | 'signal' | 'peek' | 'workspace';

/** A projection the Terminal is showing, adjacent to the capsule. */
export interface CapabilityProjection {
  capabilityId: CapabilityId;
  /** Terminal-side depths only. Reaching Workspace is the surface change, not a depth here. */
  depth: 'signal' | 'peek';
}

export interface EmergenceInput {
  snapshots: readonly CapabilitySnapshot[];
  presences: readonly CapabilityPresence[];
  /**
   * Capabilities that can be *shown* at Terminal depth.
   *
   * Required, and deliberately not defaulted to "all". A capability with no
   * Terminal projection has nowhere to appear — it deepens straight from the
   * entry to Workspace — so emerging one produces a projection nothing can
   * render, and the capability is swallowed with no visible symptom. An
   * unsafe default would reproduce exactly that bug on the next caller.
   */
  projectable: readonly CapabilityId[];
  /** The capability the user chose in the capability entry, if any. */
  chosen?: CapabilityId | null;
  /** Whether the chosen capability has been opened past its Signal. */
  opened?: boolean;
  /**
   * Capabilities the user has dismissed. Needed because the observed-command
   * path would otherwise re-emerge the same Signal on the next render — a
   * dismissal that undoes itself is not a dismissal.
   */
  dismissed?: readonly CapabilityId[];
}

/**
 * At most one capability projection, and which one (Q1 + Q2).
 *
 * **Nothing emerges on its own except what the Session is observed running.**
 * There is no relevance score and no decay timer, because setting a threshold
 * needs data this project does not have yet, and a threshold picked by feel is
 * how a surface ends up "a row of buttons that explains itself afterwards".
 * The two inputs are the user choosing a capability, and `active` — the pane is
 * running it right now. `relevant` ("ran it earlier") stays in the capability
 * entry.
 *
 * **One at a time.** Order is the deterministic tie-break the rest of the
 * capability layer already uses: the chosen one wins, then registration order.
 * No priority numbers — they would be a second, weaker copy of a decision the
 * registry already made.
 */
export function resolveCapabilityProjection({
  snapshots,
  presences,
  projectable,
  chosen,
  opened = false,
  dismissed = [],
}: EmergenceInput): CapabilityProjection | undefined {
  const shown = new Set(
    presences.filter((presence) => presence.level !== 'hidden').map((presence) => presence.capabilityId),
  );
  const canEmerge = (id: CapabilityId) => shown.has(id) && projectable.includes(id);

  if (chosen && canEmerge(chosen)) {
    return { capabilityId: chosen, depth: opened ? 'peek' : 'signal' };
  }

  const dismissedSet = new Set(dismissed);
  const running = snapshots.find(
    (snapshot) => snapshot.state === 'active' && canEmerge(snapshot.id) && !dismissedSet.has(snapshot.id),
  );

  return running ? { capabilityId: running.id, depth: 'signal' } : undefined;
}
