import { useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
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
import type { WorkspaceViewProps } from '@/app/workspace/workspaceContext';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { imagesApi, type ImageBuildDescriptor, type ImageDescriptor } from '../ImagesPlugin';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageBuildProgressLabel,
  imageBuildStageLabel,
  imageBuildStatusLabel,
  imageServerStatusLabel,
  isTerminalBuild,
  shortDigest,
  sourceLabel,
} from '../model';
import { useImageBuilds, type ImageBuildsState } from '../hooks/useImageBuilds';
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
  expanded,
  onToggle,
}: {
  image: ImageDescriptor;
  expanded: boolean;
  onToggle: () => void;
}) {
  const aliases = imageAliases(image);
  return (
    <button
      type="button"
      data-testid="image-row"
      data-image-digest={image.digest ?? ''}
      aria-expanded={expanded}
      aria-controls={`image-detail-${image.image_id}`}
      onClick={onToggle}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-[var(--nession-radius-control)] border border-transparent px-3 py-2 text-left transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        expanded && 'bg-muted',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
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
      </span>
      {expanded ? (
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
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


function BuildStatusBadge({ build }: { build: ImageBuildDescriptor }) {
  const variant =
    build.status === 'succeeded'
      ? 'secondary'
      : build.status === 'failed'
        ? 'destructive'
        : 'outline';
  return (
    <Badge variant={variant} data-testid="image-build-status">
      {imageBuildStatusLabel(build)}
    </Badge>
  );
}

function ImageBuildRow({
  build,
  onCancel,
  onRetry,
}: {
  build: ImageBuildDescriptor;
  onCancel: (buildId: string) => void;
  onRetry: (buildId: string) => void;
}) {
  const terminal = isTerminalBuild(build);
  return (
    <div
      data-testid="image-build-row"
      data-build-id={build.build_id}
      className="flex min-w-0 flex-col gap-1 rounded-[var(--nession-radius-control)] border border-border px-3 py-2"
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
          {build.alias ?? build.build_id}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <BuildStatusBadge build={build} />
        </span>
      </span>
      <span className="min-w-0 truncate text-muted-foreground" data-testid="image-build-stage">
        {imageBuildStageLabel(build)}
      </span>
      <span
        className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('code'))}
        data-testid="image-build-progress"
      >
        {imageBuildProgressLabel(build)}
      </span>
      {build.diagnostic ? (
        <span
          className="min-w-0 truncate text-muted-foreground"
          data-testid="image-build-diagnostic"
        >
          {build.diagnostic}
        </span>
      ) : null}
      {build.error ? (
        <span className="min-w-0 break-all text-destructive" data-testid="image-build-error">
          {build.error}
        </span>
      ) : null}
      {build.digest ? (
        <span className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('code'))}>
          {shortDigest(build.digest)}
        </span>
      ) : null}
      <span className="flex items-center gap-1">
        {!terminal ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="image-build-cancel"
            onClick={() => onCancel(build.build_id)}
          >
            Cancel
          </Button>
        ) : null}
        {build.status === 'failed' || build.status === 'canceled' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="image-build-retry"
            onClick={() => onRetry(build.build_id)}
          >
            Retry
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function BuildSubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [repository, setRepository] = useState('');
  const [reference, setReference] = useState('main');
  const [alias, setAlias] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const url = repository.trim();
    const ref = reference.trim();
    if (!url || !ref) {
      setError('A public GitHub repository URL and a branch or commit are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await imagesApi.submitBuild(
        { kind: 'github', repository_url: url, ref },
        { alias: alias.trim() || undefined },
      );
      setAlias('');
      onSubmitted();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'The build could not be submitted');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="image-build-form">
      <div className="flex flex-wrap items-center gap-1">
        <Input
          type="url"
          value={repository}
          placeholder="https://github.com/<owner>/<repo>"
          aria-label="Build repository URL"
          data-testid="image-build-repository"
          className="min-w-0 flex-1"
          onChange={(event) => setRepository(event.target.value)}
        />
        <Input
          type="text"
          value={reference}
          placeholder="branch or commit"
          aria-label="Build source ref"
          data-testid="image-build-ref"
          className="w-36"
          onChange={(event) => setReference(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Input
          type="text"
          value={alias}
          placeholder="optional alias"
          aria-label="Build alias"
          data-testid="image-build-alias"
          className="min-w-0 flex-1"
          onChange={(event) => setAlias(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          data-testid="image-build-submit"
          disabled={submitting}
          onClick={() => void submit()}
        >
          {submitting ? 'Submitting…' : 'Build image'}
        </Button>
      </div>
      {error ? (
        <p className="text-destructive" data-testid="image-build-submit-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ImagesBuildsPanel({ builds }: { builds: ImageBuildsState }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-b border-border p-3"
      data-testid="images-builds"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className={cn('min-w-0', chromeSansRole('title'))}>Build activity</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="images-builds-refresh"
          onClick={builds.refresh}
        >
          Refresh
        </Button>
      </div>
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        Builds run in the Server&apos;s durable build directory. Stage and measured counts
        survive navigation and reconnect; no percentage is invented while mkfs.erofs runs.
      </p>
      <BuildSubmitForm onSubmitted={builds.refresh} />
      {builds.error ? (
        <p className="text-destructive" data-testid="images-builds-error">
          {builds.error}
        </p>
      ) : builds.builds.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))} data-testid="images-builds-empty">
          {builds.loading ? 'Reading durable builds…' : 'No builds have been submitted.'}
        </p>
      ) : (
        <div className="flex max-h-64 min-w-0 flex-col gap-1 overflow-auto">
          {builds.builds.map((build) => (
            <ImageBuildRow
              key={build.build_id}
              build={build}
              onCancel={(buildId) => void builds.cancel(buildId)}
              onRetry={(buildId) => void builds.retry(buildId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ImagesLibraryPanel({
  page,
  expandedImageId,
  onExpand,
}: {
  page: ImagesPageState;
  expandedImageId: string | null;
  onExpand: (imageId: string | null) => void;
}) {
  return (
    <section
      data-testid="images-list"
      aria-label="Server image inventory"
      className="flex min-w-0 flex-col"
    >
      <div className="flex min-w-0 flex-col gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className={cn('min-w-0', chromeSansRole('title'))}>Image Library</h2>
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
          Server-owned immutable images. Agent cache readiness is observed separately for the
          current Session&apos;s Agent.
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
          {page.images.map((image) => {
            const expanded = image.image_id === expandedImageId;
            return (
              <div key={image.image_id} className="min-w-0">
                <ImageRow
                  image={image}
                  expanded={expanded}
                  onToggle={() => onExpand(expanded ? null : image.image_id)}
                />
                {expanded ? (
                  <div
                    id={`image-detail-${image.image_id}`}
                    data-testid="image-detail-row"
                    className="min-w-0 pb-2 pt-1"
                  >
                    <ImagesDetail image={image} />
                  </div>
                ) : null}
              </div>
            );
          })}
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
 * The reusable Server Images management panel (#3181, #3408).
 *
 * The Image Library is a single list: activating a row expands its details
 * immediately underneath that row, and one row is expanded at a time. Builds
 * is the durable #3334 build surface. The owning Session's Sandbox supplies
 * the Agent-scoped Distribution view; this capability owns no Agent cache
 * observation itself.
 */
export function ImagesPanel({
  experience,
  distribution,
}: {
  experience: 'web' | 'app';
  distribution?: React.ReactNode;
}) {
  const page = useImagesPage(IMAGE_PAGE_SIZE);
  const builds = useImageBuilds(IMAGE_PAGE_SIZE);
  const sections = distribution
    ? (['library', 'builds', 'distribution'] as const)
    : (['library', 'builds'] as const);
  const [section, setSection] = useState<(typeof sections)[number]>('library');
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  return (
    <div
      data-testid="images-panel"
      data-experience={experience}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex min-w-0 items-center gap-1">
        {sections.map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={section === id ? 'secondary' : 'ghost'}
            data-testid={`images-section-${id}`}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            {id === 'library' ? 'Library' : id === 'builds' ? 'Builds' : 'Distribution'}
          </Button>
        ))}
      </div>
      {section === 'library' ? (
        <ImagesLibraryPanel
          page={page}
          expandedImageId={expandedImageId}
          onExpand={setExpandedImageId}
        />
      ) : section === 'builds' ? (
        <ImagesBuildsPanel builds={builds} />
      ) : (
        distribution
      )}
    </div>
  );
}

/** The Images capability's Workspace surface; the Sandbox embeds the panel. */
export function ImagesWorkspace({
  ctx,
}: {
  ctx: WorkspaceViewProps['ctx'];
  depth?: unknown;
}) {
  return (
    <div
      data-testid="images-workspace"
      className={cn(
        'flex min-w-0 flex-col gap-3',
        ctx.experience === 'app' ? 'p-3' : 'h-full min-h-0 p-4',
      )}
    >
      <ImagesPanel experience={ctx.experience} />
    </div>
  );
}

/** Web layout entry: no shell chrome of its own. */
export function ImagesWebLayout({ ctx }: WorkspaceViewProps) {
  return <ImagesWorkspace ctx={ctx} />;
}

/** App layout entry: the one page header is the shell's. */
export function ImagesAppLayout({ ctx }: WorkspaceViewProps) {
  return <ImagesWorkspace ctx={ctx} />;
}
