import { useState } from 'react';
import { Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormSection } from '@/components/ui/configuration-form';
import { shortDigest, type ImageDescriptor } from '@/capabilities/images';
import type {
  ImageCacheObservation,
  SandboxCurrentContext,
  SandboxFilesystemRoot,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import {
  IMPLEMENTATION_PATHS,
  formatBytes,
  observationPhaseLabel,
} from '../model';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';
import { SandboxImageSelectDialog } from './SandboxImageSelectDialog';

export interface SandboxFilesystemRootfsProps {
  context: SandboxCurrentContext;
  rootfs: SandboxFilesystemRoot | undefined;
  observation: ImageCacheObservation | undefined;
  onChange: (rootfs: SandboxFilesystemRoot | undefined) => void;
}

/**
 * RootFS (`/`): the ordinary host-root baseline or one Base Runtime EROFS.
 *
 * The image is read-only at `/` and is not a general image picker: its digest
 * is pinned here, and the Agent refuses an image it has not cached/verified.
 */
export function SandboxFilesystemRootfs({
  context,
  rootfs,
  observation,
  onChange,
}: SandboxFilesystemRootfsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const image = rootfs?.kind === 'image' ? rootfs : null;
  const local = !image;

  const choose = (selected: ImageDescriptor) => {
    if (!selected.digest) {
      return;
    }
    onChange({ kind: 'image', digest: selected.digest });
  };

  return (
    <FormSection
      title="RootFS (/)"
      description="Local uses the ordinary host-root baseline; an image root is one immutable Base Runtime EROFS mounted read-only at /."
      testId="sandbox-rootfs"
    >
      <div role="radiogroup" aria-label="RootFS source" className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          role="radio"
          aria-checked={local}
          variant={local ? 'secondary' : 'outline'}
          data-testid="sandbox-rootfs-local"
          onClick={() => onChange({ kind: 'local' })}
        >
          Local
        </Button>
        <Button
          type="button"
          size="sm"
          role="radio"
          aria-checked={image !== null}
          variant={image ? 'secondary' : 'outline'}
          data-testid="sandbox-rootfs-image"
          onClick={() => setDialogOpen(true)}
        >
          <ImageIcon aria-hidden="true" /> Base Runtime image
        </Button>
      </div>

      {image ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] border border-border px-3 py-2"
          data-testid="sandbox-rootfs-selected"
        >
          <div className="min-w-0">
            <p className={cn('truncate', chromeSansRole('primary'))}>Base Runtime · /</p>
            <p className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
              {shortDigest(image.digest)}
            </p>
            <p className="text-muted-foreground" data-testid="sandbox-rootfs-cache">
              {observation
                ? `${observationPhaseLabel(observation.phase)} · ${formatBytes(
                    observation.downloaded_bytes,
                  )}`
                : 'Agent cache not reported'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Change Base Runtime image"
              data-testid="sandbox-rootfs-change"
              onClick={() => setDialogOpen(true)}
            >
              <Plus aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Remove Base Runtime image"
              data-testid="sandbox-rootfs-remove"
              onClick={() => onChange(undefined)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          The execution uses the ordinary host-root Sandbox policy.
        </p>
      )}

      <SandboxImplementationStatus
        catalog={context.catalog}
        path={IMPLEMENTATION_PATHS.composition}
        label="Prepared image root"
      />
      <SandboxImageSelectDialog
        open={dialogOpen}
        title="Select a Base Runtime image"
        requireTarget={false}
        submitLabel="Use as RootFS"
        onSelect={(selected) => choose(selected)}
        onClose={() => setDialogOpen(false)}
      />
    </FormSection>
  );
}
