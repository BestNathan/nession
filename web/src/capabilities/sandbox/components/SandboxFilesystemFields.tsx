import { Input } from '@/components/ui/input';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import { filesystemDisabledReason, IMPLEMENTATION_PATHS } from '../model';
import { SandboxStringListEditor } from './SandboxStringListEditor';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';

export interface SandboxFilesystemFieldsProps {
  context: SandboxCurrentContext;
  draft: SandboxDraftState;
  workingDir: string;
  workingDirError: string | undefined;
  onWorkingDirChange: (value: string) => void;
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
    >
      {children}
    </label>
  );
}

/** Working directory and the explicit filesystem allow-list. */
export function SandboxFilesystemFields({
  context,
  draft,
  workingDir,
  workingDirError,
  onWorkingDirChange,
}: SandboxFilesystemFieldsProps) {
  const disabledReason = filesystemDisabledReason(context.catalog);
  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor="sandbox-working-dir">Working directory</FieldLabel>
        <Input
          id="sandbox-working-dir"
          data-testid="sandbox-working-dir"
          value={workingDir}
          placeholder={context.scope.working_dir ?? 'The active Pane’s current directory'}
          autoComplete="off"
          onChange={(event) => onWorkingDirChange(event.target.value)}
        />
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          Empty uses the active Pane’s current directory. It must exist and be visible under the
          filesystem policy.
        </p>
        {workingDirError ? (
          <p
            data-testid="sandbox-working-dir-error"
            className={cn(chromeSansRole('caption'), 'text-destructive')}
          >
            {workingDirError}
          </p>
        ) : null}
      </div>

      <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3">
        <legend className={cn(chromeSansRole('primary'), 'px-1')}>Filesystem access</legend>
        <SandboxImplementationStatus
          catalog={context.catalog}
          path={IMPLEMENTATION_PATHS.filesystemAccess}
          label="Filesystem access"
        />
        <SandboxImplementationStatus
          catalog={context.catalog}
          path={IMPLEMENTATION_PATHS.filesystemComposition}
          label="Prepared root composition (Server/Agent input, not editable)"
        />
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          One absolute host path per line. Leave both empty for no explicit allow-list; the
          backend baseline still applies.
        </p>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SandboxStringListEditor
              title="Read-only paths"
              items={draft.draft.filesystem?.access.read ?? []}
              placeholder="/usr"
              addLabel="Add read-only path"
              testIdPrefix="sandbox-fs-read"
              emptyText="No explicit read-only allow-list; the backend baseline applies."
              disabledReason={disabledReason}
              onAdd={() => draft.addFilesystemPath('read')}
              onChange={(index, value) => draft.updateFilesystemPath('read', index, value)}
              onRemove={(index) => draft.removeFilesystemPath('read', index)}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SandboxStringListEditor
              title="Read-write paths"
              items={draft.draft.filesystem?.access.write ?? []}
              placeholder="/workspace"
              addLabel="Add read-write path"
              testIdPrefix="sandbox-fs-write"
              emptyText="No explicit read-write allow-list."
              disabledReason={disabledReason}
              onAdd={() => draft.addFilesystemPath('write')}
              onChange={(index, value) => draft.updateFilesystemPath('write', index, value)}
              onRemove={(index) => draft.removeFilesystemPath('write', index)}
            />
          </div>
        </div>
      </fieldset>
    </>
  );
}
