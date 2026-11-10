import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import { entriesToLines, filesystemDisabledReason, IMPLEMENTATION_PATHS } from '../model';
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
  const disabled = disabledReason !== null;
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
            <FieldLabel htmlFor="sandbox-fs-read">Read-only paths</FieldLabel>
            <Textarea
              id="sandbox-fs-read"
              data-testid="sandbox-fs-read"
              rows={3}
              disabled={disabled}
              value={entriesToLines(draft.draft.filesystem?.access.read ?? [])}
              onChange={(event) => draft.setFilesystemPaths('read', event.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <FieldLabel htmlFor="sandbox-fs-write">Read-write paths</FieldLabel>
            <Textarea
              id="sandbox-fs-write"
              data-testid="sandbox-fs-write"
              rows={3}
              disabled={disabled}
              value={entriesToLines(draft.draft.filesystem?.access.write ?? [])}
              onChange={(event) => draft.setFilesystemPaths('write', event.target.value)}
            />
          </div>
        </div>
      </fieldset>
    </>
  );
}
