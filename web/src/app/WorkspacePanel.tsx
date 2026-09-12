import { cn } from '@/lib/utils';
import type { FileOps } from '@/features/files';
import type { CapabilityFacts } from '@/features/capabilities';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { Agent, Session } from '@/types';
import { AppToolHeader } from '@/app/patterns/AppToolHeader';
import type { Surface } from '@/app/patterns/SessionHeader';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { WORKSPACE_TOOLS } from '@/app/workspace/tools';
import type { Experience, WorkspaceToolId } from '@/app/workspace/toolTypes';

export interface WorkspacePanelProps {
  selectedSession: Session;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState;
  surface: Surface;
  tool: WorkspaceToolId;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: WorkspaceToolId) => void;
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
  const activeLabel = WORKSPACE_TOOLS.find((item) => item.id === tool)?.label ?? 'Workspace';

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
      <WorkspaceShell
        ctx={{
          session: selectedSession,
          agent: selectedAgent,
          agents,
          domain,
          fileOps,
          experience,
          onToolChange,
          facts,
        }}
        activeCapabilityId={tool}
      />
    </div>
  );
}
