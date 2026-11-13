import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type {
  ImageCacheObservation,
  SandboxCurrentContext,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { FormSurface } from '@/components/ui/configuration-form';
import { DetailHeader, DetailSurface } from '@/components/ui/resource-detail';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  sandboxDraftSignature,
  fieldErrorsByField,
  IMPLEMENTATION_PATHS,
  preflightIsValid,
  type SandboxActionError,
} from '../model';
import { SandboxComposerActions } from './SandboxComposerActions';
import { SandboxExistingPanes } from './SandboxExistingPanes';
import { SandboxSyscallProfile } from './SandboxSyscallProfile';
import { SandboxFilesystemFields } from './SandboxFilesystemFields';
import { SandboxKvEditor } from './SandboxKvEditor';
import {
  SandboxNetworkFields,
  SandboxProcessFields,
} from './SandboxNetworkProcessFields';
import {
  SandboxPolicyPreview,
  SandboxPolicySummary,
} from './SandboxPolicySummary';
import {
  SandboxPolicyTabs,
  type SandboxPolicyId,
} from './SandboxPolicyTabs';

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
  sessionId: string | null;
  observations: Map<string, ImageCacheObservation>;
  onPreflight: () => void;
  onRequestEnter: () => void;
  onFocusPane: (paneId: string) => void;
  experience: 'web' | 'app';
  activePolicy: SandboxPolicyId;
  onPolicyChange: (policy: SandboxPolicyId) => void;
}

/** The Sandbox Overview's policy summary, preview, actions and panes. */
export function SandboxOverview(props: SandboxComposerProps) {
  const signature = sandboxDraftSignature(props.draft.draft);
  const preflightValid = preflightIsValid(
    props.preflight,
    signature,
    props.context.generation,
    props.context.catalog.probe_generation,
  );
  const {
    context,
    draft,
    preflight,
    preflightBusy,
    busy,
    actionError,
    onPreflight,
    onRequestEnter,
    onFocusPane,
    onPolicyChange,
  } = props;
  return (
    <DetailSurface data-testid="sandbox-composer">
      <DetailHeader
        level="h2"
        title="Outside Sandbox"
        badges={
          <Badge data-testid="sandbox-status" variant="outline">
            outside
          </Badge>
        }
        description={
          <>
            Compose a policy for a new isolated Pane in this Session. Nothing is preselected:
            optional groups stay empty until you add them, and the backend baseline still applies.
            {context.reason ? (
              <span data-testid="sandbox-reason" className="mt-1 block">
                {context.reason}
              </span>
            ) : null}
          </>
        }
      />

      <SandboxPolicySummary policy={draft.draft} onSelectTab={onPolicyChange} />
      <SandboxPolicyPreview policy={draft.draft} />

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
    </DetailSurface>
  );
}

function KvPanel({
  props,
  group,
  title,
  description,
  implementationPath,
  fieldErrors,
}: {
  props: SandboxComposerProps;
  group: 'resource' | 'syscall';
  title: string;
  description: string;
  implementationPath: string;
  fieldErrors: Record<string, string>;
}) {
  const { context, draft } = props;
  return (
    <SandboxKvEditor
      group={group}
      title={title}
      description={description}
      rows={draft.draft[group]}
      catalog={context.catalog}
      implementationPath={implementationPath}
      errors={fieldErrors}
      onAdd={() => draft.addRow(group)}
      onChange={(index, patch) => draft.updateRow(group, index, patch)}
      onRemove={(index) => draft.removeRow(group, index)}
    />
  );
}

/**
 * The five policy entries (#3408, superseding #3143's six peer tabs).
 *
 * The draft is shared across the entries. Switching is local UI navigation:
 * it preserves the draft and a fresh preflight, while any actual edit
 * invalidates the preflight.
 */
export function SandboxPolicyPanels(props: SandboxComposerProps) {
  const {
    context,
    draft,
    preflight,
    workingDir,
    onWorkingDirChange,
    sessionId,
    observations,
    experience,
    activePolicy,
    onPolicyChange,
  } = props;
  const fieldErrors = {
    ...fieldErrorsByField(preflight?.result.errors),
    ...(props.actionError?.fieldErrors ?? {}),
  };

  const panels: Record<SandboxPolicyId, ReactNode> = {
    filesystem: (
      <FormSurface>
        <SandboxFilesystemFields
          context={context}
          sessionId={sessionId}
          draft={draft}
          workingDir={workingDir}
          workingDirError={fieldErrors['working_dir']}
          onWorkingDirChange={onWorkingDirChange}
          observations={observations}
        />
      </FormSurface>
    ),
    network: (
      <FormSurface>
        <SandboxNetworkFields draft={draft} catalog={context.catalog} />
      </FormSurface>
    ),
    process: (
      <FormSurface>
        <SandboxProcessFields draft={draft} catalog={context.catalog} />
      </FormSurface>
    ),
    resource: (
      <FormSurface>
        <KvPanel
          props={props}
          group="resource"
          title="Cgroup v2 controls"
          description="Optional cgroup v2 control files, in their native kernel format. Empty omits the Resource group."
          implementationPath={IMPLEMENTATION_PATHS.cgroupV2}
          fieldErrors={fieldErrors}
        />
      </FormSurface>
    ),
    syscall: (
      <FormSurface>
        <SandboxSyscallProfile draft={draft} catalog={context.catalog} />
      </FormSurface>
    ),
  };

  return (
    <div
      data-testid="sandbox-composer"
      className={cn(
        'flex min-w-0 flex-col',
        experience === 'web' && 'min-h-0 flex-1',
      )}
    >
      <SandboxPolicyTabs
        experience={experience}
        value={activePolicy}
        onValueChange={onPolicyChange}
        renderPanel={(policy) => panels[policy]}
      />
    </div>
  );
}
