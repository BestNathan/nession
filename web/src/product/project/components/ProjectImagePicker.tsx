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
  imagesApi,
  shortDigest,
  sourceLabel,
  type ImageDescriptor,
} from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

function ReadyBadge({ image }: { image: ImageDescriptor }) {
  return (
    <Badge variant={image.status === 'ready' ? 'secondary' : 'outline'}>
      {image.status === 'ready' ? 'Server Ready' : image.status === 'failed' ? 'Failed' : 'Building'}
    </Badge>
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

function ProjectImageRows({
  images,
  loading,
  error,
  query,
  onChoose,
  onRetry,
}: {
  images: ImageDescriptor[];
  loading: boolean;
  error: string | null;
  query: string;
  onChoose: (image: ImageDescriptor) => void;
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
    return <p className="text-muted-foreground" data-testid="project-image-loading">Reading the Server registry…</p>;
  }
  if (images.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="project-image-empty">
        {query.trim() ? 'No image matches this search.' : 'This Server holds no images.'}
      </p>
    );
  }
  return (
    <div className="flex max-h-80 flex-col overflow-auto" data-testid="project-image-list">
      {images.map((image) => {
        const aliases = imageAliases(image);
        return (
          <div key={image.image_id} className="flex items-center justify-between gap-3 border-b border-border px-1 py-2 last:border-b-0">
            <div className="min-w-0">
              <p className={cn('truncate', chromeSansRole('primary'))}>{aliases[0] ?? image.image_id}</p>
              <p className="truncate text-muted-foreground">{sourceLabel(image)}</p>
              <p className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>{shortDigest(image.digest)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ReadyBadge image={image} />
              <Button type="button" size="sm" disabled={image.status !== 'ready'} data-testid="project-image-use" onClick={() => onChoose(image)}>
                Use image
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectImageRegistry({
  open,
  onChoose,
}: {
  open: boolean;
  onChoose: (image: ImageDescriptor) => void;
}) {
  const [images, setImages] = useState<ImageDescriptor[]>([]);
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
      .listImages({ offset, limit: IMAGE_PAGE_SIZE, query })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setImages(page.images);
        setTotal(page.total);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setImages([]);
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
        placeholder="Search alias, digest or source"
        aria-label="Search Project images"
        data-testid="project-image-search"
        onChange={(event) => {
          setOffset(0);
          setQuery(event.target.value);
        }}
      />
      <ProjectImageRows
        images={images}
        loading={loading}
        error={error}
        query={query}
        onChoose={onChoose}
        onRetry={() => setRevision((n) => n + 1)}
      />
      <ProjectImageRegistryPager
        offset={offset}
        shown={images.length}
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
 * Picker: it returns one digest, it never defines a target/mode and it never
 * owns image bytes.
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
          One Server-owned image reference. This is Project-specific; Sandbox composition has
          its own independent flow.
        </p>
        <ProjectImageRegistry
          key={epoch}
          open={open}
          onChoose={onChoose}
        />
      </DialogContent>
    </Dialog>
  );
}
