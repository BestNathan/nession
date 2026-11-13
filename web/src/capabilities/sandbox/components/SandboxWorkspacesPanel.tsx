import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DetailEmpty,
  DetailHeader,
  DetailSurface,
} from '@/components/ui/resource-detail';
import type { AgentWorkspaceDescriptor } from '../WorkspacePlugin';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { useAgentWorkspaces } from '../hooks/useAgentWorkspaces';

function statusVariant(
  status: AgentWorkspaceDescriptor['status'],
): 'secondary' | 'outline' | 'destructive' {
  if (status === 'available') {
    return 'secondary';
  }
  if (status === 'error') {
    return 'destructive';
  }
  return 'outline';
}

function timeLabel(seconds: number): string {
  if (!seconds) {
    return '—';
  }
  return new Date(seconds * 1000).toLocaleString();
}

function WorkspaceRow({
  workspace,
  onDelete,
}: {
  workspace: AgentWorkspaceDescriptor;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid="sandbox-workspace-row"
      className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn('truncate', chromeSansRole('primary'))}>{workspace.name}</span>
          <Badge variant={statusVariant(workspace.status)} data-testid="sandbox-workspace-status">
            {workspace.status}
          </Badge>
          {workspace.auto_created ? (
            <Badge variant="outline" data-testid="sandbox-workspace-auto-created">
              auto-created
            </Badge>
          ) : null}
        </div>
        <p className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
          {workspace.workspace_id} · {workspace.namespace}
        </p>
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Last used {timeLabel(workspace.last_used_at)}
        </p>
        {workspace.detail ? (
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            {workspace.detail}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Delete Workspace ${workspace.name}`}
        data-testid="sandbox-workspace-delete"
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * The Sandbox Workspaces section (#3407, #3408).
 *
 * The inventory and lifecycle are owned by the Agent Workspace Manager. This
 * view reads the current Session's Agent and never invents a second registry;
 * a deletion is confirmed and refused by the Agent while the Workspace is
 * attached.
 */
export function SandboxWorkspacesPanel({ sessionId }: { sessionId: string | null }) {
  const inventory = useAgentWorkspaces(sessionId);
  const [name, setName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspaceDescriptor | null>(null);

  const create = async () => {
    const created = await inventory.create(name.trim());
    if (created) {
      setName('');
    }
  };

  const confirmDelete = async () => {
    if (pendingDelete) {
      await inventory.remove(pendingDelete.workspace_id);
    }
    setPendingDelete(null);
  };

  return (
    <DetailSurface data-testid="sandbox-workspaces">
      <DetailHeader
        level="h2"
        title="Workspaces"
        description="Agent-owned reusable Workspaces for this Session's Agent. The Filesystem policy selects one; bytes outlive the execution and cleanup releases only the lease."
        actions={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Refresh Workspace inventory"
            data-testid="sandbox-workspaces-refresh"
            onClick={inventory.refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        }
      />

      <div className="flex min-w-0 flex-wrap items-end gap-2 px-3 pb-2">
        <Input
          value={name}
          placeholder="Workspace name"
          aria-label="New Workspace name"
          data-testid="sandbox-workspaces-create-name"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          data-testid="sandbox-workspaces-create"
          disabled={inventory.busy || name.trim().length === 0}
          onClick={() => void create()}
        >
          Create or reuse
        </Button>
      </div>
      {inventory.actionError ? (
        <p className="px-3 text-destructive" data-testid="sandbox-workspaces-action-error">
          {inventory.actionError}
        </p>
      ) : null}

      {inventory.error ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <p className="text-destructive" data-testid="sandbox-workspaces-error">
            {inventory.error}
          </p>
          <Button type="button" variant="outline" onClick={inventory.refresh}>
            Retry
          </Button>
        </div>
      ) : inventory.loading && inventory.workspaces.length === 0 ? (
        <p className="p-4 text-muted-foreground" data-testid="sandbox-workspaces-loading">
          Reading the Agent Workspace inventory…
        </p>
      ) : inventory.workspaces.length === 0 ? (
        <DetailEmpty data-testid="sandbox-workspaces-empty">
          This Agent holds no managed Workspaces. Create one by name, or select Auto by Session
          name in the Filesystem policy.
        </DetailEmpty>
      ) : (
        <ul className="flex min-w-0 flex-col" data-testid="sandbox-workspaces-list">
          {inventory.workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.workspace_id}
              workspace={workspace}
              onDelete={() => setPendingDelete(workspace)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name ?? 'Workspace'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the Agent-owned directory and its registry entry. The Agent refuses
              while the Workspace is leased or attached to an execution. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={inventory.busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sandbox-workspace-delete-confirm"
              disabled={inventory.busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
            >
              {inventory.busy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSurface>
  );
}
