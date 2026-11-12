import { Input } from '@/components/ui/input';
import {
  FormField,
  FormGrid,
  FormSection,
} from '@/components/ui/configuration-form';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import type { SandboxImagesState } from '../hooks/useSandboxImages';
import { filesystemDisabledReason, IMPLEMENTATION_PATHS } from '../model';
import { SandboxStringListEditor } from './SandboxStringListEditor';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';
import { SandboxImageComposition } from './SandboxImageComposition';

export interface SandboxFilesystemFieldsProps {
  context: SandboxCurrentContext;
  draft: SandboxDraftState;
  workingDir: string;
  workingDirError: string | undefined;
  onWorkingDirChange: (value: string) => void;
  images: SandboxImagesState;
}

/** Working directory and the explicit filesystem allow-list. */
export function SandboxFilesystemFields({
  context,
  draft,
  workingDir,
  workingDirError,
  onWorkingDirChange,
  images,
}: SandboxFilesystemFieldsProps) {
  const disabledReason = filesystemDisabledReason(context.catalog);
  return (
    <FormSection
      title="Filesystem access"
      description="Optional. One absolute host path per line. Leave both lists empty for no explicit allow-list; the backend baseline still applies."
    >
      <FormField
        id="sandbox-working-dir"
        label="Working directory"
        description="Empty uses the active Pane’s current directory. It must exist and be visible under the filesystem policy."
        error={workingDirError}
        errorTestId="sandbox-working-dir-error"
      >
        <Input
          id="sandbox-working-dir"
          data-testid="sandbox-working-dir"
          value={workingDir}
          placeholder={context.scope.working_dir ?? 'The active Pane’s current directory'}
          autoComplete="off"
          onChange={(event) => onWorkingDirChange(event.target.value)}
        />
      </FormField>

      <SandboxImplementationStatus
        catalog={context.catalog}
        path={IMPLEMENTATION_PATHS.filesystemAccess}
        label="Filesystem access"
      />
      <SandboxImageComposition
        context={context}
        draft={draft}
        images={images}
        workingDir={workingDir}
        onWorkingDirChange={onWorkingDirChange}
      />
      <FormGrid>
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
      </FormGrid>
    </FormSection>
  );
}
