import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { AppLayerSlab } from './AppLayerSlab';
import { AppPopupPortal } from './AppPopupPortal';
import { destinationName } from './appDestinationName';
import { SwipeDestinationPreview } from './SwipeDestinationPreview';
import {
  AppInnerStackMotionContext,
  type AppInnerStackMotion,
} from '@/app/workspace/appInnerStackMotion';
import type { WorkspaceStackReport } from '@/app/workspace/workspaceContext';
import {
  CapsuleExchangeContext,
  type CapsuleExchange,
} from '@/platform/motion/capsuleExchange';
import {
  indexFromLayer,
  layerFromIndex,
  layerGeometry,
  type AppLayer,
} from './appLayerPositions';
import { EDGE_PLATFORM_GUARD_PX } from './gesture';
import { useAppShellWidth } from './useAppShellWidth';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { useShellBounds } from './useShellBounds';
import { useSwipePager } from './useSwipePager';
import type { SwipePhase } from './swipeGesture';

export type { AppLayer };

export interface AppLayersProps {
  layer: AppLayer;
  onLayerChange: (layer: AppLayer) => void;
  sessions: ReactNode;
  terminal: ReactNode;
  /**
   * The Workspace layer, or `null` when there is nothing for it to show (#1082:
   * Workspace is Session-scoped, so it does not exist before a Session does).
   *
   * `null` is not an empty node. It removes the layer from the pager as well as
   * from the DOM, which is what stops a leftward drag from pulling an empty
   * depth over the home — the alternative, rendering an empty Workspace, would
   * answer the gesture with a blank screen.
   */
  workspace: ReactNode | null;
  /**
   * Whether a Workspace capability has pushed a detail depth (#1081).
   *
   * A pushed detail has its own leave — the page header's Back — and the shell
   * must not offer a second one for the same depth (#1051). That is not
   * bookkeeping: `FilesAppLayout`'s Back is dirty-aware and refuses an unsaved
   * editor, while the shell's leave cannot, so a shell page from there discards
   * work the capability was guarding.
   */
  workspaceDetailPushed: boolean;
  /**
   * The active Workspace inner stack (#3971), reported by the capability
   * through `WorkspacePanel`. The pager is the single coordinator: a claimed
   * contact pops one valid depth on a right swipe and moves forward only to a
   * recorded destination on a left swipe, before the outer spatial pager.
   */
  workspaceStack?: WorkspaceStackReport | null;
}

/**
 * Which of the two optional layers may render.
 *
 * At rest this is the geometry's own answer. While a contact is owned, only
 * the current layer and the frozen destination may render: the three-slot
 * geometry would otherwise slide the far-side neighbour into view — moving
 * Workspace right to reveal the Terminal reaches the Sessions position at
 * exactly one shell width, although Sessions is not a destination. The same
 * gating keeps the leaving layer mounted while it settles off-screen.
 */
interface LayerSlot {
  layer: AppLayer;
  index: number;
}

const SESSIONS_SLOT: LayerSlot = { layer: 'sessions', index: 0 };
const WORKSPACE_SLOT: LayerSlot = { layer: 'workspace', index: 2 };

interface LayerVisibility {
  phase: SwipePhase;
  isOpen: boolean;
  current: AppLayer;
  slot: LayerSlot;
  destinationIndex: number | null;
}

function shouldRenderLayer({
  phase,
  isOpen,
  current,
  slot,
  destinationIndex,
}: LayerVisibility): boolean {
  if (phase === 'idle' || phase === 'candidate' || phase === 'content') {
    return isOpen;
  }
  if (destinationIndex === null) {
    return current === slot.layer;
  }
  return current === slot.layer || destinationIndex === slot.index;
}

function innerStackMotion(
  action: AppInnerStackMotion['action'],
  offset: number,
  settling: boolean,
): AppInnerStackMotion {
  return { action, offset, settling };
}

function capsuleExchangeFor(
  workspace: ReactNode | null,
  workspaceX: number,
  width: number,
): CapsuleExchange | null {
  if (workspace === null) {
    return null;
  }
  return { progress: Math.min(1, Math.max(0, 1 - workspaceX / width)) };
}

function previewName(
  phase: SwipePhase,
  destinationLabel: string | null,
  destinationIndex: number | null,
  hasWorkspace: boolean,
): string | null {
  if (phase !== 'navigation') {
    return null;
  }
  return destinationLabel ?? destinationName(destinationIndex, hasWorkspace);
}

/**
 * The App's navigation composition (#1049, #2724).
 *
 * Terminal is the root work surface and stays mounted for the whole life of a
 * selected Session — opening Sessions or Workspace slides a layer over it
 * rather than moving the Terminal off-screen, so xterm, the attach state and
 * the scrollback are never rebuilt by a navigation event. That is the
 * acceptance criterion this shape exists to satisfy.
 *
 * #2724 gives the gesture an in-flight state: once the shell claims a
 * horizontal drag, a transient destination label and a shadow on the moving
 * layer are the only chrome it adds, and both disappear when the contact ends.
 * At rest there is no swipe tutorial, edge rail or navigation overlay — the
 * header's visible Sessions/Workspace controls remain the discoverable path.
 */
export function AppLayers({
  layer,
  onLayerChange,
  sessions,
  terminal,
  workspace,
  workspaceDetailPushed,
  workspaceStack = null,
}: AppLayersProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useAppShellWidth(rootRef);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const handleIndexChange = useCallback(
    (next: number) => onLayerChange(layerFromIndex(next)),
    [onLayerChange],
  );

  const getShellBounds = useShellBounds(rootRef);

  const {
    dragOffset,
    phase,
    destinationIndex,
    innerAction,
    innerOffset,
    innerSettling,
    destinationLabel,
    direction,
    lastReason,
  } = useSwipePager({
      // Two positions before a Session exists, three after (#1082). The pager
      // already refuses to commit past `pageCount`, so this is what makes the
      // leftward drag a no-op rather than a page onto nothing.
      pageCount: workspace === null ? 2 : 3,
      index: indexFromLayer(layer),
      onIndexChange: handleIndexChange,
      getShellBounds,
      // A pushed Workspace detail is a depth with its own leave, and the shell
      // stands down rather than offering a second one (#1081). #3971 routes
      // that same contact to the capability's inner stack instead of inventing
      // a second gesture owner: right swipes pop, left swipes only forward to a
      // recorded destination, and the capability's guard decides the leave.
      shellMayPage: !(layer === 'workspace' && workspaceDetailPushed),
      innerStack: layer === 'workspace' ? workspaceStack : null,
      rootRef,
    });

  const { sessionsX, workspaceX, showSessions, showWorkspace } =
    layerGeometry(layer, dragOffset, width);

  const settling = phase === 'settling';
  const renderSessions = shouldRenderLayer({
    phase,
    isOpen: showSessions,
    current: layer,
    slot: SESSIONS_SLOT,
    destinationIndex,
  });
  const renderWorkspace = workspace !== null && shouldRenderLayer({
    phase,
    isOpen: showWorkspace,
    current: layer,
    slot: WORKSPACE_SLOT,
    destinationIndex,
  });
  const moving = phase === 'navigation' || phase === 'resisting';
  const transition = settling && !reducedMotion
    ? 'transform var(--nession-motion-shell-duration) var(--nession-motion-shell-ease)'
    : undefined;

  // The capsule handoff fraction: how far the drag has carried the Workspace
  // slab over the Terminal, 0 (Terminal owns the slot) to 1 (Workspace does).
  // Derived from the slab's own position so the capsules and the slabs cannot
  // disagree about where the finger is; `null` without a Workspace layer, and
  // the consumers treat the endpoints as "no exchange" so a resting surface
  // carries no inline style at all.
  const capsuleExchange = useMemo(
    () => capsuleExchangeFor(workspace, workspaceX, width),
    [workspace, workspaceX, width],
  );

  // The Workspace host translates only its header + content frame for an inner
  // stack move; the Capsule keeps its own geometry. The outer layer offset is
  // deliberately not reused here — that would slide the opaque Workspace layer
  // and expose the Terminal underneath.
  const innerMotion = innerStackMotion(innerAction, innerOffset, innerSettling);

  return (
    <div
      ref={rootRef}
      data-testid="app-layer-root"
      data-experience="app"
      data-layer={layer}
      data-swipe-phase={phase}
      data-swipe-destination={destinationIndex === null ? undefined : destinationIndex}
      data-swipe-inner={innerAction ?? undefined}
      data-swipe-destination-label={destinationLabel ?? undefined}
      data-swipe-reason={lastReason ?? undefined}
      data-swipe-guard-px={EDGE_PLATFORM_GUARD_PX}
      data-workspace-stack-pop={layer === 'workspace' ? (workspaceStack?.pop?.title ?? undefined) : undefined}
      data-workspace-stack-forward={layer === 'workspace' ? (workspaceStack?.forward?.title ?? undefined) : undefined}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Every layer is inside the App's popup container, so a menu opened from
          any of them is mounted into a node that states `data-experience="app"`
          — the scope this element opens, which a popup on `<body>` would
          otherwise leave (#1066). */}
      <AppPopupPortal>
        <CapsuleExchangeContext.Provider value={capsuleExchange}>
        <div
          data-testid="app-layer-terminal"
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {terminal}
        </div>

        {renderSessions && (
          <AppLayerSlab
            testId="app-layer-sessions"
            x={sessionsX}
            moving={moving}
            transition={transition}
          >
            {sessions}
          </AppLayerSlab>
        )}

        {renderWorkspace && (
          <AppInnerStackMotionContext.Provider value={innerMotion}>
            <AppLayerSlab
              testId="app-layer-workspace"
              x={workspaceX}
              moving={moving}
              transition={transition}
            >
              {workspace}
            </AppLayerSlab>
          </AppInnerStackMotionContext.Provider>
        )}

        <SwipeDestinationPreview
          name={previewName(phase, destinationLabel, destinationIndex, workspace !== null)}
          direction={direction}
        />
        </CapsuleExchangeContext.Provider>
      </AppPopupPortal>
    </div>
  );
}
