import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFacts, CapabilityId } from '@/features/capabilities';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';
import { AppToolHeader } from '@/app/patterns/AppToolHeader';
import type { Surface } from '@/app/patterns/SessionHeader';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import type { Experience, WorkspaceContext } from '@/app/workspace/workspaceContext';

export interface WorkspacePanelProps {
  selectedSession: Session;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState;
  surface: Surface;
  tool: CapabilityId;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
}

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
}: WorkspacePanelProps) {
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

  return (
    <div
      role="region"
      id="workspace-capability-panel"
      aria-label="Workspace"
      className={cn('flex min-h-0 flex-1 flex-col', surface !== 'workspace' && 'hidden')}
    >
      {experience === 'app' ? (
        <AppToolHeader
          toolLabel={activeLabel}
          onBack={() => onSurfaceChange('terminal')}
        />
      ) : null}
      <WorkspaceShell ctx={ctx} activeCapabilityId={tool} />
    </div>
  );
}
