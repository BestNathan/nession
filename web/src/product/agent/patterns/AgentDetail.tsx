import { Separator } from '@/components/ui/separator';
import { renderSlot } from '@/extensions/registry';
import { agentDisplayName, formatRelativeTime } from '@/shared/lib/format';
import { ConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent } from '@/types';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface AgentDetailProps {
  agent: Agent;
  state: DomainState;
}

export function AgentDetail({ agent, state }: AgentDetailProps) {
  const name = agentDisplayName(agent);
  const metadata = agent.metadata;
  const extensionSections = renderSlot('agent-detail', { agent });

  return (
    <div
      data-testid="agent-detail"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      <div>
        <h2 className={chromeSansRole('primary')}>{name}</h2>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>{agent.hostname}</p>
      </div>

      <ConnectionStatus state={state} />

      <dl className={cn('grid gap-2', chromeSansRole('body'))}>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">ID</dt>
          <dd>{agent.agent_id}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Address</dt>
          <dd>{agent.ip_address}:{agent.port}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Last heartbeat</dt>
          <dd>{formatRelativeTime(agent.last_heartbeat)}</dd>
        </div>
        {metadata && (
          <>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">tmux</dt>
              <dd>{metadata.tmux_version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">OS</dt>
              <dd>{metadata.os_version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">nession</dt>
              <dd>{metadata.nession_version}</dd>
            </div>
            {metadata.image_tag && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Image</dt>
                <dd>{metadata.image_tag}</dd>
              </div>
            )}
          </>
        )}
      </dl>

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
