import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionCapabilityFacts } from '@/app/useSessionCapabilityFacts';
import { collectContextSignals } from '@/app/contextSignals';
import { collectWorkSignals } from '@/app/workSignals';
import {
  resolveCapsuleCapabilities,
  type CapsuleCapabilityContribution,
  type CapsuleCapabilityInput,
} from '@/app/capsulePresence';
import { CAPSULE_PROJECTION_IDS, projectionBindingFor } from '@/app/capsuleProjections';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import {
  resolveCapabilityPresences,
  resolveCapabilityProjection,
  type CapabilityDisclosureEntry,
  type CapabilityFacts,
  type CapabilityId,
} from '@/product/capability';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';
import type { SensedCapabilityItem } from '@/product/capability/components/ContextDisclosureMenu';

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
  // Which capabilities the same facts sense as *working* (#1347 SC-34): their
  // ambient representation is the Work Ring, so the observed-command path must
  // not also materialize a Signal for them. One observation, one spontaneous
  // representation — the user's choice still emerges whatever it names.
  const working = collectWorkSignals(facts)
    .filter((signal) => signal.status === 'working')
    .map((signal) => signal.capabilityId);
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
    working,
  });

  /**
   * Choosing a capability emerges it beside the capsule.
   *
   * **There is no path from here to the Workspace** (#1046). This used to fall
   * back to `onToolChange` + `onSurfaceChange` for anything without a
   * projection, which made the entry a shortcut into the Workspace and is the
   * behaviour the requirement removes: selecting a capsule item must not change
   * surface. That fallback is gone rather than guarded, because the entry can
   * no longer offer a capability without a Terminal depth — `CAPSULE_ENTRY_IDS`
   * decides what reaches `choose` at all, so the branch it guarded is
   * unreachable by construction rather than by care.
   */
  const choose = useCallback(
    (id: CapabilityId) => {
      setEmergence((current) => ({
        chosen: id,
        opened: false,
        // Choosing it again is how a dismissal is undone — otherwise there
        // would be no way back to a Signal the user closed.
        dismissed: current.dismissed.filter((candidate) => candidate !== id),
      }));
    },
    // No `input`: the fallback into the Workspace was the only thing this read
    // from it, and the entry can no longer offer a capability that would need
    // it. A dependency kept "just in case" is one that re-creates the callback
    // for reasons the callback does not have.
    [],
  );

  /**
   * Choose at Peek depth (#1347 SC-20): a sensed row in the Context Disclosure opens Peek.
   *
   * Same as `choose` but sets `opened: true` so the capability emerges at Peek
   * depth instead of Signal. Used by the Context Disclosure's sensed rows (SC-20).
   */
  const chooseAtPeek = useCallback(
    (id: CapabilityId) => {
      setEmergence((current) => ({
        chosen: id,
        opened: true,
        dismissed: current.dismissed.filter((candidate) => candidate !== id),
      }));
    },
    [],
  );

  /**
   * Deepening acts on the projection that is on screen, so the id is bound in
   * by the caller rather than read from `chosen`. A projection can also emerge
   * from the observed-command path — a capability the Session is running right
   * now — where `chosen` is null because the user never chose anything, and
   * reading `chosen` there deepened nothing (#1165).
   */
  const onDeeper = useCallback((id: CapabilityId) => {
    setEmergence((current) => ({ ...current, chosen: id, opened: true }));
  }, []);

  /**
   * Dismissal steps back one level, then out.
   *
   * Peek closes to the Signal it came from — closing a detail view should not
   * also destroy the indication that made it worth opening — and closing the
   * Signal returns to Dormant, recording the dismissal so the observed-command
   * path does not immediately re-emerge what the user just closed.
   *
   * The id is the projection actually on screen, not `current.chosen`. The two
   * differ exactly when the projection emerged from the observed-command path:
   * `chosen` is null there, so recording it put nothing into `dismissed` and
   * the next render re-emerged the same Signal — the ✕ fired and was undone in
   * the same frame, which is indistinguishable from a dead button (#1165).
   */
  const onDismiss = useCallback((id: CapabilityId) => {
    setEmergence((current) => {
      if (current.opened) {
        return { ...current, opened: false };
      }
      return {
        chosen: current.chosen === id ? null : current.chosen,
        opened: false,
        dismissed: current.dismissed.includes(id)
          ? current.dismissed
          : [...current.dismissed, id],
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
        ? {
            disclosure: {
              entries: resolution.entries,
              onSelect: choose,
              onSelectAtPeek: chooseAtPeek,
              sensedContext: resolveSensedContext(
                resolution.entries,
                {
                  sessionId: input.session?.session_id,
                  experience: input.experience,
                },
              ),
            },
          }
        : {},
    projection:
      active && binding
        ? {
            id: active.capabilityId,
            title: resolution.titleFor(active.capabilityId),
            depth: active.depth,
            // Absent when the capability declared it has no Peek: the frame
            // reads that as an inert title rather than a step into nothing.
            onDeeper: binding.entry === 'peek'
              ? () => onDeeper(active.capabilityId)
              : undefined,
            // The capability's own answer to "does this take the keyboard while
            // it is up", copied through untouched. The capsule reacts to the
            // boolean; only the capability knows which projections need it.
            ownsInputFocus: binding.ownsInputFocus,
            onDismiss: () => onDismiss(active.capabilityId),
            // The Workspace destination's presence is Nession's answer (#1347
            // SC-21), read from the Workspace view registry rather than left
            // for the body to decide: a capability with no Workspace view
            // (Terminal Keys) gets no routing at all, and the host draws no
            // destination action for it.
            onOpenWorkspace: WORKSPACE_VIEW_BINDINGS.some(
              (view) => view.id === active.capabilityId,
            )
              ? (resourceId) => input.onOpenWorkspace(active.capabilityId, resourceId)
              : undefined,
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

/**
 * Context-sensed capabilities, resolved to the disclosure's display items
 * (#1347 SC-37/40).
 *
 * The same shape as the work-sensed items the capsule builds from
 * `workContext`: a signal says *which* capability and *why*, and its display
 * identity comes from the disclosure entries — a sensed item with no entry is
 * dropped rather than shown as a raw id, exactly as the work half does.
 */
function resolveSensedContext(
  entries: readonly CapabilityDisclosureEntry[],
  context: { sessionId?: string; experience?: 'web' | 'app' },
): SensedCapabilityItem[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return collectContextSignals(context).flatMap((signal) => {
    const entry = byId.get(signal.capabilityId);
    return entry
      ? [
          {
            capabilityId: signal.capabilityId,
            title: entry.title,
            reason: signal.summary,
          },
        ]
      : [];
  });
}
