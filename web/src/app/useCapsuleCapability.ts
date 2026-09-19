import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionCapabilityFacts } from '@/app/useSessionCapabilityFacts';
import {
  resolveCapsuleCapabilities,
  type CapsuleCapabilityContribution,
  type CapsuleCapabilityInput,
} from '@/app/capsulePresence';
import { CAPSULE_PROJECTION_IDS, projectionBindingFor } from '@/app/capsuleProjections';
import {
  resolveCapabilityPresences,
  resolveCapabilityProjection,
  type CapabilityFacts,
  type CapabilityId,
} from '@/product/capability';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

export interface CapsuleCapability {
  facts: CapabilityFacts | undefined;
  capabilities: CapsuleCapabilityContribution;
  /** The capability emerging beside the capsule, if Nession decided one should. */
  projection: CapsuleCapabilityProjection | undefined;
}

interface EmergenceState {
  chosen: CapabilityId | null;
  opened: boolean;
  dismissed: readonly CapabilityId[];
}

const DORMANT: EmergenceState = { chosen: null, opened: false, dismissed: [] };

/**
 * Observe the session once, then resolve both of the capsule's contributions.
 *
 * The Workspace panel and the capsule read the same observations, so they are
 * made here instead of twice: a capability cannot be active in the capsule and
 * absent in the Workspace for the same session.
 *
 * ## Why the emergence state lives here
 *
 * Disclosure depth is Session-scoped (Q3): it follows the Session, and a
 * Session change returns the Terminal to Dormant. Keeping it beside the
 * observations is what makes that reset one line instead of a subscription —
 * and it is why this is a hook and not an atom, since nothing outside the
 * shell's own composition reads it.
 */
export function useCapsuleCapability(
  input: Omit<CapsuleCapabilityInput, 'facts'>,
): CapsuleCapability {
  const facts = useSessionCapabilityFacts(input.session);
  const sessionId = input.session?.session_id ?? null;

  const [emergence, setEmergence] = useState<EmergenceState>(DORMANT);
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      // Q1's decay: a projection belongs to the Session that produced it, so a
      // new Session starts Dormant rather than inheriting the old one's.
      setEmergence(DORMANT);
    }
  }, [sessionId]);

  const resolution = resolveCapsuleCapabilities({ ...input, facts });
  const presences = resolveCapabilityPresences(resolution.snapshots, { surface: 'capsule' });
  const active = resolveCapabilityProjection({
    snapshots: resolution.snapshots,
    presences,
    // Only a capability that can be drawn may emerge. One without a Terminal
    // projection deepens straight to Workspace, and emerging it here would
    // select a depth nothing renders — the capability would vanish silently.
    projectable: CAPSULE_PROJECTION_IDS,
    chosen: emergence.chosen,
    opened: emergence.opened,
    dismissed: emergence.dismissed,
  });

  /**
   * Choosing a capability deepens it to the shallowest depth it supports.
   *
   * A capability with a Terminal projection emerges beside the capsule; one
   * without goes straight to its Workspace view, which is what the entry has
   * always done. The difference is the capability's, not the entry's.
   */
  const choose = useCallback(
    (id: CapabilityId) => {
      if (!projectionBindingFor(id)) {
        input.onToolChange(id);
        input.onSurfaceChange();
        return;
      }
      setEmergence((current) => ({
        chosen: id,
        opened: false,
        // Choosing it again is how a dismissal is undone — otherwise there
        // would be no way back to a Signal the user closed.
        dismissed: current.dismissed.filter((candidate) => candidate !== id),
      }));
    },
    [input],
  );

  const onDeeper = useCallback(() => {
    setEmergence((current) => ({ ...current, opened: true }));
  }, []);

  /**
   * Dismissal steps back one level, then out.
   *
   * Peek closes to the Signal it came from — closing a detail view should not
   * also destroy the indication that made it worth opening — and closing the
   * Signal returns to Dormant, recording the dismissal so the observed-command
   * path does not immediately re-emerge what the user just closed.
   */
  const onDismiss = useCallback(() => {
    setEmergence((current) => {
      if (current.opened) {
        return { ...current, opened: false };
      }
      const id = current.chosen;
      return {
        chosen: null,
        opened: false,
        dismissed: id && !current.dismissed.includes(id) ? [...current.dismissed, id] : current.dismissed,
      };
    });
  }, []);

  const binding = active ? projectionBindingFor(active.capabilityId) : undefined;
  const stateOf = (id: CapabilityId) =>
    resolution.snapshots.find((snapshot) => snapshot.id === id)?.state ?? 'available';

  return {
    facts,
    capabilities:
      resolution.entries.length > 0
        ? { disclosure: { entries: resolution.entries, onSelect: choose } }
        : {},
    projection:
      active && binding
        ? {
            id: active.capabilityId,
            title: resolution.titleFor(active.capabilityId),
            depth: active.depth,
            // Absent when the capability declared it has no Peek: the frame
            // reads that as an inert title rather than a step into nothing.
            onDeeper: binding.supportsPeek ? onDeeper : undefined,
            onDismiss,
            onOpenWorkspace: (resourceId) =>
              input.onOpenWorkspace(active.capabilityId, resourceId),
            // The body reports what the user picked; the frame holds it and
            // hands it to `onOpenWorkspace`, so the handoff carries the item
            // that caused it without the body knowing where it is going.
            body: (_focus, setFocus, actions) =>
              binding.body({
                ...actions,
                agentId: input.agent?.agent_id,
                sessionId: input.session?.session_id,
                depth: active.depth,
                // The state the registry resolved, read back rather than
                // re-derived — one decision, one place.
                state: stateOf(active.capabilityId),
                onFocusChange: setFocus,
              }),
          }
        : undefined,
  };
}
