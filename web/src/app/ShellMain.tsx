import { useRef, type ReactNode } from 'react';
import { useIncomingCapabilityFocus } from '@/app/useIncomingCapabilityFocus';
import { useShellMainFocusTooling } from '@/app/useShellMainFocusTooling';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { FileOps } from '@/capabilities/files';
import type { DomainState } from '@/product/session/model/domainState';
import { AppHome } from '@/app/experiences/app/AppHome';
import { TerminalRegion } from '@/app/TerminalRegion';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';
import { TerminalWell } from '@/app/TerminalWell';
import type { CapabilityId } from '@/product/capability';
import type { CapabilityFocus, Experience } from '@/app/workspace/workspaceContext';
import type { Surface } from '@/app/patterns/SessionHeader';
import { SessionMainHeader } from '@/app/SessionMainHeader';
import { SurfaceDestinationAction } from '@/product/workspace/patterns/SurfaceDestinationAction';
import { WorkspacePanel } from '@/app/WorkspacePanel';
import { useCapsuleCapability } from '@/app/useCapsuleCapability';
import { useCapsuleMorph } from '@/product/terminal/capsule/useCapsuleMorph';
import { useWorkSignals } from '@/app/useWorkSignals';
import type { Agent, Session } from '@/types';

export interface ShellMainProps {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  surface: Surface;
  tool: CapabilityId;
  fileOps: FileOps | null;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
  onOpenDrawer?: () => void;
  onOpenWorkspace?: () => void;
  /**
   * Opens the existing `CreateSessionDialog`. Only the App's no-Session root
   * reads it (#1082); Web reaches creation from the sidebar it always has.
   */
  onCreate?: () => void;
  /**
   * Reports whether a Workspace capability has pushed a detail depth (#1081).
   *
   * The App's pager reads this to stand down while a depth offers its own
   * leave. Only the App passes it; Web has no top-level gesture to suppress, so
   * the callback is absent there and the report is dropped.
   */
  onWorkspaceDepthChange?: (pushed: boolean) => void;
  /** Spatial shell: omit terminal on the Workspace page to avoid a second xterm. */
  showTerminal?: boolean;
  /** Spatial shell: omit workspace panel on the Terminal page. */
  showWorkspace?: boolean;
  /**
   * Fixture/testing override for the terminal. Defaults to the real attached
   * terminal.
   *
   * A node replaces the terminal region; a **function** receives the chrome the
   * shell resolved — the capsule's capability contribution and any projection —
   * so a supplied terminal can draw the same surface the product does rather
   * than a capsule with no capability entry in it (#838).
   *
   * It has to be handed down rather than resolved by the caller: the
   * contribution comes from `useCapsuleCapability` here, and a caller that
   * rendered its own `TerminalSurface` around the node would nest a second
   * surface inside this one's.
   */
  terminal?: ReactNode | ((chrome: TerminalChrome) => ReactNode);
  /** App experience: the SessionHeader renders no Terminal|Workspace switcher. */
  experience?: Experience;
  onOpenWorktreeSession?: (
    worktree: import('@/capabilities/git/types').GitWorktree,
  ) => Promise<void>;
  /** App: focus handed from the Terminal layer (#1175). */
  incomingFocus?: CapabilityFocus;
  onIncomingFocusApplied?: () => void;
  /** App Terminal: open a workspace-relative file in Files. */
  onOpenWorkspaceFile?: (path: string, line?: number) => void;
}

/**
 * The capsule chrome the shell resolves, for a caller that supplies a terminal.
 *
 * Both fields are optional because a capability contribution is: a Session with
 * nothing reachable yields none, and a node-rendering caller ignores this
 * entirely.
 */
export interface TerminalChrome {
  capsuleCapabilities?: CapsuleCapabilityContribution;
  capsuleProjection?: CapsuleCapabilityProjection;
  /**
   * The Web's "Open Workspace" destination action beside the capsule (#1204) —
   * resolved here because the action is the shell's navigation, and a supplied
   * terminal draws the same surface the product does only if it is handed it.
   */
  surfaceAction?: ReactNode;
}

function renderTerminal(
  terminal: ShellMainProps['terminal'],
  chrome: TerminalChrome,
): ReactNode {
  if (typeof terminal === 'function') {
    return terminal(chrome);
  }
  return terminal ?? null;
}

/**
 * What the work area holds before a Session exists.
 *
 * Two answers, because the two experiences genuinely differ. Web keeps a
 * caption: it always has the sidebar, so "Select a session" is a label beside a
 * list of them. App gets a home with an action (#1082) — on a phone the list is
 * a drawer that can be dismissed, so the caption was the whole screen with no
 * way off it.
 */
function NoSessionSurface({
  experience,
  onCreate,
  onBrowse,
  createDisabled,
}: {
  experience: Experience;
  onCreate: () => void;
  onBrowse: () => void;
  createDisabled: boolean;
}) {
  if (experience === 'app') {
    return (
      <AppHome
        onCreate={onCreate}
        onBrowse={onBrowse}
        createDisabled={createDisabled}
      />
    );
  }
  return (
    <div
      data-testid="session-empty-state"
      className={cn('flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground', chromeSansRole('secondary'))}
    >
      <p>Select a session to start working</p>
    </div>
  );
}

/**
 * The Web's Terminal → Workspace route (#1204): one circular destination
 * action beside the capsule, replacing the floating top-right switcher. The
 * shell owns the navigation; the capsule owns only the slot's geometry.
 */
function WebOpenWorkspaceAction({
  onSurfaceChange,
}: {
  onSurfaceChange: (surface: Surface) => void;
}) {
  return (
    <SurfaceDestinationAction
      destination="workspace"
      onOpen={() => onSurfaceChange('workspace')}
    />
  );
}

/**
 * The Terminal half of the work area: the well, a caller-supplied terminal or
 * the real `TerminalRegion`, hidden rather than unmounted on the Workspace
 * surface so the reciprocal morph (#1347 SC-08) has both elements to measure.
 */
function ShellTerminal({
  surface,
  selectedSession,
  terminal,
  experience,
  capsuleCapabilities,
  capsuleProjection,
  surfaceAction,
  onOpenWorkspaceFile,
  workContext,
}: {
  surface: Surface;
  selectedSession: Session | null;
  terminal: ShellMainProps['terminal'];
  experience: Experience;
  capsuleCapabilities?: CapsuleCapabilityContribution;
  capsuleProjection?: CapsuleCapabilityProjection;
  surfaceAction?: ReactNode;
  onOpenWorkspaceFile?: (path: string, line?: number) => void;
  workContext?: ResolvedWorkContext;
}) {
  return (
    <TerminalWell
      className={cn('min-h-0', (surface !== 'terminal' || !selectedSession) && 'hidden')}
    >
      {renderTerminal(terminal, {
        capsuleCapabilities,
        capsuleProjection,
        surfaceAction,
      }) ?? (
        <TerminalRegion
          hidden={surface !== 'terminal' || !selectedSession}
          onError={() => undefined}
          experience={experience}
          capsuleCapabilities={capsuleCapabilities}
          capsuleProjection={capsuleProjection}
          surfaceAction={surfaceAction}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          workContext={workContext}
        />
      )}
    </TerminalWell>
  );
}

export function ShellMain({
  selectedSession,
  selectedAgent,
  agents,
  domain,
  surface,
  tool,
  fileOps,
  onSurfaceChange,
  onToolChange,
  onOpenDrawer,
  onOpenWorkspace,
  onCreate,
  onWorkspaceDepthChange,
  showTerminal = true,
  showWorkspace = true,
  terminal,
  experience = 'web',
  onOpenWorktreeSession,
  incomingFocus,
  onIncomingFocusApplied,
  onOpenWorkspaceFile,
}: ShellMainProps) {
  const hasSession = selectedSession !== null && domain !== null;
  const { focus, setFocus, consumeFocus } = useIncomingCapabilityFocus(
    incomingFocus,
    onIncomingFocusApplied,
  );
  const { openTool, openWorkspaceFromCapsule } = useShellMainFocusTooling(
    setFocus,
    onToolChange,
    onSurfaceChange,
  );
  const { facts, capabilities: capsuleCapabilities, projection } = useCapsuleCapability({
    session: selectedSession,
    agent: selectedAgent,
    agents,
    domain,
    fileOps,
    experience,
    onToolChange: openTool,
    onSurfaceChange: () => onSurfaceChange('workspace'),
    onOpenWorkspace: openWorkspaceFromCapsule,
  });
  const workContext = useWorkSignals(selectedSession ?? undefined);
  const surfaceAction = hasSession && experience === 'web' ? <WebOpenWorkspaceAction onSurfaceChange={onSurfaceChange} /> : undefined;
  const capsuleZoneRef = useRef<HTMLDivElement>(null);
  useCapsuleMorph(surface, capsuleZoneRef);

  return (
    <>
      {/* Session identity is the **Terminal surface's** navigation bar (#1051).
          The App's Workspace layer mounts its own `ShellMain`, and that one used
          to render a second `SessionMainHeader` at the same position — two
          session titles drawn on top of each other, neither legible, because the
          Workspace layer's own header region is transparent. The Workspace
          depth's bar is its page header, which announces what the user opened;
          Session identity belongs to the depth they opened it from.

          The Web experience is unaffected: it renders no header on any surface
          (#748), so the gate is inert there. */}
      {surface === 'terminal' ? (
        <SessionMainHeader
          session={selectedSession}
          domain={domain}
          experience={experience}
          onOpenDrawer={onOpenDrawer}
          onOpenWorkspace={onOpenWorkspace}
        />
      ) : null}
      <div
        ref={capsuleZoneRef}
        data-testid="main-content"
        className="relative flex min-h-0 flex-1 flex-col gap-0">
        {!hasSession ? (
          <NoSessionSurface
            experience={experience}
            onCreate={() => onCreate?.()}
            onBrowse={() => onOpenDrawer?.()}
            createDisabled={agents.every((agent) => agent.status !== 'online')}
          />
        ) : (
          <>
            {showTerminal ? (
              <ShellTerminal
                surface={surface}
                selectedSession={selectedSession}
                terminal={terminal}
                experience={experience}
                capsuleCapabilities={capsuleCapabilities}
                capsuleProjection={projection}
                surfaceAction={surfaceAction}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                workContext={workContext}
              />
            ) : null}
            {showWorkspace && hasSession ? (
              <WorkspacePanel
                selectedSession={selectedSession}
                selectedAgent={selectedAgent}
                agents={agents}
                domain={domain}
                surface={surface}
                tool={tool}
                fileOps={fileOps}
                experience={experience}
                facts={facts}
                onSurfaceChange={onSurfaceChange}
                onToolChange={openTool}
                onDepthChange={onWorkspaceDepthChange}
                focus={focus}
                onFocusConsumed={consumeFocus}
                openWorktreeSession={onOpenWorktreeSession}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
