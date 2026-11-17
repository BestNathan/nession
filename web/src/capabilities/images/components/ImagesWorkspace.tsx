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
import {
  OperationActions,
  OperationError,
  OperationLead,
} from '@/components/ui/operation-surface';
import type { WorkspaceViewProps } from '@/app/workspace/workspaceContext';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import {
  imagesApi,
  type ImageBuildDescriptor,
  type ImageDescriptor,
  type ImageLibraryEntry,
  type ImageReferenceImpact,
} from '../ImagesPlugin';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageBuildProgressLabel,
  imageBuildStageLabel,
  imageBuildStatusLabel,
  imageServerStatusLabel,
  impactSummary,
  isTerminalBuild,
  libraryManifestDigest,
  libraryRepository,
  libraryTagsLabel,
  libraryTitle,
  representationLabel,
  shortDigest,
  sourceLabel,
} from '../model';
import { useImageBuilds, type ImageBuildsState } from '../hooks/useImageBuilds';
import {
  useImageLibraryPage,
  type ImageLibraryPageState,
} from '../hooks/useImageLibraryPage';
import {
  tagOperationTitle,
  useTagOperation,
  type TagOperationState,
} from '../hooks/useTagOperation';

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
  entry,
  expanded,
  onToggle,
}: {
  entry: ImageLibraryEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const image = entry.image;
  return (
    <button
      type="button"
      data-testid="image-row"
      data-image-digest={image.digest ?? ''}
      data-image-repository={entry.repository}
      aria-expanded={expanded}
      aria-controls={`image-detail-${image.image_id}`}
      onClick={onToggle}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-[var(--nession-radius-control)] border border-transparent px-3 py-2 text-left transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        expanded && 'bg-muted',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
            {libraryTitle(entry)}
          </span>
          <ImageStatusBadge image={image} />
        </span>
        <span
          className="min-w-0 truncate text-muted-foreground"
          data-testid="image-row-repository"
        >
          {libraryRepository(entry)}
          {entry.tags.length > 0 ? ` · ${entry.tags.join(', ')}` : ' · No tag'}
          {` · ${representationLabel(entry.representation)}`}
          {` · ${image.size_bytes.toLocaleString()} bytes`}
        </span>
        <span className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('code'))}>
          {shortDigest(entry.manifest_digest ?? image.digest)}
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

interface TagOperationFieldsProps {
  operation: TagOperationState;
  tagName: string;
  onTagName: (value: string) => void;
  targetDigest: string;
  onTargetDigest: (value: string) => void;
  impact: ImageReferenceImpact | null;
  impactLoading: boolean;
  acceptImpact: boolean;
  onAcceptImpact: (value: boolean) => void;
  needsReview: boolean;
}

function TagOperationFields(props: TagOperationFieldsProps) {
  const { operation, impact, impactLoading, needsReview } = props;
  return (
    <>
      <OperationLead>
        {operation.kind === 'remove'
          ? 'Unlinking a Tag changes only this mutable reference. Durable pins, other Tags, CAS bytes, running consumers and Agent cache are untouched; Server GC remains the only reclaim authority.'
          : 'A Tag is a mutable, repository-scoped reference. The immutable Manifest digest and every pinned Session or Project revision stay unchanged.'}
      </OperationLead>
      {operation.kind === 'remove' ? (
        <DetailFacts>
          <DetailFact label="Tag" mono>
            {operation.tag}
          </DetailFact>
          <DetailFact label="Expected digest" mono>
            {operation.expected ?? 'Unknown'}
          </DetailFact>
          <DetailFact label="Reference impact" testId="images-tag-impact">
            {impactLoading ? 'Reading the Server reference graph…' : impactSummary(impact)}
          </DetailFact>
        </DetailFacts>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Input
            type="text"
            value={props.tagName}
            placeholder="tag name"
            aria-label="Tag name"
            data-testid="images-tag-name"
            className="min-w-0 flex-1"
            disabled={operation.kind === 'move'}
            onChange={(event) => props.onTagName(event.target.value)}
          />
          <Input
            type="text"
            value={props.targetDigest}
            placeholder="sha256:<64 hex> target"
            aria-label="Target manifest digest"
            data-testid="images-tag-target"
            className="min-w-0 flex-1"
            onChange={(event) => props.onTargetDigest(event.target.value)}
          />
        </div>
      )}
      {operation.kind === 'remove' && needsReview && impact !== null && !impact.unknown ? (
        <label
          className="flex min-w-0 items-center gap-2"
          data-testid="images-tag-impact-confirm-label"
        >
          <input
            type="checkbox"
            checked={props.acceptImpact}
            data-testid="images-tag-impact-confirm"
            onChange={(event) => props.onAcceptImpact(event.target.checked)}
          />
          <span className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
            I reviewed the reference impact; unlink the Tag only.
          </span>
        </label>
      ) : null}
    </>
  );
}

function TagOperationFeedback({
  conflictDigest,
  error,
}: {
  conflictDigest: string | null;
  error: string | null;
}) {
  return (
    <>
      {conflictDigest ? (
        <p className="break-all text-destructive" data-testid="images-tag-conflict">
          The Tag now resolves to {conflictDigest}. Refresh and review the operation again; the
          expected digest was not bypassed.
        </p>
      ) : null}
      {error ? <OperationError testId="images-tag-error">{error}</OperationError> : null}
    </>
  );
}

/**
 * One deliberate Tag operation (#3799).
 *
 * The Server is the mutation authority. A CAS conflict is surfaced with the
 * digest the Tag actually resolves to and requires a fresh review; a known
 * reference impact needs explicit confirmation, and an unobservable impact
 * disables the unlink entirely.
 */
function TagOperationSection({
  entry,
  operation,
  onClose,
  onChanged,
}: {
  entry: ImageLibraryEntry;
  operation: TagOperationState;
  onClose: () => void;
  onChanged: () => void;
}) {
  const state = useTagOperation(entry, operation, onClose, onChanged);
  return (
    <DetailSection title={tagOperationTitle(operation.kind)} level="h3">
      <div data-testid="images-tag-operation" className="flex min-w-0 flex-col gap-2">
        <TagOperationFields
          operation={operation}
          tagName={state.tagName}
          onTagName={state.setTagName}
          targetDigest={state.targetDigest}
          onTargetDigest={state.setTargetDigest}
          impact={state.impact}
          impactLoading={state.impactLoading}
          acceptImpact={state.acceptImpact}
          onAcceptImpact={state.setAcceptImpact}
          needsReview={state.needsReview}
        />
        <TagOperationFeedback
          conflictDigest={state.conflictDigest}
          error={state.error}
        />
        <OperationActions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="images-tag-cancel"
            disabled={state.busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="images-tag-confirm"
            disabled={state.confirmDisabled}
            onClick={() => void state.submit()}
          >
            {state.busy
              ? 'Applying…'
              : operation.kind === 'remove'
                ? 'Unlink tag'
                : 'Apply tag'}
          </Button>
        </OperationActions>
      </div>
    </DetailSection>
  );
}

function ImagesIdentityFacts({ entry }: { entry: ImageLibraryEntry }) {
  const image = entry.image;
  const aliases = imageAliases(image);
  return (
    <DetailFacts>
      <DetailFact label="Repository" testId="images-detail-repository">
        {libraryRepository(entry)}
      </DetailFact>
      <DetailFact label="Tags" testId="images-detail-tags">
        {libraryTagsLabel(entry)}
      </DetailFact>
      <DetailFact label="Manifest / Index" mono testId="images-detail-manifest">
        {libraryManifestDigest(entry)}
      </DetailFact>
      <DetailFact label="Kind" testId="images-detail-kind">
        {entry.kind ?? 'Unknown kind'}
      </DetailFact>
      <DetailFact label="Media type" mono testId="images-detail-media-type">
        {entry.media_type ?? 'Unknown media type'}
      </DetailFact>
      <DetailFact label="Platform" testId="images-detail-platform">
        {entry.platform ?? 'Unknown platform'}
      </DetailFact>
      <DetailFact label="Representation" testId="images-detail-representation">
        {representationLabel(entry.representation)}
      </DetailFact>
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
  );
}

function ImagesTagsSection({
  entry,
  onTagsChanged,
}: {
  entry: ImageLibraryEntry;
  onTagsChanged: () => void;
}) {
  const [operation, setOperation] = useState<TagOperationState | null>(null);
  const canManageTags = entry.repository !== '' && entry.manifest_digest !== null;
  return (
    <DetailSection title="Tags" level="h3">
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        A Tag is a mutable repository-scoped reference. Moving or unlinking it never changes the
        immutable Manifest or a pinned consumer revision.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {entry.tags.map((tag) => (
          <span
            key={tag}
            data-testid="images-tag"
            className="flex items-center gap-1 rounded-[var(--nession-radius-control)] border border-border px-2 py-1"
          >
            <span className={chromeMonoRole('code')}>{tag}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`images-tag-move-${tag}`}
              disabled={!canManageTags}
              onClick={() =>
                setOperation({ kind: 'move', tag, expected: entry.manifest_digest ?? null })
              }
            >
              Move
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`images-tag-remove-${tag}`}
              disabled={!canManageTags}
              onClick={() =>
                setOperation({ kind: 'remove', tag, expected: entry.manifest_digest ?? null })
              }
            >
              Unlink
            </Button>
          </span>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="images-tag-create"
          disabled={!canManageTags}
          onClick={() => setOperation({ kind: 'create', tag: '', expected: null })}
        >
          Create tag
        </Button>
      </div>
      {!canManageTags ? (
        <p
          className={cn('text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="images-tag-unavailable"
        >
          No Server catalog identity is readable for this revision; Tag changes are unavailable.
        </p>
      ) : null}
      {operation ? (
        <TagOperationSection
          entry={entry}
          operation={operation}
          onClose={() => setOperation(null)}
          onChanged={onTagsChanged}
        />
      ) : null}
    </DetailSection>
  );
}

function ImagesDependenciesSection({ entry }: { entry: ImageLibraryEntry }) {
  return (
    <DetailSection title="Dependencies" level="h3">
      <DetailFacts>
        <DetailFact label="Descriptor edges" testId="images-detail-layers">
          {entry.layers.length}
        </DetailFact>
        <DetailFact label="Reachable EROFS blobs" testId="images-detail-closure">
          {entry.closure.length}
        </DetailFact>
      </DetailFacts>
      {entry.layers.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {entry.layers.map((layer) => (
            <li
              key={`${layer.role}-${layer.digest}`}
              data-testid="images-detail-layer"
              className="flex min-w-0 items-center gap-2"
            >
              <span className={chromeSansRole('caption')}>{layer.role}</span>
              <span className={cn('min-w-0 truncate', chromeMonoRole('code'))}>
                {shortDigest(layer.digest)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p
          className={cn('text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="images-detail-layers-unknown"
        >
          No descriptor closure is readable; representation is unknown.
        </p>
      )}
    </DetailSection>
  );
}

function ImagesReferencesSection({ entry }: { entry: ImageLibraryEntry }) {
  const image = entry.image;
  return (
    <DetailSection title="References and availability" level="h3">
      <DetailFacts>
        <DetailFact label="Reference impact" testId="images-detail-impact">
          {impactSummary(entry.impact)}
        </DetailFact>
        <DetailFact label="Server" testId="images-detail-server">
          {imageServerStatusLabel(image.status)}
        </DetailFact>
        <DetailFact label="Agent cache" testId="images-detail-agent-cache">
          Unknown here; observed only in Distribution for the current Session
        </DetailFact>
        <DetailFact label="Sandbox runtime" testId="images-detail-runtime">
          {entry.representation === 'referenced'
            ? 'Referenced composite: not a Sandbox MountPlan input'
            : 'Checked by the consumer flow at prepare time'}
        </DetailFact>
      </DetailFacts>
    </DetailSection>
  );
}

function ImagesBuildSections({ image }: { image: ImageDescriptor }) {
  return (
    <>
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
    </>
  );
}

export function ImagesDetail({
  entry,
  onTagsChanged,
}: {
  entry: ImageLibraryEntry;
  onTagsChanged: () => void;
}) {
  const image = entry.image;
  return (
    <DetailSurface data-testid="images-detail">
      <DetailHeader
        eyebrow="Server-owned immutable image"
        title={libraryTitle(entry)}
        titleTestId="images-detail-title"
        badges={<ImageStatusBadge image={image} />}
        meta={
          <span className={cn('break-all', chromeMonoRole('code'))}>
            {entry.manifest_digest ?? image.digest ?? 'No digest (build not ready)'}
          </span>
        }
        description="The Server owns these bytes, the Manifest identity and the mutable Tags. A Project or Session pins an immutable digest; a Tag move never rebinds it."
      />
      <ImagesIdentityFacts entry={entry} />
      <ImagesTagsSection entry={entry} onTagsChanged={onTagsChanged} />
      <ImagesDependenciesSection entry={entry} />
      <ImagesReferencesSection entry={entry} />
      <ImagesBuildSections image={image} />
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

function ImagesLibraryHeader({ page }: { page: ImageLibraryPageState }) {
  return (
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
        Server-owned immutable images and mutable Tags. Agent cache readiness is observed
        separately for the current Session&apos;s Agent.
      </p>
      <Input
        type="search"
        value={page.query}
        placeholder="Search alias, tag, digest or source"
        aria-label="Search images"
        data-testid="images-search"
        onChange={(event) => page.setQuery(event.target.value)}
      />
      <Input
        type="search"
        value={page.repository}
        placeholder="Filter by repository"
        aria-label="Filter by repository"
        data-testid="images-repository"
        onChange={(event) => page.setRepository(event.target.value)}
      />
    </div>
  );
}

function ImagesLibraryPager({ page }: { page: ImageLibraryPageState }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border p-2">
      <span
        className={cn('text-muted-foreground', chromeSansRole('caption'))}
        data-testid="images-page-label"
      >
        {page.total === 0
          ? '0 images'
          : `${page.offset + 1}–${page.offset + page.entries.length} of ${page.total}`}
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
  );
}

function ImagesLibraryRows({
  page,
  expandedImageId,
  onExpand,
}: {
  page: ImageLibraryPageState;
  expandedImageId: string | null;
  onExpand: (imageId: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col p-1">
      {page.entries.map((entry) => {
        const expanded = entry.image.image_id === expandedImageId;
        return (
          <div key={entry.image.image_id} className="min-w-0">
            <ImageRow
              entry={entry}
              expanded={expanded}
              onToggle={() => onExpand(expanded ? null : entry.image.image_id)}
            />
            {expanded ? (
              <div
                id={`image-detail-${entry.image.image_id}`}
                data-testid="image-detail-row"
                className="min-w-0 pb-2 pt-1"
              >
                <ImagesDetail entry={entry} onTagsChanged={page.refresh} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ImagesLibraryPanel({
  page,
  expandedImageId,
  onExpand,
}: {
  page: ImageLibraryPageState;
  expandedImageId: string | null;
  onExpand: (imageId: string | null) => void;
}) {
  return (
    <section
      data-testid="images-list"
      aria-label="Server image inventory"
      className="flex min-w-0 flex-col"
    >
      <ImagesLibraryHeader page={page} />
      {page.error ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <p
            className={cn('text-destructive', chromeSansRole('secondary'))}
            data-testid="images-error"
          >
            {page.error}
          </p>
          <Button type="button" variant="outline" onClick={page.refresh}>
            Retry
          </Button>
        </div>
      ) : page.loading && page.entries.length === 0 ? (
        <p
          className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="images-loading"
        >
          Reading the Server image inventory…
        </p>
      ) : page.entries.length === 0 ? (
        <DetailEmpty data-testid="images-empty">
          {page.query.trim() || page.repository.trim()
            ? 'No image matches this search.'
            : 'This Server currently holds no images.'}
        </DetailEmpty>
      ) : (
        <ImagesLibraryRows
          page={page}
          expandedImageId={expandedImageId}
          onExpand={onExpand}
        />
      )}
      <ImagesLibraryPager page={page} />
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
  const page = useImageLibraryPage(IMAGE_PAGE_SIZE);
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
