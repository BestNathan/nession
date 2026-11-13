import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormField, FormSection } from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import type { SandboxFilesystemWorkspace } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import {
  useAgentWorkspaces,
  type AgentWorkspacesState,
} from '../hooks/useAgentWorkspaces';
import { workspaceLabel } from '../model';

export interface SandboxFilesystemWorkspaceProps {
  sessionId: string | null;
  workspace: SandboxFilesystemWorkspace | undefined;
  /** A Workspace selection requires an image RootFS. */
  rootfsIsImage: boolean;
  workingDir: string;
  workingDirError: string | undefined;
  onWorkingDirChange: (value: string) => void;
  onChange: (workspace: SandboxFilesystemWorkspace | undefined) => void;
}

function ManagedWorkspacePicker({
  inventory,
  managed,
  disabledReason,
  onChange,
}: {
  inventory: AgentWorkspacesState;
  managed: Extract<SandboxFilesystemWorkspace, { kind: 'managed' }> | null;
  disabledReason: string | null;
  onChange: (workspace: SandboxFilesystemWorkspace | undefined) => void;
}) {
  const [nameDraft, setNameDraft] = useState(managed?.name ?? '');
  const managedById = managed?.workspace_id ?? '';
  const managedByName = managed !== null && managed.workspace_id === undefined;
  const selectedDescriptor = managedById
    ? inventory.workspaces.find((item) => item.workspace_id === managedById)
    : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="flex min-w-0 flex-col gap-1">
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Managed Workspace
        </span>
        <select
          aria-label="Managed Workspace"
          data-testid="sandbox-workspace-managed-select"
          disabled={disabledReason !== null}
          value={managedById}
          className="h-[length:var(--nession-control-md)] min-w-0 rounded-[var(--nession-radius-control)] border border-input bg-transparent px-3"
          onChange={(event) => {
            const id = event.target.value;
            if (id) {
              onChange({ kind: 'managed', workspace_id: id });
            }
          }}
        >
          <option value="">Select an existing Workspace…</option>
          {inventory.workspaces.map((item) => (
            <option key={item.workspace_id} value={item.workspace_id}>
              {item.name} · {item.status}
            </option>
          ))}
        </select>
      </label>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Input
          value={nameDraft}
          placeholder="New Workspace name"
          aria-label="New Workspace name"
          data-testid="sandbox-workspace-name"
          autoComplete="off"
          disabled={disabledReason !== null}
          onChange={(event) => setNameDraft(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="sandbox-workspace-use-name"
          disabled={disabledReason !== null || nameDraft.trim().length === 0}
          onClick={() => onChange({ kind: 'managed', name: nameDraft.trim() })}
        >
          Use name
        </Button>
      </div>
      {managedById ? (
        <p className="text-muted-foreground" data-testid="sandbox-workspace-managed-status">
          {selectedDescriptor
            ? `${selectedDescriptor.name} · ${selectedDescriptor.status}`
            : 'The Agent will verify this Workspace when it prepares Enter.'}
        </p>
      ) : managedByName ? (
        <p className="text-muted-foreground" data-testid="sandbox-workspace-managed-status">
          Created or reused by name when the Agent prepares Enter.
        </p>
      ) : null}
      {inventory.loading ? (
        <p className="text-muted-foreground" data-testid="sandbox-workspace-loading">
          Reading the Agent Workspace inventory…
        </p>
      ) : null}
    </div>
  );
}

function SelectedManaged({
  workspace,
  inventory,
  onChange,
}: {
  workspace: SandboxFilesystemWorkspace;
  inventory: AgentWorkspacesState;
  onChange: (workspace: SandboxFilesystemWorkspace | undefined) => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border px-3 py-2"
      data-testid="sandbox-workspace-managed-selected"
    >
      <p className={chromeSansRole('primary')}>{workspaceLabel(workspace)}</p>
      <p className="text-muted-foreground" data-testid="sandbox-workspace-managed-status">
        {workspace.kind === 'managed' && workspace.workspace_id
          ? (inventory.workspaces.find(
              (item) => item.workspace_id === workspace.workspace_id,
            )?.status ?? 'The Agent will verify this Workspace when it prepares Enter.')
          : workspace.kind === 'managed'
            ? 'Created or reused by name when the Agent prepares Enter.'
            : 'The Agent resolves this selection when it prepares Enter.'}
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="sandbox-workspace-managed-clear"
          onClick={() => onChange(undefined)}
        >
          Clear Workspace selection
        </Button>
      </div>
    </div>
  );
}

/**
 * Workspace (`/workspace`): the default working directory.
 *
 * The selection is one Agent resource: auto-allocation by Session name, the
 * Project's Existing Location (not yet resolved by the runtime), or an
 * Agent-managed Workspace by stable id or name. The inventory is read from
 * the Agent; this editor never creates a second registry.
 */
export function SandboxFilesystemWorkspaceSection({
  sessionId,
  workspace,
  rootfsIsImage,
  workingDir,
  workingDirError,
  onWorkingDirChange,
  onChange,
}: SandboxFilesystemWorkspaceProps) {
  const inventory = useAgentWorkspaces(sessionId);
  const managed = workspace?.kind === 'managed' ? workspace : null;
  const disabledReason = !rootfsIsImage
    ? 'A Workspace selection requires an image RootFS; choose a Base Runtime image in RootFS first.'
    : inventory.error
      ? inventory.error
      : null;

  return (
    <FormSection
      title="Workspace (/workspace)"
      description="The durable directory bound at /workspace and the default working directory after Enter. Managed Workspaces outlive the execution; cleanup releases the lease, not the bytes."
      testId="sandbox-workspace-section"
    >
      <div role="radiogroup" aria-label="Workspace source" className="flex flex-col gap-2">
        <Button
          type="button"
          role="radio"
          aria-checked={workspace === undefined}
          variant={workspace === undefined ? 'secondary' : 'outline'}
          className="justify-start"
          data-testid="sandbox-workspace-scratch"
          onClick={() => onChange(undefined)}
        >
          Execution scratch directory
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={workspace?.kind === 'auto'}
          variant={workspace?.kind === 'auto' ? 'secondary' : 'outline'}
          className="justify-start"
          data-testid="sandbox-workspace-auto"
          disabled={disabledReason !== null}
          onClick={() => onChange({ kind: 'auto' })}
        >
          Auto by Session name
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={false}
          variant="outline"
          className="justify-start"
          data-testid="sandbox-workspace-project"
          disabled
          title="The runtime does not resolve Project Location yet."
        >
          Project Location (not available yet)
        </Button>
        {managed ? (
          <SelectedManaged workspace={managed} inventory={inventory} onChange={onChange} />
        ) : (
          <ManagedWorkspacePicker
            inventory={inventory}
            managed={managed}
            disabledReason={disabledReason}
            onChange={onChange}
          />
        )}
        {disabledReason ? (
          <p className="text-muted-foreground" data-testid="sandbox-workspace-disabled-reason">
            {disabledReason}
          </p>
        ) : null}
      </div>

      <FormField
        id="sandbox-working-dir"
        label="Working directory"
        description="Empty uses /workspace when a Workspace is selected, otherwise the active Pane's current directory."
        error={workingDirError}
        errorTestId="sandbox-working-dir-error"
      >
        <Input
          id="sandbox-working-dir"
          data-testid="sandbox-working-dir"
          value={workingDir}
          placeholder={workspace ? '/workspace' : 'The active Pane’s current directory'}
          autoComplete="off"
          onChange={(event) => onWorkingDirChange(event.target.value)}
        />
      </FormField>
    </FormSection>
  );
}
