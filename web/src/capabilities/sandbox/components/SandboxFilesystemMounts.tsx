import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/configuration-form';
import { shortDigest, type ImageLibraryEntry } from '@/capabilities/images';
import type {
  ImageCacheObservation,
  SandboxMount,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import {
  formatBytes,
  mountTargetError,
  observationPhaseLabel,
} from '../model';
import { SandboxImageSelectDialog } from './SandboxImageSelectDialog';

export interface SandboxFilesystemMountsProps {
  sessionId: string | null;
  targetPlatform: string | null;
  mounts: readonly SandboxMount[];
  observations: Map<string, ImageCacheObservation>;
  onAdd: (mount: SandboxMount) => void;
  onTargetChange: (index: number, target: string) => void;
  onRemove: (index: number) => void;
}

function toMount(
  entry: ImageLibraryEntry,
  target: string | null,
): SandboxMount | null {
  if (!entry.image.digest || !target) {
    return null;
  }
  return {
    source: { kind: 'image', digest: entry.image.digest },
    target,
    read_only: true,
  };
}

function duplicateTargets(mounts: readonly SandboxMount[]): Set<number> {
  const seen = new Map<string, number>();
  const duplicates = new Set<number>();
  mounts.forEach((mount, index) => {
    const target = mount.target.trim();
    const first = seen.get(target);
    if (first !== undefined) {
      duplicates.add(first);
      duplicates.add(index);
    } else {
      seen.set(target, index);
    }
  });
  return duplicates;
}

/**
 * Additional read-only image mounts (#3405).
 *
 * Each row pins one immutable image at a validated `/opt/<name>` target. The
 * mount is read-only in the first implementation; the editor never accepts a
 * writable mount or an arbitrary target.
 */
export function SandboxFilesystemMounts({
  sessionId,
  targetPlatform,
  mounts,
  observations,
  onAdd,
  onTargetChange,
  onRemove,
}: SandboxFilesystemMountsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const duplicates = duplicateTargets(mounts);

  return (
    <FormSection
      title="Mounts"
      description="Optional read-only image mounts at /opt/<lowercase-name>. The Base Runtime root owns each target directory; mounts are never writable in this version."
      testId="sandbox-mounts"
    >
      {mounts.length === 0 ? (
        <p
          className={cn('text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="sandbox-mounts-empty"
        >
          No additional image mounts.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="sandbox-mounts-list">
          {mounts.map((mount, index) => {
            const observation = observations.get(mount.source.digest);
            const targetError = mountTargetError(mount.target);
            const duplicate = duplicates.has(index);
            return (
              <li
                key={`${mount.source.digest}-${index}`}
                data-testid="sandbox-mount-row"
                className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className={cn('truncate', chromeMonoRole('code'))}>
                      {shortDigest(mount.source.digest)}
                    </p>
                    <p className="text-muted-foreground" data-testid={`sandbox-mount-cache-${index}`}>
                      {observation
                        ? `${observationPhaseLabel(observation.phase)} · ${formatBytes(
                            observation.downloaded_bytes,
                          )}`
                        : 'Agent cache not reported'}
                    </p>
                  </div>
                  <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                    read-only
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove mount ${index + 1}`}
                    data-testid={`sandbox-mount-remove-${index}`}
                    onClick={() => onRemove(index)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                    Target
                  </span>
                  <Input
                    value={mount.target}
                    aria-label={`Mount target ${index + 1}`}
                    aria-invalid={targetError !== null || duplicate}
                    data-testid={`sandbox-mount-target-${index}`}
                    onChange={(event) => onTargetChange(index, event.target.value)}
                  />
                </label>
                {targetError ? (
                  <p className="text-destructive" data-testid={`sandbox-mount-target-error-${index}`}>
                    {targetError}
                  </p>
                ) : duplicate ? (
                  <p className="text-destructive" data-testid={`sandbox-mount-target-error-${index}`}>
                    Another mount already uses this target.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="sandbox-mount-add"
          onClick={() => setDialogOpen(true)}
        >
          <Plus aria-hidden="true" /> Add image mount
        </Button>
      </div>
      <SandboxImageSelectDialog
        open={dialogOpen}
        title="Mount a Toolchain image"
        role="toolchain"
        sessionId={sessionId}
        targetPlatform={targetPlatform}
        requireTarget
        submitLabel="Add mount"
        onSelect={(entry, target) => {
          const mount = toMount(entry, target);
          if (mount) {
            onAdd(mount);
          }
        }}
        onClose={() => setDialogOpen(false)}
      />
    </FormSection>
  );
}
