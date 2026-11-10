import { agentDisplayName } from '@/shared/lib/format';
import { ChoiceItemContent } from '@/components/ui/choice-item';
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
    <ChoiceItemContent
      title={agent ? agentDisplayName(agent) : location.agent_id}
      detail={location.path}
      detailTestId="project-location-path"
      status={showStatus ? (offline ? 'Agent offline' : 'Agent online') : undefined}
      statusTone={offline ? 'unavailable' : 'neutral'}
      statusTestId={
        showStatus
          ? offline
            ? 'project-location-status-offline'
            : 'project-location-status-online'
          : undefined
      }
    />
  );
}
