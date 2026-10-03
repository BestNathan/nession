import { useRef } from 'react';
import {
  capsuleExchangeStyle,
  useCapsuleExchange,
} from '@/platform/motion/capsuleExchange';
import { resolveCapabilityPresences, type CapabilityId } from '@/product/capability';
import { cn } from '@/shared/lib/utils';
import { useWorkspaceCapsuleClearance } from '@/app/workspace/hooks/useWorkspaceCapsuleClearance';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import {
  buildWorkspacePresentationModel,
  type WorkspacePresentationItem,
  type WorkspacePresentationModel,
} from '@/app/workspace/presentation';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type {
  WorkspaceContext,
  WorkspaceDepthControl,
  WorkspaceViewBinding,
} from '@/app/workspace/workspaceContext';
import { CapabilityCapsule } from '@/app/workspace/CapabilityCapsule';
import { capsuleZoneAppClass, capsuleZoneClass } from '@/product/terminal/capsule/CapsuleZone';

const workspaceViewBindings = new Map<string, WorkspaceViewBinding>(
  WORKSPACE_VIEW_BINDINGS.map((view) => [view.id, view]),
);

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeCapabilityId: CapabilityId;
  /**
   * How the App half of a view declares the depth it is showing (#1051). The
   * App composes its views with one — its navigation bar is per depth — while
   * Web's pane has no depth to declare.
   *
   * Defaulted rather than required so a Web-only composition (the canonical
   * fixture) does not have to invent one. The App's composition always passes
   * its own, and an App view cannot render without it.
   */
  depth?: WorkspaceDepthControl;
  /**
   * Whether the open view has pushed a depth over its capability root. Gates
   * the dock, which belongs to the root — see `showDock` below.
   */
  pushed?: boolean;
  /**
   * The Web's "Open Terminal" destination action (#1204), composed beside the
   * capability dock. It is *surface* navigation, not a capability: it stays
   * when `pushed` hides the dock, and it never becomes a dock entry. Rendered
   * for the Web experience only — the App leaves a Workspace depth through its
   * page header's Back.
   */
  surfaceAction?: React.ReactNode;
}

/**
 * The depth control a composition with no navigation hierarchy passes.
 *
 * Nothing can usefully call it: a Web view has no App bar to declare a depth
 * to. It exists so the prop can be defaulted without making it possibly
 * `undefined` at the point an App view is rendered.
 */
const NO_DEPTH_CONTROL: WorkspaceDepthControl = { setPush: () => undefined };

function bindingFor(item: WorkspacePresentationItem): WorkspaceViewBinding | undefined {
  return workspaceViewBindings.get(item.snapshot.id);
}

/**
 * The capsule row: every capability that holds a slot, in registration order.
 *
 * Membership comes from the presentation model (which groups a capability's
 * slot by presence); placement comes from the binding registry, so the row
 * never reorders itself around the open capability (see the call site).
 */
function resolveCapsuleItems(
  presentation: WorkspacePresentationModel,
): WorkspacePresentationItem[] {
  const itemById = new Map(
    [...presentation.direct, ...presentation.discoverable, ...presentation.unavailable]
      .filter(bindingFor)
      .map((item) => [item.snapshot.id, item]),
  );
  return WORKSPACE_VIEW_BINDINGS.flatMap((view) => {
    const item = itemById.get(view.id);
    return item ? [item] : [];
  });
}


/**
 * Surface navigation (#1204): the destination action's own `nav`, adjacent to
 * — never merged into — the capability dock's.
 */
function SurfaceNavigation({ children }: { children: React.ReactNode }) {
  return (
    <nav
      aria-label="Surface navigation"
      data-testid="workspace-surface-navigation"
      className="pointer-events-auto"
    >
      {children}
    </nav>
  );
}

/**
 * What the Workspace shows when the open capability has no view to draw.
 *
 * Both experiences answer "nothing" the same way, so the answer is named once
 * and reached from both halves of the branch below rather than written out on
 * each side of it.
 */
function UnavailableCapability({ title }: { title: string }) {
  return (
    <div
      data-testid="workspace-capability-unavailable"
      className="flex h-full min-h-0 items-center justify-center px-6 text-center"
    >
      <div className="max-w-sm space-y-1.5">
        <p className={cn('text-foreground', chromeSansRole('primary'))}>{title} is not available here</p>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          Choose another capability from More. Nession will keep this view stable instead of switching automatically.
        </p>
      </div>
    </div>
  );
}

/**
 * Workspace framework: semantic capabilities resolve first, then a bounded
 * Nession-owned presentation model decides what earns direct presence and what
 * stays progressively discoverable through More.
 */
export function WorkspaceShell({
  ctx,
  activeCapabilityId,
  depth = NO_DEPTH_CONTROL,
  pushed = false,
  surfaceAction,
}: WorkspaceShellProps) {
  // SC-12: the shell is the Workspace's occlusion owner — see the hook for why
  // it measures the tool bar rather than the Terminal's composer.
  const shellRef = useRef<HTMLDivElement>(null);
  useWorkspaceCapsuleClearance(shellRef);

  // The App's capsule handoff, incoming half: while the swipe carries this
  // layer in, the Capability Form arrives slightly behind the finger's pace
  // and settles into the slot the Conversation form is leaving. X-only and
  // endpoint-inert, so a settled Workspace carries no style and
  // `useWorkspaceCapsuleClearance`'s vertical measurement is untouched.
  const exchange = useCapsuleExchange();
  const exchangeStyle = capsuleExchangeStyle(exchange, 'arriving');

  const resolution = resolveWorkspaceCapabilities(ctx);
  const presences = resolveCapabilityPresences(resolution.snapshots, {
    surface: 'workspace',
  });
  const presentation = buildWorkspacePresentationModel({
    snapshots: resolution.snapshots,
    presences,
    openedCapabilityId: activeCapabilityId,
  });

  const openedPresence = presentation.opened?.presence;
  const activeBinding = workspaceViewBindings.get(activeCapabilityId);
  const canRenderActive = activeBinding && openedPresence?.level !== 'hidden';
  // The two experiences' view props differ by construction (#1051): the App's
  // composition gives every view a depth control, Web's gives none. Branched
  // here rather than widened into one optional prop, so a Web view cannot be
  // handed the App's navigation and a new App view cannot silently go without it.
  const ActiveAppLayout = canRenderActive ? activeBinding.layout.app : null;
  const ActiveWebLayout = canRenderActive ? activeBinding.layout.web : null;
  // A view binding carries no name of its own — the capability does, so the
  // unavailable-state copy reads the same title the navigation shows.
  const activeTitle =
    resolution.snapshots.find((snapshot) => snapshot.id === activeCapabilityId)?.title ??
    activeCapabilityId;

  // Capsule V2 (#1347): Workspace capsule shows ALL capabilities (scrollable) —
  // the reciprocal of Terminal, which shows only the active capability.
  //
  // The row renders **registration order**, and the open capability is only
  // *marked* (selected state + dot), never moved. The owner's follow-up settled
  // this: activation is not placement, so the entry under the thumb stays where
  // it was and a row does not reshuffle itself as the work changes. The
  // presentation model still decides *membership* (which capabilities hold
  // slots at all); placement here is the binding registry's own order.
  const allCapsuleItems = resolveCapsuleItems(presentation);
  const hasNavigation = allCapsuleItems.length > 0;
  // `#1051`: the dock is the *capability root's* switcher. A pushed detail has
  // its own page and its own Back, so a global capability switcher over it would
  // be a second navigation owner answering to a depth it does not belong to.
  const showDock = hasNavigation && !pushed;
  // `#1204`: the surface-leave action answers to a different axis than the
  // dock — a pushed depth hides *capability* navigation, never the route back
  // to the peer surface. Web only; the App's leave is its page header's Back.
  const showSurfaceAction = ctx.experience === 'web' && surfaceAction !== undefined;

  return (
    <div
      ref={shellRef}
      data-testid="workspace-shell"
      data-capability-diagnostics={resolution.diagnostics.length}
      /* The Workspace region's ground is the canvas, not a tint of it.
         The muted fill at 40% resolved to #F9F9F8 — a value that exists nowhere
         in the mockup, which draws the work region on its canvas (#FFFFFF) and
         separates the tree from the editor with the chrome surface (#F6F8FA) on
         the tree side only, which the Files layout already supplies. The domain
         `workspace.background` leaf is the canonical token for precisely this
         ground (domain.json -> `semantic.background`; file-workspace.md's token
         table names "Workspace/File surfaces -> Domain workspace.*"), and it was
         declared and consumed by nothing until here. */
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-workspace-background"
    >
      {/* `flex flex-col` so the region constrains its single view instead of
          letting it size to its content: a view built as `flex-1 min-h-0`
          (AgentDetail, GitWorkspace) is a flex item here, and without the
          container a tall view overflowed the region — clipped by
          `overflow-hidden`, with no scroll to reach its end, which is the
          thing SC-12 assumes can always happen. */}
      <div data-testid="workspace-tool-content" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {ctx.experience === 'app' ? (
          ActiveAppLayout ? (
            <ActiveAppLayout ctx={ctx} depth={depth} />
          ) : (
            <UnavailableCapability title={activeTitle} />
          )
        ) : ActiveWebLayout ? (
          <ActiveWebLayout ctx={ctx} />
        ) : (
          <UnavailableCapability title={activeTitle} />
        )}
      </div>

      {showDock || showSurfaceAction ? (
        /* Capsule V2 (#1347): Reciprocal layout — circle left, capsule right.
           Surface navigation (Terminal destination) on the left; capability
           capsule on the right. This is the reciprocal of Terminal's layout
           (capsule left, circle right). Both share the same transparent bottom
           Capsule Zone (SC-09, SC-10). */
        <div
          data-testid="workspace-tool-bar"
          data-navigation-mode="contextual"
          data-capsule-exchange={exchangeStyle ? 'arriving' : undefined}
          style={exchangeStyle}
          className={cn(
            // #1347 SC-08 / SC-29: on App the zone sits where the Conversation
            // capsule does (the App dock placement); on Web it keeps the shared
            // zone's own bottom offset.
            ctx.experience === 'app' ? capsuleZoneAppClass : capsuleZoneClass,
            'gap-[length:var(--shell-space-2)]',
          )}
        >
          {showSurfaceAction ? <SurfaceNavigation>{surfaceAction}</SurfaceNavigation> : null}
          {showDock ? (
            <CapabilityCapsule
              items={allCapsuleItems}
              activeCapabilityId={activeCapabilityId}
              onSelect={ctx.onToolChange}
              experience={ctx.experience}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
