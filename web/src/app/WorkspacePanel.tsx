import { useEffect, useMemo } from 'react';
import { cn } from '@/shared/lib/utils';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { useAppInnerStackMotion } from '@/app/workspace/appInnerStackMotion';
import type { FileOps } from '@/capabilities/files';
import { resolveConversationIdentity } from '@/app/conversationIdentities';
import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';
import type { FocusedProject, SessionProjectContext } from '@/product/project/types';
import { AppPageHeader } from '@/app/patterns/AppPageHeader';
import type { Surface } from '@/app/patterns/SessionHeader';
import { SurfaceDestinationAction } from '@/product/workspace/patterns/SurfaceDestinationAction';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import { useWorkspaceFocusLifecycle } from '@/app/workspace/useWorkspaceFocusLifecycle';
import { useWorkspaceCapabilityChrome } from '@/app/workspace/hooks/useWorkspaceCapabilityChrome';
import {
  sessionContextLabel,
  useWorkspaceStackReport,
  workspaceBackLabel,
  workspaceSubtitle,
} from '@/app/workspace/hooks/useWorkspacePanelChrome';
import type {
  CapabilityFocus,
  Experience,
  WorkspaceContext,
  WorkspaceStackReport,
} from '@/app/workspace/workspaceContext';

export interface WorkspacePanelProps {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  surface: Surface;
  tool: CapabilityId;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
  /**
   * Reports whether a capability has pushed a detail depth (#1081).
   *
   * Read by the App's pager, which must not offer a second leave for a depth
   * that already has one. Absent on Web, which has no top-level gesture.
   */
  onDepthChange?: (pushed: boolean) => void;
  /**
   * Reports the capability's inner stack destinations (#3971).
   *
   * The App's single gesture coordinator routes a claimed contact here before
   * the outer spatial navigator: right swipes pop one valid depth, left swipes
   * restore only a recorded forward destination. `null` means the depth has no
   * inner stack (or the panel is unmounting).
   */
  onStackChange?: (stack: WorkspaceStackReport | null) => void;
  /** What opened this view, when the entry carried context (`#826`). */
  focus?: CapabilityFocus;
  onFocusConsumed?: () => void;
  openWorktreeSession?: (worktree: import('@/capabilities/git/types').GitWorktree) => Promise<void>;
  /** Focused Session's Project resolution and actions (#3082). */
  focusedProject?: FocusedProject;
  sessionProject?: SessionProjectContext;
}

/** The Web's one surface-leave destination action, when a Session exists. */
function surfaceActionFor(
  experience: Experience,
  hasSession: boolean,
  onSurfaceChange: (surface: Surface) => void,
  conversationGlyph: React.ElementType | undefined,
) {
  if (experience !== 'web' || !hasSession) {
    return undefined;
  }
  const Glyph = conversationGlyph;
  return (
    <SurfaceDestinationAction
      destination="terminal"
      onOpen={() => onSurfaceChange('terminal')}
      glyph={Glyph ? <Glyph aria-hidden /> : undefined}
    />
  );
}

/**
 * The Workspace page and its one navigation bar (#1051).
 *
 * The chrome owner for whatever depth the Workspace is at. It renders the App's
 * page header and hands the capability's view a `WorkspaceDepthControl` to
 * declare a pushed depth through — which is what its Back names. It no longer
 * gates the dock on the depth: the capsule is present at every depth (owner
 * decision 2026-10-03; `WorkspaceShell`'s `showDock` carries the argument).
 *
 * The push and the contextual header action are stamped with the capability
 * that registered them rather than cleared by an effect when `tool` changes.
 * Switching capability unmounts the view that published, so there is no
 * cleanup to run — and a stale registration read for even one frame would put
 * another capability's name in the header.
 */
export function WorkspacePanel({
  selectedSession,
  selectedAgent,
  agents,
  domain,
  surface,
  tool,
  fileOps,
  experience,
  facts,
  onSurfaceChange,
  onToolChange,
  onDepthChange,
  onStackChange,
  focus,
  onFocusConsumed,
  openWorktreeSession,
  focusedProject,
  sessionProject,
}: WorkspacePanelProps) {
  // The pushed depth, the contextual header actions and the recorded forward
  // destination are one capability-stamped state machine; the hook owns their
  // ownership rule.
  const { push, actions, forward, depth } = useWorkspaceCapabilityChrome(tool);

  // Report the depth upward rather than keeping it private (#1081): the App's
  // pager needs it, and this is the component that owns it. The panel is
  // unmounted whenever the Workspace layer is closed, so the reset on the way
  // out is what keeps a stale `true` from silencing the Terminal's gesture —
  // and it is a separate effect because the reporting one would otherwise clear
  // and re-set on every push, which is a state change nothing asked for.
  useEffect(() => {
    onDepthChange?.(push !== null);
  }, [push, onDepthChange]);

  useWorkspaceFocusLifecycle(focus, fileOps, onFocusConsumed, onDepthChange);

  const ctx: WorkspaceContext = useMemo(
    () => ({
      session: selectedSession,
      agent: selectedAgent,
      agents,
      domain,
      fileOps,
      experience,
      onToolChange,
      facts,
      focus,
      onFocusConsumed,
      openWorktreeSession,
      focusedProject,
      activeCapabilityId: tool,
      sessionProject,
    }),
    [
      selectedSession,
      selectedAgent,
      agents,
      domain,
      fileOps,
      experience,
      onToolChange,
      facts,
      focus,
      onFocusConsumed,
      openWorktreeSession,
      focusedProject,
      tool,
      sessionProject,
    ],
  );

  // The header names the capability the user opened. Names live in the
  // capability layer alongside availability, so chrome reads them from there
  // rather than from a table kept next to the views.
  const activeLabel = useMemo(
    () =>
      resolveWorkspaceCapabilities(ctx).snapshots.find((snapshot) => snapshot.id === tool)?.title ??
      'Workspace',
    [ctx, tool],
  );

  const sessionContext = useMemo(
    () => sessionContextLabel(selectedSession, selectedAgent),
    [selectedAgent, selectedSession],
  );
  const subtitle = workspaceSubtitle(push, activeLabel, sessionContext);
  const backLabel = workspaceBackLabel(push, activeLabel, selectedSession !== null);
  useWorkspaceStackReport({ push, forward, activeLabel, onStackChange });

  // The Web's Workspace → Terminal route (#1204): one circular destination
  // action beside the capability dock — surface navigation, not a capability,
  // so it is never a dock entry and never displaced by the dock's content. The
  // App leaves through `AppPageHeader`'s Back and gets no second leave.
  //
  // SC-25 (#1347): while the pane is running a conversational capability, the
  // Terminal-return circle projects that capability's glyph — "your
  // conversation is over there". Which capabilities are conversational and
  // when one is live is contribution knowledge: the registry is asked, no
  // capability is named here, and a second one (Codex, OpenCode) projects its
  // identity without this file changing. The glyph replaces the circle's
  // inner Terminal icon, so the destination is untouched (SC-26).
  const conversation = resolveConversationIdentity(facts);
  const ConversationGlyph = conversation?.glyph;
  const surfaceAction = surfaceActionFor(experience, selectedSession !== null, onSurfaceChange, ConversationGlyph);

  // The inner stack page frame (#3971): header and content move together under
  // the finger; the Capability Capsule keeps its station. The frame carries no
  // transform at rest, so the resting layout is unchanged and the transition
  // only exists while a released contact settles.
  const innerMotion = useAppInnerStackMotion();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const pageMotionStyle = innerMotion.action === null
    ? undefined
    : {
      transform: `translateX(${innerMotion.offset}px)`,
      transition:
        innerMotion.settling && !reducedMotion
          ? 'transform var(--nession-motion-shell-duration) var(--nession-motion-shell-ease)'
          : undefined,
    };

  return (
    <div
      role="region"
      id="workspace-capability-panel"
      aria-label="Workspace"
      className={cn('flex min-h-0 flex-1 flex-col', surface !== 'workspace' && 'hidden')}
    >
      {experience === 'app' ? (
        <div
          data-testid="app-workspace-page-head"
          className="shrink-0 will-change-transform"
          style={pageMotionStyle}
        >
          <AppPageHeader
          /* Back goes to the depth below this one, and nowhere else: the Terminal
             from a capability root, the capability root from a pushed detail.
             `#1051`'s rule is one predictable leave per depth, so this is the
             only affordance in the App that leaves either of them. */
          backLabel={backLabel}
          onBack={push ? push.onLeave : () => onSurfaceChange('terminal')}
          title={push ? push.title : activeLabel}
          subtitle={subtitle}
          ancestors={push?.ancestors}
          onJumpToAncestor={push?.onJumpToAncestor}
          technical={push !== null}
            actions={actions}
          />
        </div>
      ) : null}
      <WorkspaceShell
        ctx={ctx}
        activeCapabilityId={tool}
        depth={depth}
        surfaceAction={surfaceAction}
      />
    </div>
  );
}
