import { useCallback, useState, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import type { FileOps } from '@/capabilities/files';
import type { DomainState } from '@/product/session/model/domainState';
import { TerminalRegion } from '@/app/TerminalRegion';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';
import { TerminalWell } from '@/app/TerminalWell';
import type { CapabilityId } from '@/product/capability';
import type { CapabilityFocus, Experience } from '@/app/workspace/workspaceContext';
import type { Surface } from '@/app/patterns/SessionHeader';
import { SessionMainHeader } from '@/app/SessionMainHeader';
import { SurfaceSwitcher } from '@/product/workspace/patterns/SurfaceSwitcher';
import { WorkspacePanel } from '@/app/WorkspacePanel';
import { useCapsuleCapability } from '@/app/useCapsuleCapability';
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
  showTerminal = true,
  showWorkspace = true,
  terminal,
  experience = 'web',
}: ShellMainProps) {
  const hasSession = selectedSession !== null && domain !== null;
  // What opened the Workspace, when the entry carried something with it. Cleared
  // when the user opens a capability by any other route — a stale focus would
  // silently redirect a later visit to whatever they happened to look at before.
  const [focus, setFocus] = useState<CapabilityFocus | undefined>(undefined);
  const openTool = useCallback(
    (id: CapabilityId) => {
      setFocus(undefined);
      onToolChange(id);
    },
    [onToolChange],
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
    onOpenWorkspace: (id, resourceId) => {
      // `#826`: the context that caused the emergence travels with it, so the
      // Workspace opens on the item rather than on a landing page.
      setFocus({ capabilityId: id, resourceId });
      onToolChange(id);
      onSurfaceChange('workspace');
    },
  });

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
        data-testid="main-content"
        className="relative flex min-h-0 flex-1 flex-col gap-0">
        {/* Web only: App reaches Workspace through its own spatial model and
            asserts the absence of this control. Floats, so it costs the work
            surface no layout space. */}
        {hasSession && experience === 'web' ? (
          <div className="pointer-events-none absolute right-[var(--shell-space-3)] top-[var(--shell-space-3)] z-20">
            <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
          </div>
        ) : null}
        {!hasSession ? (
          <div
            data-testid="session-empty-state"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <p>Select a session to start working</p>
          </div>
        ) : (
          <>
            {showTerminal ? (
              <TerminalWell
                className={cn('min-h-0', (surface !== 'terminal' || !selectedSession) && 'hidden')}
              >
                {renderTerminal(terminal, {
                  capsuleCapabilities,
                  capsuleProjection: projection,
                }) ?? (
                  <TerminalRegion
                    hidden={surface !== 'terminal' || !selectedSession}
                    onDisconnect={() => undefined}
                    onError={() => undefined}
                    experience={experience}
                    capsuleCapabilities={capsuleCapabilities}
                    capsuleProjection={projection}
                  />
                )}
              </TerminalWell>
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
                focus={focus}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
