import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DetailEmpty,
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { Input } from '@/components/ui/input';
import type {
  WorkspaceDepthControl,
  WorkspaceViewProps,
} from '@/app/workspace/workspaceContext';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { cn } from '@/shared/lib/utils';
import type { ImageDescriptor } from '../ImagesPlugin';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageServerStatusLabel,
  shortDigest,
  sourceLabel,
} from '../model';
import { useImagesPage, type ImagesPageState } from '../hooks/useImagesPage';

function ImageStatusBadge({ image }: { image: ImageDescriptor }) {
  const variant =
    image.status === 'ready' ? 'secondary' : image.status === 'failed' ? 'destructive' : 'outline';
  return (
    <Badge variant={variant} data-testid="image-server-status">
      {imageServerStatusLabel(image.status)}
    </Badge>
  );
}

function ImageRow({
  image,
  selected,
  onSelect,
}: {
  image: ImageDescriptor;
  selected: boolean;
  onSelect: () => void;
}) {
  const aliases = imageAliases(image);
  return (
    <button
      type="button"
      data-testid="image-row"
      data-image-digest={image.digest ?? ''}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-[var(--nession-radius-control)] border border-transparent px-3 py-2 text-left transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-muted',
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
          {aliases.length > 0 ? aliases[0] : image.image_id}
        </span>
        <ImageStatusBadge image={image} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {sourceLabel(image)}
      </span>
      <span className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('code'))}>
        {shortDigest(image.digest)}
      </span>
    </button>
  );
}

export function ImagesDetail({ image }: { image: ImageDescriptor }) {
  const aliases = imageAliases(image);
  return (
    <DetailSurface data-testid="images-detail">
      <DetailHeader
        eyebrow="Server-owned immutable image"
        title={aliases[0] ?? image.image_id}
        titleTestId="images-detail-title"
        badges={<ImageStatusBadge image={image} />}
        meta={
          <span className={cn('break-all', chromeMonoRole('code'))}>
            {image.digest ?? 'No digest (build not ready)'}
          </span>
        }
        description="The Server owns these bytes and the immutable digest. A Project references one digest; a Sandbox composition pins a resolved digest before execution."
      />
      <DetailFacts>
        <DetailFact label="Aliases" testId="images-detail-aliases">
          {aliases.length > 0 ? aliases.join(', ') : 'No alias'}
        </DetailFact>
        <DetailFact label="Source" testId="images-detail-source">
          {sourceLabel(image)}
        </DetailFact>
        {image.source_sha ? (
          <DetailFact label="Source commit" mono testId="images-detail-source-sha">
            {image.source_sha}
          </DetailFact>
        ) : null}
        <DetailFact label="Size" testId="images-detail-size">
          {image.size_bytes.toLocaleString()} bytes
        </DetailFact>
        <DetailFact label="Created" testId="images-detail-created">
          {new Date(image.created_at * 1000).toLocaleString()}
        </DetailFact>
      </DetailFacts>
      <DetailSection title="Build state" level="h3">
        {image.status === 'ready' ? (
          <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
            Server Ready means the immutable Blob exists. Agent cache readiness is observed
            separately in a Session context and is never implied here.
          </p>
        ) : image.status === 'failed' ? (
          <p className={cn('text-destructive', chromeSansRole('secondary'))}>
            {image.error ?? 'The build failed; no bytes are offered as ready.'}
          </p>
        ) : (
          <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
            The build worker is still running. No bytes are offered as ready.
          </p>
        )}
      </DetailSection>
      <DetailSection title="Packaging" level="h3">
        <DetailFacts>
          <DetailFact label="Compression" mono>
            {image.packaging.compression}
          </DetailFact>
          <DetailFact label="Block size" mono>
            {image.packaging.block_size}
          </DetailFact>
          <DetailFact label="Fixed timestamp" mono>
            {image.packaging.fixed_timestamp}
          </DetailFact>
        </DetailFacts>
      </DetailSection>
    </DetailSurface>
  );
}

function ImagesListPane({
  page,
  selectedDigest,
  onSelect,
}: {
  page: ImagesPageState;
  selectedDigest: string | null;
  onSelect: (digest: string | null) => void;
}) {
  return (
    <section
      data-testid="images-list"
      aria-label="Server image inventory"
      className="flex min-w-0 flex-col rounded-[var(--nession-radius-surface)] border border-border"
    >
      <div className="flex min-w-0 flex-col gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className={cn('min-w-0', chromeSansRole('title'))}>Images</h2>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Refresh image inventory"
            data-testid="images-refresh"
            onClick={page.refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Server-owned immutable images. Available without a Session; Projects and Sandboxes
          consume the same registry through their own flows.
        </p>
        <Input
          type="search"
          value={page.query}
          placeholder="Search alias, digest or source"
          aria-label="Search images"
          data-testid="images-search"
          onChange={(event) => page.setQuery(event.target.value)}
        />
      </div>
      {page.error ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <p className={cn('text-destructive', chromeSansRole('secondary'))} data-testid="images-error">
            {page.error}
          </p>
          <Button type="button" variant="outline" onClick={page.refresh}>
            Retry
          </Button>
        </div>
      ) : page.loading && page.images.length === 0 ? (
        <p className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="images-loading">
          Reading the Server image inventory…
        </p>
      ) : page.images.length === 0 ? (
        <DetailEmpty data-testid="images-empty">
          {page.query.trim()
            ? 'No image matches this search.'
            : 'This Server currently holds no images.'}
        </DetailEmpty>
      ) : (
        <div className="flex min-w-0 flex-col p-1">
          {page.images.map((image) => (
            <ImageRow
              key={image.image_id}
              image={image}
              selected={image.digest === selectedDigest}
              onSelect={() => onSelect(image.digest ?? null)}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border p-2">
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))} data-testid="images-page-label">
          {page.total === 0
            ? '0 images'
            : `${page.offset + 1}–${page.offset + page.images.length} of ${page.total}`}
        </span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!page.hasPrevious || page.loading}
            data-testid="images-previous"
            onClick={page.previous}
          >
            <ChevronLeft aria-hidden="true" /> Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!page.hasNext || page.loading}
            data-testid="images-next"
            onClick={page.next}
          >
            Next <ChevronRight aria-hidden="true" />
          </Button>
        </span>
      </div>
    </section>
  );
}

/**
 * The Images capability's Workspace surface (#3181).
 *
 * The Server registry has one list/detail surface here. Project and Sandbox
 * each own a separate selection flow; this view has no Project reference and
 * no Sandbox composition controls. The App registers one pushed detail depth
 * through the shell, while Web keeps list and detail side by side.
 */
export function ImagesWorkspace({
  ctx,
  depth,
}: {
  ctx: WorkspaceViewProps['ctx'];
  depth?: WorkspaceDepthControl;
}) {
  const page = useImagesPage(IMAGE_PAGE_SIZE);
  const [selectedDigest, setSelectedDigest] = useState<string | null>(null);
  const selected = useMemo(
    () => page.images.find((image) => image.digest === selectedDigest) ?? null,
    [page.images, selectedDigest],
  );

  useEffect(() => {
    if (ctx.experience === 'web' && !selected && page.images.length > 0) {
      setSelectedDigest(page.images[0].digest ?? null);
    }
  }, [ctx.experience, page.images, selected]);

  useEffect(() => {
    if (!depth) {
      return;
    }
    if (selected) {
      depth.setPush({
        title: imageAliases(selected)[0] ?? selected.image_id,
        onLeave: () => setSelectedDigest(null),
      });
    } else {
      depth.setPush(null);
    }
    return () => depth.setPush(null);
  }, [depth, selected]);

  const showDetailOnly = ctx.experience === 'app' && selected !== null;
  if (showDetailOnly) {
    return (
      <div
        data-testid="images-workspace"
        className="flex min-h-0 min-w-0 flex-col gap-3 p-3"
      >
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setSelectedDigest(null)}
          >
            <ChevronLeft aria-hidden="true" /> All images
          </Button>
          {selected ? <ImagesDetail image={selected} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="images-workspace"
      className={cn(
        'flex min-w-0 flex-col gap-3',
        ctx.experience === 'app' ? 'p-3' : 'h-full min-h-0 p-4',
      )}
    >
      <div
        className={cn(
          'grid min-h-0 gap-4',
          ctx.experience === 'web'
            ? 'flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden'
            : 'grid-cols-1',
        )}
      >
        <div className={`min-h-0 overflow-auto ${workspaceScrollClearanceClass}`}>
          <ImagesListPane
            page={page}
            selectedDigest={selectedDigest}
            onSelect={setSelectedDigest}
          />
        </div>
        {ctx.experience === 'web' ? (
          <div className={`min-h-0 overflow-auto ${workspaceScrollClearanceClass}`}>
            {selected ? (
              <ImagesDetail image={selected} />
            ) : (
              <DetailEmpty>Select an image to inspect its digest and build state.</DetailEmpty>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Web layout entry: no shell chrome of its own. */
export function ImagesWebLayout({ ctx }: WorkspaceViewProps) {
  return <ImagesWorkspace ctx={ctx} />;
}

/** App layout entry: the one page header is the shell's; the view pushes detail. */
export function ImagesAppLayout({ ctx, depth }: WorkspaceViewProps & { depth: WorkspaceDepthControl }) {
  return <ImagesWorkspace ctx={ctx} depth={depth} />;
}
