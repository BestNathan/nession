import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type {
  SandboxCurrentContext,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { FormSurface } from '@/components/ui/configuration-form';
import { DetailHeader, DetailSurface } from '@/components/ui/resource-detail';
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
  type SandboxTabId,
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
  onPreflight: () => void;
  onRequestEnter: () => void;
  onFocusPane: (paneId: string) => void;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  experience: 'web' | 'app';
  activeTab: SandboxTabId;
  onTabChange: (tab: SandboxTabId) => void;
}

function ComposerOverview({
  props,
  signature,
  preflightValid,
}: {
  props: SandboxComposerProps;
  signature: string;
  preflightValid: boolean;
}) {
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
    onTabChange,
  } = props;
  return (
    <DetailSurface>
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

      <SandboxPolicySummary policy={draft.draft} onSelectTab={onTabChange} />
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
 * The outside composer (#3124, #3143).
 *
 * The draft is explicit and shared across the six peer tabs. Tab switching is
 * local UI navigation: it preserves the draft and a fresh preflight, while any
 * actual edit invalidates the preflight. Enter is only reachable from the
 * Overview through a validation of the exact assembled payload.
 */
export function SandboxComposer(props: SandboxComposerProps) {
  const {
    context,
    draft,
    preflight,
    workingDir,
    onWorkingDirChange,
    confirming,
    onConfirm,
    onCancelConfirm,
    experience,
    activeTab,
    onTabChange,
  } = props;
  const signature = draftSignature(draft.draft);
  const preflightValid = preflightIsValid(
    preflight,
    signature,
    context.generation,
    context.catalog.probe_generation,
  );
  const fieldErrors = {
    ...fieldErrorsByField(preflight?.result.errors),
    ...(props.actionError?.fieldErrors ?? {}),
  };

  if (confirming) {
    return (
      <SandboxConfirmView
        draft={draft.draft}
        busy={props.busy}
        preflightValid={preflightValid}
        actionError={props.actionError}
        onConfirm={onConfirm}
        onCancel={onCancelConfirm}
      />
    );
  }

  const panels: Record<SandboxTabId, ReactNode> = {
    overview: (
      <ComposerOverview props={props} signature={signature} preflightValid={preflightValid} />
    ),
    filesystem: (
      <FormSurface>
        <SandboxFilesystemFields
          context={context}
          draft={draft}
          workingDir={workingDir}
          workingDirError={fieldErrors['working_dir']}
          onWorkingDirChange={onWorkingDirChange}
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
          title="Resource controls"
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
        value={activeTab}
        onValueChange={onTabChange}
        renderPanel={(tab) => panels[tab]}
      />
    </div>
  );
}
