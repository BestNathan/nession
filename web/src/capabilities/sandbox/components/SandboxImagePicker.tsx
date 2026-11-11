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
import type { SandboxImageMode } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxImagesState } from '../hooks/useSandboxImages';
import { sandboxImageChoice } from '../model';

function SandboxImageRegistryPager({
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
    </div>
  );
}

function SandboxImageRegistryRows({
  images,
  loading,
  error,
  query,
  onSelect,
  onRetry,
}: {
  images: ImageDescriptor[];
  loading: boolean;
  error: string | null;
  query: string;
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
    return <p className="text-muted-foreground" data-testid="sandbox-image-loading">Reading the Server registry…</p>;
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
        return (
          <button
            key={image.image_id}
            type="button"
            data-testid="sandbox-image-row"
            disabled={image.status !== 'ready'}
            onClick={() => onSelect(image)}
            className="flex min-w-0 flex-col gap-1 border-b border-border px-2 py-2 text-left last:border-b-0 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex items-center justify-between gap-2">
              <span className={cn('truncate', chromeSansRole('primary'))}>
                {aliases[0] ?? image.image_id}
              </span>
              <Badge variant={image.status === 'ready' ? 'secondary' : 'outline'}>
                {image.status === 'ready' ? 'Server Ready' : image.status === 'failed' ? 'Failed' : 'Building'}
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

function SandboxImageRegistry({
  open,
  onSelect,
}: {
  open: boolean;
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
      <SandboxImageRegistryRows
        images={images}
        loading={loading}
        error={error}
        query={query}
        onSelect={onSelect}
        onRetry={() => setRevision((n) => n + 1)}
      />
      <SandboxImageRegistryPager
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

function SandboxImageChoiceForm({
  selected,
  target,
  mode,
  error,
  onTargetChange,
  onModeChange,
}: {
  selected: ImageDescriptor;
  target: string;
  mode: SandboxImageMode;
  error: string | null;
  onTargetChange: (value: string) => void;
  onModeChange: (mode: SandboxImageMode) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border p-3">
      <p className={chromeSansRole('primary')}>
        {imageAliases(selected)[0] ?? selected.image_id} · pinned {shortDigest(selected.digest)}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField
          id="sandbox-image-target"
          label="Target"
          description="/ for Base Runtime, /workspace for the writable workspace, /opt/<name> for a toolchain."
          error={error ?? undefined}
        >
          <Input
            id="sandbox-image-target"
            data-testid="sandbox-image-target"
            value={target}
            onChange={(event) => onTargetChange(event.target.value)}
          />
        </FormField>
        <FormField
          id="sandbox-image-mode"
          label="Mode"
          description="The workspace merges the image with an Agent-owned writable overlay; other images are read-only."
        >
          <select
            id="sandbox-image-mode"
            data-testid="sandbox-image-mode"
            className={cn(
              'h-[length:var(--nession-control-md)] rounded-[var(--nession-radius-control)] border border-input bg-transparent px-3',
              chromeSansRole('primary'),
            )}
            value={mode}
            onChange={(event) => onModeChange(event.target.value as SandboxImageMode)}
          >
            <option value="read_only">Read-only</option>
            <option value="overlay">Overlay</option>
          </select>
        </FormField>
      </div>
    </div>
  );
}

/** The Sandbox-specific image selector. Project has its own separate flow. */
export function SandboxImagePicker({
  open,
  images,
  onClose,
}: {
  open: boolean;
  images: SandboxImagesState;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<ImageDescriptor | null>(null);
  const [target, setTarget] = useState('/');
  const [mode, setMode] = useState<SandboxImageMode>('read_only');
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setSelected(null);
    setTarget(images.selections.some((selection) => selection.role === 'base') ? '/opt/' : '/');
    setMode('read_only');
    setFormError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const begin = (image: ImageDescriptor) => {
    setSelected(image);
    setTarget(images.selections.some((selection) => selection.role === 'base') ? '/opt/' : '/');
    setMode('read_only');
    setFormError(null);
  };

  const add = () => {
    if (!selected) {
      return;
    }
    const result = sandboxImageChoice({ digest: selected.digest ?? '', target, mode });
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    const duplicate = images.add(result.choice);
    if (duplicate) {
      setFormError(duplicate);
      return;
    }
    close();
  };

  const changeTarget = (value: string) => {
    setTarget(value);
    if (value.trim() === '/workspace') {
      setMode('overlay');
    } else if (value.trim() === '/' || value.trim().startsWith('/opt/')) {
      setMode('read_only');
    }
    setFormError(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="sandbox-image-picker" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add image to Sandbox</DialogTitle>
        </DialogHeader>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Sandbox-specific composition. The image is pinned to this resolved digest; the
          target and mode are owned by this Sandbox and do not change the Project reference.
        </p>
        <SandboxImageRegistry open={open} onSelect={begin} />
        {selected ? (
          <SandboxImageChoiceForm
            selected={selected}
            target={target}
            mode={mode}
            error={formError}
            onTargetChange={changeTarget}
            onModeChange={setMode}
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
              data-testid="sandbox-image-add"
              disabled={!selected || selected.status !== 'ready'}
              onClick={add}
            >
              Add to composition
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
