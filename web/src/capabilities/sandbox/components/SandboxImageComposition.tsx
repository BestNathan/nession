import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FormSection } from '@/components/ui/configuration-form';
import {
  cacheStateLabel,
  imageServerStatusLabel,
  shortDigest,
} from '@/capabilities/images';
import type {
  SandboxCurrentContext,
  SandboxImageSelection,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import type { SandboxImagesState } from '../hooks/useSandboxImages';
import { IMPLEMENTATION_PATHS, implementationDisabledReason } from '../model';
import { SandboxImagePicker } from './SandboxImagePicker';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';

function selectionLabel(selection: SandboxImageSelection): string {
  switch (selection.role) {
    case 'base':
      return 'Base Runtime · /';
    case 'workspace':
      return 'Workspace · /workspace';
    case 'toolchain':
      return `Toolchain · ${selection.target ?? '/opt/?'}`;
  }
}

function SelectedImages({ images }: { images: SandboxImagesState }) {
  if (images.selections.length === 0) {
    return (
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        No images selected. The execution uses the ordinary host-root Sandbox policy.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {images.selections.map((selection, index) => {
        const cache = images.cacheStatuses.get(selection.digest);
        const serverStatus = images.serverStatuses.get(selection.digest);
        return (
          <li
            key={`${selection.digest}-${selection.target ?? selection.role}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] border border-border px-3 py-2"
            data-testid="sandbox-image-selection"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className={cn('truncate', chromeSansRole('primary'))}>
                  {selectionLabel(selection)}
                </p>
                {serverStatus ? (
                  <Badge
                    variant={serverStatus === 'ready' ? 'secondary' : 'outline'}
                    data-testid="sandbox-image-server"
                  >
                    {imageServerStatusLabel(serverStatus)}
                  </Badge>
                ) : null}
              </div>
              <p className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
                {shortDigest(selection.digest)} ·{' '}
                {selection.mode === 'overlay' ? 'overlay' : 'read-only'}
              </p>
              <p className="text-muted-foreground" data-testid="sandbox-image-cache">
                {images.cacheLoading
                  ? 'Checking Agent cache…'
                  : cache
                    ? cacheStateLabel(cache.state)
                    : images.cacheError
                      ? 'Agent cache unavailable'
                      : 'Agent cache not reported'}
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Remove ${selectionLabel(selection)}`}
              data-testid="sandbox-image-remove"
              onClick={() => images.remove(index)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sandbox-owned image composition (#3181).
 *
 * The Filesystem tab names the composition, its pinned digests and the Agent
 * cache observation. It is not the Project selector, and it never exposes the
 * Agent's native image paths.
 */
export function SandboxImageComposition({
  context,
  draft,
  images,
  workingDir,
  onWorkingDirChange,
}: {
  context: SandboxCurrentContext;
  draft: SandboxDraftState;
  images: SandboxImagesState;
  workingDir: string;
  onWorkingDirChange: (value: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const compositionReason = implementationDisabledReason(
    context.catalog,
    IMPLEMENTATION_PATHS.composition,
  );
  const accessConflict =
    images.selections.length > 0
    && ((draft.draft.filesystem?.access.read.length ?? 0) > 0
      || (draft.draft.filesystem?.access.write.length ?? 0) > 0);
  const missingBase =
    images.selections.length > 0
    && !images.selections.some((selection) => selection.role === 'base');
  const workingDirNeedsReset = images.selections.length > 0 && workingDir.trim() === '';

  return (
    <FormSection
      title="Image composition"
      description="Optional EROFS root composition. Select a Base Runtime image plus optional workspace and /opt toolchains. This is independent of the Project image reference."
    >
      <SandboxImplementationStatus
        catalog={context.catalog}
        path={IMPLEMENTATION_PATHS.composition}
        label="Prepared root composition"
      />
      <div className="flex flex-col gap-2" data-testid="sandbox-image-composition">
        <SelectedImages images={images} />
        {missingBase ? (
          <p className="text-destructive" data-testid="sandbox-image-missing-base">
            A composition requires one Base Runtime image with target /.
          </p>
        ) : null}
        {accessConflict ? (
          <div className="flex flex-col gap-2" data-testid="sandbox-image-access-conflict">
            <p className="text-destructive">
              Image composition replaces Filesystem access. Clear the read-only and read-write
              path lists before Enter.
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="sandbox-image-clear-access"
                onClick={() => draft.clearFilesystemAccess()}
              >
                Clear filesystem access lists
              </Button>
            </div>
          </div>
        ) : null}
        {workingDirNeedsReset ? (
          <div className="flex flex-col gap-2" data-testid="sandbox-image-working-dir">
            <p className="text-muted-foreground">
              A composed root starts at /workspace. Set the working directory before Enter.
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onWorkingDirChange('/workspace')}
              >
                Use /workspace
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="sandbox-image-add-open"
            disabled={compositionReason !== null || accessConflict}
            onClick={() => setPickerOpen(true)}
          >
            <Plus aria-hidden="true" /> Add image
          </Button>
          {compositionReason ? (
            <span className="text-muted-foreground" data-testid="sandbox-image-unsupported">
              {compositionReason}
            </span>
          ) : null}
        </div>
      </div>
      <SandboxImagePicker
        open={pickerOpen}
        images={images}
        onClose={() => setPickerOpen(false)}
      />
    </FormSection>
  );
}
