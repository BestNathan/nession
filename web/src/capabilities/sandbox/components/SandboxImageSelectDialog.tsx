import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import type { ImageCacheObservation } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageExecutionBarrier,
  imagePlatformCompatible,
  imageRoleCompatible,
  imageRoleLabel,
  imagesApi,
  libraryImageRole,
  representationLabel,
  shortDigest,
  sourceLabel,
  type ImageLibraryEntry,
} from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { formatBytes, mountTargetError, observationPhaseLabel } from '../model';
import { useImageCacheObservations } from '../hooks/useImageCacheObservations';

/** The role one consumer picker offers (#3793). */
export type SandboxImagePickerRole = 'base' | 'toolchain';

const EXPECTED_ROLE = {
  base: 'base_runtime',
  toolchain: 'tool',
} as const;

function roleTitle(role: SandboxImagePickerRole): string {
  return role === 'base' ? 'Base Runtime' : 'Toolchain';
}

function entryBlockReason(
  entry: ImageLibraryEntry,
  role: SandboxImagePickerRole,
  targetPlatform: string | null | undefined,
): string | null {
  if (entry.image.status !== 'ready') {
    return 'The Server has not published immutable bytes for this image.';
  }
  if (!imageRoleCompatible(entry, EXPECTED_ROLE[role])) {
    return `Not a ${roleTitle(role)} image (${imageRoleLabel(libraryImageRole(entry))}).`;
  }
  const barrier = imageExecutionBarrier(entry);
  if (barrier) {
    return barrier;
  }
  if (!imagePlatformCompatible(entry, targetPlatform)) {
    return `Platform ${entry.platform} does not match this Agent (${targetPlatform}).`;
  }
  return null;
}

function cacheLabel(
  sessionId: string | null,
  observation: ImageCacheObservation | undefined,
): string {
  if (sessionId === null) {
    return 'Agent cache not observed (no Session)';
  }
  if (!observation) {
    return 'Agent cache not reported';
  }
  const bytes = observation.downloaded_bytes
    ? ` · ${formatBytes(observation.downloaded_bytes)}`
    : '';
  return `${observationPhaseLabel(observation.phase)}${bytes}`;
}

function RegistryRow({
  entry,
  selected,
  blockReason,
  cache,
  onSelect,
}: {
  entry: ImageLibraryEntry;
  selected: boolean;
  blockReason: string | null;
  cache: string;
  onSelect: () => void;
}) {
  const aliases = imageAliases(entry.image);
  return (
    <button
      type="button"
      data-testid="sandbox-image-row"
      data-selected={selected ? 'true' : undefined}
      data-image-role={libraryImageRole(entry) ?? 'unknown'}
      data-image-representation={entry.representation}
      data-image-platform={entry.platform ?? ''}
      data-image-blocked={blockReason ? 'true' : undefined}
      disabled={blockReason !== null}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1 border-b border-border px-2 py-2 text-left last:border-b-0 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60',
        selected && 'bg-muted',
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className={cn('truncate', chromeSansRole('primary'))}>
          {aliases[0] ?? entry.image.image_id}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Badge variant={entry.image.status === 'ready' ? 'secondary' : 'outline'}>
            {entry.image.status === 'ready'
              ? 'Server Ready'
              : entry.image.status === 'failed'
                ? 'Failed'
                : 'Building'}
          </Badge>
          <Badge variant="outline">{imageRoleLabel(libraryImageRole(entry))}</Badge>
        </span>
      </span>
      <span className="truncate text-muted-foreground">{sourceLabel(entry.image)}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span data-testid="sandbox-image-platform">
          {entry.platform ?? 'Platform unknown'}
        </span>
        <span data-testid="sandbox-image-representation">
          {representationLabel(entry.representation)}
        </span>
        <span className={cn('truncate', chromeMonoRole('code'))}>
          {shortDigest(entry.image.digest)}
        </span>
      </span>
      <span className="text-muted-foreground" data-testid="sandbox-image-cache">
        {cache}
      </span>
      {blockReason ? (
        <span className="text-destructive" data-testid="sandbox-image-blocked-reason">
          {blockReason}
        </span>
      ) : null}
    </button>
  );
}

function RegistryPager({
  offset,
  shown,
  total,
  loading,
  onPrevious,
  onNext,
}: {
  offset: number;
  shown: number;
  total: number;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2" data-testid="sandbox-image-page-label">
      <span className="text-muted-foreground">
        {total === 0 ? '0 images' : `${offset + 1}–${offset + shown} of ${total}`}
      </span>
      <span className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={offset === 0 || loading}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={offset + shown >= total || loading}
          onClick={onNext}
        >
          Next
        </Button>
      </span>
    </div>
  );
}

interface RegistryProps {
  open: boolean;
  role: SandboxImagePickerRole;
  sessionId: string | null;
  targetPlatform?: string | null;
  selected: ImageLibraryEntry | null;
  onSelect: (entry: ImageLibraryEntry | null) => void;
}

function Registry({
  open,
  role,
  sessionId,
  targetPlatform,
  selected,
  onSelect,
}: RegistryProps) {
  const [entries, setEntries] = useState<ImageLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const load = (nextOffset: number, nextQuery: string) => {
    setLoading(true);
    setError(null);
    imagesApi
      .listLibrary({ offset: nextOffset, limit: IMAGE_PAGE_SIZE, query: nextQuery })
      .then((page) => {
        setEntries(page.entries);
        setTotal(page.total);
      })
      .catch((cause: unknown) => {
        setEntries([]);
        setTotal(0);
        setError(cause instanceof Error ? cause.message : 'Images could not be loaded');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) {
      setOffset(0);
      setQuery('');
      load(0, '');
    }
  }, [open, revision]);

  const digests = useMemo(
    () => entries.flatMap((entry) => (entry.image.digest ? [entry.image.digest] : [])),
    [entries],
  );
  const observations = useImageCacheObservations(sessionId, digests).observations;

  return (
    <>
      <Input
        type="search"
        value={query}
        placeholder="Search alias, digest, tag or source"
        aria-label={`Search ${roleTitle(role)} images`}
        data-testid="sandbox-image-search"
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          setOffset(0);
          load(0, next);
        }}
      />
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-destructive" data-testid="sandbox-image-error">{error}</p>
          <Button type="button" variant="outline" onClick={() => setRevision((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <p className="text-muted-foreground" data-testid="sandbox-image-loading">
          Reading the Server catalog…
        </p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground" data-testid="sandbox-image-empty">
          {query.trim() ? 'No image matches this search.' : 'This Server holds no images.'}
        </p>
      ) : (
        <div className="flex max-h-64 flex-col overflow-auto" data-testid="sandbox-image-list">
          {entries.map((entry) => {
            const digest = entry.image.digest ?? '';
            return (
              <RegistryRow
                key={entry.image.image_id}
                entry={entry}
                selected={selected?.image.image_id === entry.image.image_id}
                blockReason={entryBlockReason(entry, role, targetPlatform)}
                cache={cacheLabel(sessionId, digest ? observations.get(digest) : undefined)}
                onSelect={() => onSelect(entry)}
              />
            );
          })}
        </div>
      )}
      <RegistryPager
        offset={offset}
        shown={entries.length}
        total={total}
        loading={loading}
        onPrevious={() => {
          const next = Math.max(0, offset - IMAGE_PAGE_SIZE);
          setOffset(next);
          load(next, query);
        }}
        onNext={() => {
          const next = offset + IMAGE_PAGE_SIZE;
          setOffset(next);
          load(next, query);
        }}
      />
    </>
  );
}

function SelectedImage({
  selected,
  requireTarget,
  target,
  formError,
  onTargetChange,
}: {
  selected: ImageLibraryEntry;
  requireTarget: boolean;
  target: string;
  formError: string | null;
  onTargetChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border p-3">
      <p className={chromeSansRole('primary')}>
        {imageAliases(selected.image)[0] ?? selected.image.image_id} · pinned{' '}
        {shortDigest(selected.image.digest)}
      </p>
      <p className="text-muted-foreground" data-testid="sandbox-image-selected-meta">
        {imageRoleLabel(libraryImageRole(selected))} ·{' '}
        {selected.platform ?? 'Platform unknown'} ·{' '}
        {representationLabel(selected.representation)}
      </p>
      {requireTarget ? (
        <FormField
          id="sandbox-mount-target"
          label="Mount target"
          description="Read-only image mount at /opt/<lowercase-name>."
          error={formError ?? undefined}
          errorTestId="sandbox-mount-target-error"
        >
          <Input
            id="sandbox-mount-target"
            data-testid="sandbox-mount-target"
            value={target}
            placeholder="/opt/<name>"
            autoComplete="off"
            onChange={(event) => onTargetChange(event.target.value)}
          />
        </FormField>
      ) : null}
    </div>
  );
}

export interface SandboxImageSelectDialogProps {
  open: boolean;
  title: string;
  role: SandboxImagePickerRole;
  sessionId: string | null;
  /** The focused Agent's `os/arch`, when the registry advertised one. */
  targetPlatform?: string | null;
  /** Mount targets are editable; a RootFS selection is fixed at `/`. */
  requireTarget: boolean;
  submitLabel: string;
  onSelect: (entry: ImageLibraryEntry, target: string | null) => void;
  onClose: () => void;
}

/**
 * Select one Server Ready image for one role (#3405, #3408, #3793).
 *
 * The picker projects the Server Catalog role, platform, representation and
 * this Session's Agent cache phase. It excludes a known mismatched role,
 * disables a non-executable referenced Composite and a platform mismatch, and
 * flags an uncached image without pretending it is ready. The dialog only
 * chooses an immutable digest and, for a mount, its validated target; it never
 * bypasses the Server grant or the Agent resolver.
 */
export function SandboxImageSelectDialog({
  open,
  title,
  role,
  sessionId,
  targetPlatform,
  requireTarget,
  submitLabel,
  onSelect,
  onClose,
}: SandboxImageSelectDialogProps) {
  const [selected, setSelected] = useState<ImageLibraryEntry | null>(null);
  const [target, setTarget] = useState('/opt/');
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setSelected(null);
    setTarget('/opt/');
    setFormError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const selectedReason = selected
    ? entryBlockReason(selected, role, targetPlatform)
    : null;
  const targetError = requireTarget ? mountTargetError(target) : null;

  const choose = (entry: ImageLibraryEntry | null) => {
    setSelected(entry);
    setFormError(null);
    if (entry && requireTarget) {
      const proposed = entry.mount_default;
      if (proposed && mountTargetError(proposed) === null) {
        setTarget(proposed);
      }
    }
  };

  const submit = () => {
    if (!selected || selectedReason !== null) {
      return;
    }
    if (requireTarget) {
      const error = mountTargetError(target);
      if (error) {
        setFormError(error);
        return;
      }
      onSelect(selected, target.trim());
    } else {
      onSelect(selected, null);
    }
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="sandbox-image-select-dialog" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          This picker offers {roleTitle(role)} images. Server Ready means immutable bytes
          exist; the Agent cache phase is observed separately for this Session&apos;s Agent
          and is never implied by Server state.
        </p>
        <Registry
          open={open}
          role={role}
          sessionId={sessionId}
          targetPlatform={targetPlatform}
          selected={selected}
          onSelect={choose}
        />
        {selected ? (
          <SelectedImage
            selected={selected}
            requireTarget={requireTarget}
            target={target}
            formError={formError}
            onTargetChange={(value) => {
              setTarget(value);
              setFormError(null);
            }}
          />
        ) : null}
        <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
          <span />
          <span className="flex gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="sandbox-image-select-submit"
              disabled={!selected || selectedReason !== null || targetError !== null}
              onClick={submit}
            >
              {submitLabel}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
