import { Badge } from '@/components/ui/badge';
import type {
  SandboxCurrentContext,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  draftSignature,
  fieldErrorsByField,
  IMPLEMENTATION_PATHS,
  preflightIsValid,
  type SandboxActionError,
} from '../model';
import { SandboxComposerActions } from './SandboxComposerActions';
import { SandboxConfirmView } from './SandboxConfirmView';
import { SandboxExistingPanes } from './SandboxExistingPanes';
import { SandboxFilesystemFields } from './SandboxFilesystemFields';
import { SandboxKvEditor } from './SandboxKvEditor';
import { SandboxNetworkProcessFields } from './SandboxNetworkProcessFields';

export type { SandboxActionError } from '../model';

export interface SandboxComposerProps {
  context: SandboxCurrentContext;
  draft: SandboxDraftState;
  preflight: { signature: string; result: SandboxPreflightResult } | null;
  preflightBusy: boolean;
  busy: boolean;
  actionError: SandboxActionError | null;
  workingDir: string;
  onWorkingDirChange: (value: string) => void;
  onPreflight: () => void;
  onRequestEnter: () => void;
  onFocusPane: (paneId: string) => void;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}

/**
 * The outside composer (#3124).
 *
 * The draft is explicit: no path, namespace, Resource key, Syscall key or
 * profile is preselected. Editing any control invalidates the preflight, so
 * Enter is only reachable through a fresh validation of the exact draft on
 * screen.
 */
export function SandboxComposer({
  context,
  draft,
  preflight,
  preflightBusy,
  busy,
  actionError,
  workingDir,
  onWorkingDirChange,
  onPreflight,
  onRequestEnter,
  onFocusPane,
  confirming,
  onConfirm,
  onCancelConfirm,
}: SandboxComposerProps) {
  const signature = draftSignature(draft.draft);
  const preflightValid = preflightIsValid(
    preflight,
    signature,
    context.generation,
    context.catalog.probe_generation,
  );
  const fieldErrors = {
    ...fieldErrorsByField(preflight?.result.errors),
    ...(actionError?.fieldErrors ?? {}),
  };

  if (confirming) {
    return (
      <SandboxConfirmView
        draft={draft.draft}
        busy={busy}
        preflightValid={preflightValid}
        actionError={actionError}
        onConfirm={onConfirm}
        onCancel={onCancelConfirm}
      />
    );
  }

  return (
    <div data-testid="sandbox-composer" className="flex min-w-0 flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={chromeSansRole('title')}>Outside Sandbox</h2>
          <Badge data-testid="sandbox-status" variant="outline">
            outside
          </Badge>
        </div>
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          Compose a policy for a new isolated Pane in this Session. Nothing is preselected:
          optional groups stay empty until you add them, and the backend baseline still applies.
        </p>
        {context.reason ? (
          <p data-testid="sandbox-reason" className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            {context.reason}
          </p>
        ) : null}
      </header>

      <SandboxFilesystemFields
        context={context}
        draft={draft}
        workingDir={workingDir}
        workingDirError={fieldErrors['working_dir']}
        onWorkingDirChange={onWorkingDirChange}
      />

      <SandboxNetworkProcessFields draft={draft} catalog={context.catalog} />

      <SandboxKvEditor
        group="resource"
        title="Resource controls"
        description="Optional cgroup v2 control files, in their native kernel format. Empty omits the Resource group."
        rows={draft.draft.resource}
        catalog={context.catalog}
        implementationPath={IMPLEMENTATION_PATHS.cgroupV2}
        errors={fieldErrors}
        onAdd={() => draft.addRow('resource')}
        onChange={(index, patch) => draft.updateRow('resource', index, patch)}
        onRemove={(index) => draft.removeRow('resource', index)}
      />

      <SandboxKvEditor
        group="syscall"
        title="Syscall controls"
        description="Only the Agent's registered seccomp profiles are accepted. Empty omits the Syscall group."
        rows={draft.draft.syscall}
        catalog={context.catalog}
        implementationPath={IMPLEMENTATION_PATHS.seccomp}
        errors={fieldErrors}
        onAdd={() => draft.addRow('syscall')}
        onChange={(index, patch) => draft.updateRow('syscall', index, patch)}
        onRemove={(index) => draft.removeRow('syscall', index)}
      />

      <SandboxComposerActions
        preflight={preflight}
        preflightFresh={preflight !== null && preflight.signature === signature}
        preflightValid={preflightValid}
        preflightBusy={preflightBusy}
        busy={busy}
        actionError={actionError}
        catalogStatus={context.catalog.status}
        catalogReason={context.catalog.reason}
        onPreflight={onPreflight}
        onRequestEnter={onRequestEnter}
      />

      <SandboxExistingPanes panes={context.sandbox_panes} busy={busy} onFocus={onFocusPane} />
    </div>
  );
}
