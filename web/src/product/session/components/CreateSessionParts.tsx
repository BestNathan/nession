import { cn } from '@/shared/lib/utils';
import { agentDisplayName } from '@/shared/lib/format';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Agent } from '@/types';
import type { ProjectLocation } from '@/product/project/types';

/** The Agent/path/status lines shared by Web and App location choices. */
export function ProjectLocationDetails({
  location,
  agent,
  showStatus = false,
}: {
  location: ProjectLocation;
  agent: Agent | undefined;
  showStatus?: boolean;
}) {
  const offline = showStatus && agent?.status !== 'online';
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <span className={cn('truncate', chromeSansRole('body'))}>
        {agent ? agentDisplayName(agent) : location.agent_id}
      </span>
      <span data-testid="project-location-path" className={cn('break-all text-muted-foreground', chromeMonoRole('caption'))}>
        {location.path}
      </span>
      {showStatus ? (
        <span
          data-testid={offline ? 'project-location-status-offline' : 'project-location-status-online'}
          className={cn(offline ? 'text-destructive' : 'text-muted-foreground', chromeSansRole('caption'))}
        >
          {offline ? 'Agent offline' : 'Agent online'}
        </span>
      ) : null}
    </span>
  );
}
