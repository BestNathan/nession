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
import { FormField } from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imagesApi,
  shortDigest,
  sourceLabel,
  type ImageDescriptor,
} from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { mountTargetError } from '../model';

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

function RegistryRows({
  images,
  loading,
  error,
  query,
  selectedId,
  onSelect,
  onRetry,
}: {
  images: ImageDescriptor[];
  loading: boolean;
  error: string | null;
  query: string;
  selectedId: string | null;
  onSelect: (image: ImageDescriptor) => void;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-destructive" data-testid="sandbox-image-error">{error}</p>
        <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (loading) {
    return (
      <p className="text-muted-foreground" data-testid="sandbox-image-loading">
        Reading the Server registry…
      </p>
    );
  }
  if (images.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="sandbox-image-empty">
        {query.trim() ? 'No image matches this search.' : 'This Server holds no images.'}
      </p>
    );
  }
  return (
    <div className="flex max-h-64 flex-col overflow-auto" data-testid="sandbox-image-list">
      {images.map((image) => {
        const aliases = imageAliases(image);
        const selected = image.image_id === selectedId;
        return (
          <button
            key={image.image_id}
            type="button"
            data-testid="sandbox-image-row"
            data-selected={selected ? 'true' : undefined}
            disabled={image.status !== 'ready'}
            onClick={() => onSelect(image)}
            className={cn(
              'flex min-w-0 flex-col gap-1 border-b border-border px-2 py-2 text-left last:border-b-0 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
              selected && 'bg-muted',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className={cn('truncate', chromeSansRole('primary'))}>
                {aliases[0] ?? image.image_id}
              </span>
              <Badge variant={image.status === 'ready' ? 'secondary' : 'outline'}>
                {image.status === 'ready'
                  ? 'Server Ready'
                  : image.status === 'failed'
                    ? 'Failed'
                    : 'Building'}
              </Badge>
            </span>
            <span className="truncate text-muted-foreground">{sourceLabel(image)}</span>
            <span className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
              {shortDigest(image.digest)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Registry({
  open,
  selectedId,
  onSelect,
}: {
  open: boolean;
  selectedId: string | null;
  onSelect: (image: ImageDescriptor) => void;
}) {
  const [images, setImages] = useState<ImageDescriptor[]>([]);
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
      .listImages({ offset: nextOffset, limit: IMAGE_PAGE_SIZE, query: nextQuery })
      .then((page) => {
        setImages(page.images);
        setTotal(page.total);
      })
      .catch((cause: unknown) => {
        setImages([]);
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

  return (
    <>
      <Input
        type="search"
        value={query}
        placeholder="Search alias, digest or source"
        aria-label="Search Sandbox images"
        data-testid="sandbox-image-search"
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          setOffset(0);
          load(0, next);
        }}
      />
      <RegistryRows
        images={images}
        loading={loading}
        error={error}
        query={query}
        selectedId={selectedId}
        onSelect={onSelect}
        onRetry={() => setRevision((n) => n + 1)}
      />
      <RegistryPager
        offset={offset}
        shown={images.length}
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

export interface SandboxImageSelectDialogProps {
  open: boolean;
  title: string;
  /** Mount targets are editable; a RootFS selection is fixed at `/`. */
  requireTarget: boolean;
  submitLabel: string;
  onSelect: (image: ImageDescriptor, target: string | null) => void;
  onClose: () => void;
}

/**
 * Select one Server Ready image for the Filesystem declaration (#3405, #3408).
 *
 * The dialog only chooses a digest and, for a mount, its validated target. It
 * is not a composition editor and never exposes Agent paths or grants.
 */
export function SandboxImageSelectDialog({
  open,
  title,
  requireTarget,
  submitLabel,
  onSelect,
  onClose,
}: SandboxImageSelectDialogProps) {
  const [selected, setSelected] = useState<ImageDescriptor | null>(null);
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

  const targetError = requireTarget ? mountTargetError(target) : null;

  const submit = () => {
    if (!selected) {
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
          Only a Server Ready image can be declared. The Agent verifies its own cache and
          refuses an image it has not materialized.
        </p>
        <Registry open={open} selectedId={selected?.image_id ?? null} onSelect={setSelected} />
        {selected ? (
          <div className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border p-3">
            <p className={chromeSansRole('primary')}>
              {imageAliases(selected)[0] ?? selected.image_id} · pinned{' '}
              {shortDigest(selected.digest)}
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
                  onChange={(event) => {
                    setTarget(event.target.value);
                    setFormError(null);
                  }}
                />
              </FormField>
            ) : null}
          </div>
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
              disabled={!selected || selected.status !== 'ready' || targetError !== null}
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
