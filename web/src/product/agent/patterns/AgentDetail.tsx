import { Separator } from '@/components/ui/separator';
import { renderSlot } from '@/extensions/registry';
import { agentDisplayName } from '@/shared/lib/format';
import { ConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent } from '@/types';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { AgentDetails } from '@/product/agent/components/AgentDetails';
import { AgentProcesses } from '@/product/agent/components/AgentProcesses';
import { useAgentProcesses } from '@/product/agent/hooks/useAgentProcesses';

export interface AgentDetailProps {
  agent: Agent;
  state: DomainState;
  /** The Session the Workspace was opened from, when it belongs to this Agent. */
  currentSessionId?: string | null;
}

/**
 * The existing Agent capability's detail view (#2514).
 *
 * Order is the product hierarchy: compact node identity/connectivity, the
 * Agent's own facts behind a default-closed disclosure, then the current
 * Session's process work. The Agent is infrastructure context here, not a
 * navigator for the Agent's other Sessions.
 */
export function AgentDetail({ agent, state, currentSessionId }: AgentDetailProps) {
  const name = agentDisplayName(agent);
  const extensionSections = renderSlot('agent-detail', { agent });
  const processes = useAgentProcesses(agent, currentSessionId);

  return (
    <div
      data-testid="agent-detail"
      className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4', workspaceScrollClearanceClass)}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={chromeSansRole('primary')}>{name}</h2>
          <p className={cn('min-w-0 truncate text-muted-foreground', chromeSansRole('secondary'))}>
            {agent.hostname}
            {agent.metadata?.os_version ? ` · ${agent.metadata.os_version}` : ''}
          </p>
        </div>
        <ConnectionStatus state={state} />
      </div>

      <AgentDetails
        agent={agent}
        state={state}
        sessionName={processes.sessionName}
        snapshot={processes.snapshot}
        snapshotLoading={processes.snapshotLoading}
        snapshotError={processes.snapshotError}
      />

      <Separator />
      <AgentProcesses agent={agent} view={processes} />

      {extensionSections.length > 0 ? (
        <>
          <Separator />
          <div data-testid="agent-detail-extensions" className="flex flex-col gap-2">
            {extensionSections}
          </div>
        </>
      ) : null}
    </div>
  );
}
