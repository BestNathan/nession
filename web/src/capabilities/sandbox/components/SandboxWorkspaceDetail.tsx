import {
  DetailFact,
  DetailFacts,
  DetailSection,
} from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { AgentWorkspaceDescriptor } from '../WorkspacePlugin';
import {
  workspaceKindLabel,
  workspaceStatusLabel,
  workspaceUsageLabel,
} from '../model';

function timeLabel(seconds: number): string {
  if (!seconds) {
    return '—';
  }
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * The selected Workspace's observed ownership and dependency detail (#3797).
 *
 * The Agent owns every measured field. A Project Location is a user-owned
 * declaration the Agent did not observe: it names only the declared path and
 * claims no store, lease, mount or usage.
 */
export function SandboxWorkspaceDetail({
  workspace,
  agentLabel,
}: {
  workspace: AgentWorkspaceDescriptor;
  agentLabel: string;
}) {
  const projectLocation = workspace.kind === 'project_location';
  const lowerDigests = workspace.lower_digests ?? [];
  const consumers = workspace.consumers ?? [];
  const leaseCount = workspace.lease_count ?? 0;
  return (
    <div
      data-testid="sandbox-workspace-detail"
      className="flex min-w-0 flex-col gap-3 border-t border-border px-3 py-3"
    >
      <DetailFacts className="gap-2">
        <DetailFact label="Ownership" valueTestId="sandbox-workspace-detail-ownership">
          {workspaceKindLabel(workspace)}
        </DetailFact>
        <DetailFact label="Agent" valueTestId="sandbox-workspace-detail-agent">
          {agentLabel}
        </DetailFact>
        {projectLocation ? (
          <DetailFact
            label="Declared path"
            mono
            valueTestId="sandbox-workspace-detail-path"
          >
            {workspace.path ?? 'No declared path'}
          </DetailFact>
        ) : (
          <DetailFact
            label="Writable store"
            mono
            valueTestId="sandbox-workspace-detail-store"
          >
            {workspace.workspace_id}
            <span className={cn('ml-2 text-muted-foreground', chromeSansRole('caption'))}>
              {workspace.overlay_storage
                ? 'durable Overlay upper/work'
                : 'plain Agent-owned directory'}
            </span>
          </DetailFact>
        )}
        {projectLocation ? null : (
          <>
            <DetailFact
              label="Persistent bytes"
              valueTestId="sandbox-workspace-detail-bytes"
            >
              {workspaceUsageLabel(workspace.used_bytes)}
            </DetailFact>
            <DetailFact
              label="Lease / mount"
              valueTestId="sandbox-workspace-detail-use"
            >
              {`${workspaceStatusLabel(workspace.status)} · ${leaseCount} lease${
                leaseCount === 1 ? '' : 's'
              } · ${workspace.mounted ? 'mounted' : 'not mounted'}`}
            </DetailFact>
            <DetailFact
              label="Consumers"
              valueTestId="sandbox-workspace-detail-consumers"
            >
              {consumers.length > 0
                ? consumers.join(', ')
                : 'No Session consumer observed'}
            </DetailFact>
          </>
        )}
        <DetailFact label="Updated" valueTestId="sandbox-workspace-detail-updated">
          {timeLabel(workspace.updated_at ?? 0)}
        </DetailFact>
        <DetailFact label="Last used" valueTestId="sandbox-workspace-detail-last-used">
          {timeLabel(workspace.last_used_at)}
        </DetailFact>
      </DetailFacts>
      {projectLocation ? (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          This path belongs to the Project and the user. The Agent never creates,
          copies or deletes it; it has no delete action here.
        </p>
      ) : (
        <DetailSection
          title="Source image lowers"
          level="h3"
          testId="sandbox-workspace-detail-lowers"
        >
          {lowerDigests.length > 0 ? (
            <ol className={cn('flex min-w-0 flex-col gap-1', chromeMonoRole('metadata'))}>
              {lowerDigests.map((digest, index) => (
                <li
                  key={digest}
                  data-testid={`sandbox-workspace-detail-lower-${index}`}
                  className="break-all"
                >
                  {digest}
                </li>
              ))}
            </ol>
          ) : (
            <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
              No Project EROFS lower. This is a plain durable directory.
            </p>
          )}
        </DetailSection>
      )}
    </div>
  );
}
