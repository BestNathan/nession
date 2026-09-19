import { useCallback, useState, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import type { FileOps } from '@/capabilities/files';
import type { DomainState } from '@/product/session/model/domainState';
import { TerminalRegion } from '@/app/TerminalRegion';
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
  /** Fixture/testing override for the terminal surface. Defaults to the real attached terminal. */
  terminal?: ReactNode;
  /** App experience: the SessionHeader renders no Terminal|Workspace switcher. */
  experience?: Experience;
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
      <SessionMainHeader
        session={selectedSession}
        domain={domain}
        experience={experience}
        onOpenDrawer={onOpenDrawer}
        onOpenWorkspace={onOpenWorkspace}
      />
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
                {terminal ?? (
                  <TerminalRegion
                    hidden={surface !== 'terminal' || !selectedSession}
                    onDisconnect={() => undefined}
                    onError={() => undefined}
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
