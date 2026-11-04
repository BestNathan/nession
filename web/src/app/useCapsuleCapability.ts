import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionCapabilityFacts } from '@/app/useSessionCapabilityFacts';
import { collectContextSignals } from '@/app/contextSignals';
import {
  resolveCapsuleCapabilities,
  type CapsuleCapabilityContribution,
  type CapsuleCapabilityInput,
} from '@/app/capsulePresence';
import { projectionBindingFor } from '@/app/capsuleProjections';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import {
  resolveCapabilityPresences,
  resolveCapabilityProjection,
  type CapabilityFacts,
  type CapabilityId,
} from '@/product/capability';
import type {
  CapsuleCapabilityEntry,
  CapsuleCapabilityProjection,
  SensedCapabilityItem,
} from '@/product/terminal/capsule/types';

export interface CapsuleCapability {
  facts: CapabilityFacts | undefined;
  capabilities: CapsuleCapabilityContribution;
  /** The capability emerging beside the capsule, if Nession decided one should. */
  projection: CapsuleCapabilityProjection | undefined;
}

/**
 * Observe the session once, then resolve both of the capsule's contributions.
 *
 * The Workspace panel and the capsule read the same observations, so they are
 * made here instead of twice: a capability cannot be active in the capsule and
 * absent in the Workspace for the same session.
 *
 * ## Why the emergence state lives here
 *
 * The emerging capability is Session-scoped (Q3): it follows the Session, and a
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

  // Which capability is showing, and nothing else. It used to be a record
  // because depth was a second axis (`opened`) and the observed-command path
  // needed a dismissal memory (`dismissed`); with one depth and one source,
  // "which one" is the whole of the state.
  const [chosen, setChosen] = useState<CapabilityId | null>(null);
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      // Q1's decay: a projection belongs to the Session that produced it.
      setChosen(null);
    }
  }, [sessionId]);

  const resolution = resolveCapsuleCapabilities({ ...input, facts });
  const presences = resolveCapabilityPresences(resolution.snapshots, { surface: 'capsule' });
  // The capability the capsule is drawing, if any. Deliberately not named
  // `active`: that word is a `CapabilityState`, and this is a display choice.
  const shown = resolveCapabilityProjection({ presences, chosen });

  /**
   * Choosing a capability shows it. **Selecting an item is asking to look at
   * it**, and `capability-emergence.md` says so in its own words: `+` is "the
   * explicit entry for *peeking*", and a capability is "opened explicitly into
   * a Peek". With one depth there is one outcome, so the choice is the state —
   * there is no second, shallower depth for an ordinary row to land on.
   *
   * **There is still no path from here to the Workspace** (#1046). This used to
   * fall back to `onToolChange` + `onSurfaceChange` for anything without a
   * projection, which made the entry a shortcut into the Workspace and is the
   * behaviour the requirement removes: selecting a capsule item must not change
   * surface. That fallback is gone rather than guarded, because the entry can
   * no longer offer a capability without a Terminal projection —
   * `CAPSULE_PROJECTION_IDS` decides what reaches `choose` at all, so the branch it
   * guarded is unreachable by construction rather than by care. The Workspace
   * destination is where the way deeper lives, and the user takes it
   * deliberately from the projection.
   */
  const choose = useCallback((id: CapabilityId) => setChosen(id), []);

  /**
   * Dismissal closes the projection. There is no level to step back to — the
   * Signal that used to receive it is gone — and no `dismissed` list to
   * record it in, because the only path that could re-emerge something was
   * the observed-command path, which is also gone (#1165).
   */
  const onDismiss = useCallback(() => setChosen(null), []);

  const binding = shown ? projectionBindingFor(shown) : undefined;
  const stateOf = (id: CapabilityId) =>
    resolution.snapshots.find((snapshot) => snapshot.id === id)?.state ?? 'available';

  /**
   * Peer views the shown capability shares its upper slot with (#2710).
   *
   * The peers are declared by the binding and resolved here, where the
   * capability titles live; the capsule receives labels and a selection
   * callback, never ids it would have to interpret. Only peers that are
   * actually listed for this Session are offered, so a switch can never move
   * the user to a view the `+` entry would not have offered.
   */
  const peerIds = binding?.companions ?? [];
  const listedIds = new Set(resolution.entries.map((entry) => entry.id));
  const listingOrder = new Map(resolution.entries.map((entry, index) => [entry.id, index]));
  const switchableIds = shown
    ? [shown, ...peerIds.filter((id) => id !== shown && listedIds.has(id))]
        // One stable order regardless of which peer is showing: a switch whose
        // options move under the finger is a second way to get lost. The
        // capability registry's registration order is the tie-break.
        .sort((a, b) => (listingOrder.get(a) ?? 0) - (listingOrder.get(b) ?? 0))
    : [];
  const viewSwitch = shown && switchableIds.length > 1
    ? {
        options: switchableIds.map((id) => {
          const snapshot = resolution.snapshots.find((candidate) => candidate.id === id);
          return {
            id,
            label: snapshot?.shortTitle ?? snapshot?.title ?? id,
            selected: id === shown,
          };
        }),
        onSelect: choose,
      }
    : undefined;

  return {
    facts,
    capabilities:
      resolution.entries.length > 0
        ? {
            disclosure: {
              entries: resolution.entries,
              onSelect: choose,
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
      shown && binding
        ? {
            id: shown,
            title: resolution.titleFor(shown),
            // The capability's own answer to "does this take the keyboard while
            // it is up", copied through untouched.
            ownsInputFocus: binding.ownsInputFocus,
            viewSwitch,
            onDismiss,
            // The Workspace destination's presence is Nession's answer
            // (#1347 SC-21), read from the Workspace view registry rather than
            // left for the body to decide: a capability with no Workspace view
            // (Terminal Keys) gets no routing at all.
            onOpenWorkspace: WORKSPACE_VIEW_BINDINGS.some((view) => view.id === shown)
              ? (resourceId) => input.onOpenWorkspace(shown, resourceId)
              : undefined,
            // The body reports what the user picked; the frame holds it and
            // hands it to `onOpenWorkspace`.
            body: (_focus, setFocus, actions) =>
              binding.body({
                ...actions,
                agentId: input.agent?.agent_id,
                sessionId: input.session?.session_id,
                // The state the registry resolved, read back rather than
                // re-derived — one decision, one place.
                state: stateOf(shown),
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
 * identity — title and glyph together — comes from the disclosure entries; a
 * sensed item with no entry is dropped rather than shown as a raw id, exactly
 * as the work half does.
 *
 * Typed as `CapsuleCapabilityEntry`, the entry that carries the glyph, rather
 * than the icon-free `CapabilityDisclosureEntry` it extends: with the wider
 * type this function resolved the title off the entry and left the icon
 * behind, and nothing failed to compile.
 */
function resolveSensedContext(
  entries: readonly CapsuleCapabilityEntry[],
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
            // The glyph travels with the title. This was the seam: the sensed
            // row drew an empty icon column while `sensedWorkItems` copied its
            // entry's icon (measured on App, 2026-10-04). The field is required
            // now, so dropping it is a compile error rather than a silent gap.
            icon: entry.icon,
            reason: signal.summary,
          },
        ]
      : [];
  });
}
