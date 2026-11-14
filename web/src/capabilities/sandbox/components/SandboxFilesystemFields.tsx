import { Button } from '@/components/ui/button';
import {
  FormGrid,
  FormSection,
} from '@/components/ui/configuration-form';
import type {
  ImageCacheObservation,
  SandboxCurrentContext,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  IMPLEMENTATION_PATHS,
  accessConflictsWithDeclaration,
  filesystemDisabledReason,
} from '../model';
import { SandboxFilesystemMounts } from './SandboxFilesystemMounts';
import { SandboxFilesystemPreview } from './SandboxFilesystemPreview';
import { SandboxFilesystemRootfs } from './SandboxFilesystemRootfs';
import { SandboxFilesystemWorkspaceSection } from './SandboxFilesystemWorkspaceSection';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';
import { SandboxStringListEditor } from './SandboxStringListEditor';

export interface SandboxFilesystemFieldsProps {
  context: SandboxCurrentContext;
  sessionId: string | null;
  draft: SandboxDraftState;
  workingDir: string;
  workingDirError: string | undefined;
  onWorkingDirChange: (value: string) => void;
  observations: Map<string, ImageCacheObservation>;
}

/**
 * The Filesystem policy editor (#3405, #3408).
 *
 * Five always-visible sections in the canonical order — RootFS, Mounts,
 * Workspace, Access, Preview — over one shared draft. Access remains the V1
 * identity-path mapping and is mutually exclusive with an image RootFS; the
 * Preview is derived and never editable.
 */
export function SandboxFilesystemFields({
  context,
  sessionId,
  draft,
  workingDir,
  workingDirError,
  onWorkingDirChange,
  observations,
}: SandboxFilesystemFieldsProps) {
  const filesystem = draft.draft.filesystem ?? undefined;
  const accessDisabledReason = filesystemDisabledReason(context.catalog);
  const accessConflict = accessConflictsWithDeclaration(filesystem);
  const rootfs = filesystem?.rootfs ?? undefined;
  const mounts = filesystem?.mounts ?? [];

  return (
    <>
      <SandboxFilesystemRootfs
        context={context}
        rootfs={rootfs}
        observation={
          rootfs?.kind === 'image' ? observations.get(rootfs.digest) : undefined
        }
        onChange={(next) => draft.setFilesystemRootfs(next)}
      />
      <SandboxFilesystemMounts
        mounts={mounts}
        observations={observations}
        onAdd={(mount) => draft.addMount(mount)}
        onTargetChange={(index, target) => draft.updateMountTarget(index, target)}
        onRemove={(index) => draft.removeMount(index)}
      />
      <SandboxFilesystemWorkspaceSection
        sessionId={sessionId}
        workspace={filesystem?.workspace ?? undefined}
        rootfsIsImage={rootfs?.kind === 'image'}
        workingDir={workingDir}
        workingDirError={workingDirError}
        onWorkingDirChange={onWorkingDirChange}
        onChange={(next) => draft.setFilesystemWorkspace(next)}
      />
      <FormSection
        title="Access"
        description="V1 identity-path mapping on this Agent. One absolute host path per line; overlapping read and write trees are refused. Access is replaced by an image RootFS and cannot be combined with one."
        testId="sandbox-filesystem-access"
      >
        <SandboxImplementationStatus
          catalog={context.catalog}
          path={IMPLEMENTATION_PATHS.filesystemAccess}
          label="Filesystem access"
        />
        {accessConflict ? (
          <div className="flex flex-col gap-2" data-testid="sandbox-filesystem-access-conflict">
            <p className={cn('text-destructive', chromeSansRole('secondary'))}>
              The image RootFS/mounted Workspace replaces Filesystem access. Clear the read-only
              and read-write path lists before Enter.
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="sandbox-filesystem-clear-access"
                onClick={() => draft.clearFilesystemAccess()}
              >
                Clear access lists
              </Button>
            </div>
          </div>
        ) : (
          <FormGrid>
            <SandboxStringListEditor
              title="Read-only paths"
              items={filesystem?.access.read ?? []}
              placeholder="/usr"
              addLabel="Add read-only path"
              testIdPrefix="sandbox-fs-read"
              emptyText="No explicit read-only allow-list; the backend baseline applies."
              disabledReason={accessDisabledReason}
              onAdd={() => draft.addFilesystemPath('read')}
              onChange={(index, value) => draft.updateFilesystemPath('read', index, value)}
              onRemove={(index) => draft.removeFilesystemPath('read', index)}
            />
            <SandboxStringListEditor
              title="Read-write paths"
              items={filesystem?.access.write ?? []}
              placeholder="/workspace"
              addLabel="Add read-write path"
              testIdPrefix="sandbox-fs-write"
              emptyText="No explicit read-write allow-list."
              disabledReason={accessDisabledReason}
              onAdd={() => draft.addFilesystemPath('write')}
              onChange={(index, value) => draft.updateFilesystemPath('write', index, value)}
              onRemove={(index) => draft.removeFilesystemPath('write', index)}
            />
          </FormGrid>
        )}
      </FormSection>
      <SandboxFilesystemPreview filesystem={filesystem} />
    </>
  );
}
