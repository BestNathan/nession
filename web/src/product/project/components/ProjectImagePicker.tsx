import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageExecutionBarrier,
  imageRoleCompatible,
  imageRoleLabel,
  imagesApi,
  libraryImageRole,
  representationLabel,
  shortDigest,
  sourceLabel,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

function ProjectImageBlockReason(entry: ImageLibraryEntry): string | null {
  if (entry.image.status !== 'ready') {
    return 'The Server has not published immutable bytes for this image.';
  }
  if (!imageRoleCompatible(entry, 'directory')) {
    return `Not a Project directory image (${imageRoleLabel(libraryImageRole(entry))}).`;
  }
  return imageExecutionBarrier(entry);
}

function ProjectImageRows({
  entries,
  loading,
  error,
  query,
  onChoose,
  onRetry,
}: {
  entries: ImageLibraryEntry[];
  loading: boolean;
  error: string | null;
  query: string;
  onChoose: (entry: ImageLibraryEntry) => void;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-destructive" data-testid="project-image-error">{error}</p>
        <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (loading) {
    return <p className="text-muted-foreground" data-testid="project-image-loading">Reading the Server catalog…</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="project-image-empty">
        {query.trim() ? 'No image matches this search.' : 'This Server holds no images.'}
      </p>
    );
  }
  return (
    <div className="flex max-h-80 flex-col overflow-auto" data-testid="project-image-list">
      {entries.map((entry) => {
        const aliases = imageAliases(entry.image);
        const blockReason = ProjectImageBlockReason(entry);
        return (
          <div
            key={entry.image.image_id}
            className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-1 py-2 last:border-b-0"
            data-testid="project-image-row"
            data-image-role={libraryImageRole(entry) ?? 'unknown'}
            data-image-platform={entry.platform ?? ''}
            data-image-blocked={blockReason ? 'true' : undefined}
          >
            <div className="min-w-0">
              <p className={cn('truncate', chromeSansRole('primary'))}>{aliases[0] ?? entry.image.image_id}</p>
              <p className="truncate text-muted-foreground">{sourceLabel(entry.image)}</p>
              <p className="truncate text-muted-foreground" data-testid="project-image-meta">
                {imageRoleLabel(libraryImageRole(entry))} · {entry.platform ?? 'Platform unknown'} ·{' '}
                {representationLabel(entry.representation)}
              </p>
              <p className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>{shortDigest(entry.image.digest)}</p>
              {blockReason ? (
                <p className="text-destructive" data-testid="project-image-blocked-reason">{blockReason}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={entry.image.status === 'ready' ? 'secondary' : 'outline'}>
                {entry.image.status === 'ready' ? 'Server Ready' : entry.image.status === 'failed' ? 'Failed' : 'Building'}
              </Badge>
              <Button
                type="button"
                size="sm"
                disabled={blockReason !== null}
                data-testid="project-image-use"
                onClick={() => onChoose(entry)}
              >
                Use image
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectImageRegistryPager({
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
    <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
      <span className="text-muted-foreground" data-testid="project-image-page-label">
        {total === 0 ? '0 images' : `${offset + 1}–${offset + shown} of ${total}`}
      </span>
      <span className="flex gap-1">
        <Button type="button" size="sm" variant="outline" disabled={offset === 0 || loading} onClick={onPrevious}>
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
    </DialogFooter>
  );
}

function ProjectImageRegistry({
  open,
  onChoose,
}: {
  open: boolean;
  onChoose: (entry: ImageLibraryEntry) => void;
}) {
  const [entries, setEntries] = useState<ImageLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void imagesApi
      .listLibrary({ offset, limit: IMAGE_PAGE_SIZE, query })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setEntries(page.entries);
        setTotal(page.total);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setEntries([]);
        setTotal(0);
        setError(cause instanceof Error ? cause.message : 'Images could not be loaded');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, offset, query, revision]);

  return (
    <>
      <Input
        type="search"
        value={query}
        placeholder="Search alias, digest, tag or source"
        aria-label="Search Project images"
        data-testid="project-image-search"
        onChange={(event) => {
          setOffset(0);
          setQuery(event.target.value);
        }}
      />
      <ProjectImageRows
        entries={entries}
        loading={loading}
        error={error}
        query={query}
        onChoose={onChoose}
        onRetry={() => setRevision((n) => n + 1)}
      />
      <ProjectImageRegistryPager
        offset={offset}
        shown={entries.length}
        total={total}
        loading={loading}
        onPrevious={() => setOffset((current) => Math.max(0, current - IMAGE_PAGE_SIZE))}
        onNext={() => setOffset((current) => current + IMAGE_PAGE_SIZE)}
      />
    </>
  );
}

/**
 * Project-specific single-image selector.
 *
 * This is deliberately not the Sandbox composition flow and not a shared
 * Picker: it returns one immutable digest, it never defines a target/mode and
 * it never owns image bytes. The Server Catalog role is projected so a Base
 * Runtime or Toolchain is not offered as a Project directory image (#3793).
 * Alias changes never rewrite the selected digest because the draft stores the
 * digest, not the alias.
 */
export function ProjectImagePicker({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (image: ImageDescriptor) => void;
}) {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (open) {
      setEpoch((current) => current + 1);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="project-image-picker" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select Project image</DialogTitle>
        </DialogHeader>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          One Server-owned image digest reference. This is Project-specific; Sandbox
          composition has its own independent flow. Only a Project directory image is
          offered as executable.
        </p>
        <ProjectImageRegistry
          key={epoch}
          open={open}
          onChoose={(entry) => onChoose(entry.image)}
        />
      </DialogContent>
    </Dialog>
  );
}
