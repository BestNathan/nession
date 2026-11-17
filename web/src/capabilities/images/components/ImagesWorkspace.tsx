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
  FormActions,
  FormField,
  FormGrid,
  FormRow,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ImageComposeRepresentation } from '@/generated/protocol/core/server-image-build-submit/v1';
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
  BUILD_SOURCE_KINDS,
  BUILD_SOURCE_LABEL,
  emptyBuildSourceDraft,
  emptyComposeSourceDraft,
  normalizeBuildAlias,
  validateBuildSource,
  type BuildSourceDraft,
  type BuildSourceErrors,
  type BuildSourceKind,
  type ComposeSourceDraft,
} from '../buildSource';
import {
  IMAGE_PAGE_SIZE,
  composeRepresentationLabel,
  imageAliases,
  imageBuildProgressLabel,
  imageBuildStageLabel,
  imageBuildStatusLabel,
  imageServerStatusLabel,
  imageSourceLabel,
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
      {image.source.kind === 'compose' ? (
        <DetailFact label="Compose output" testId="images-detail-compose-representation">
          {composeRepresentationLabel(image.source.representation)}
        </DetailFact>
      ) : null}
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
      <span
        className="min-w-0 truncate text-muted-foreground"
        data-testid="image-build-source"
      >
        {imageSourceLabel(build.source)}
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

function SourceKindToggle({
  kind,
  onChoose,
}: {
  kind: BuildSourceKind;
  onChoose: (kind: BuildSourceKind) => void;
}) {
  return (
    <ToggleGroup
      data-testid="image-build-source-kind"
      aria-label="Build source adapter"
      value={[kind]}
      onValueChange={(values) => {
        const next = values[0];
        if (next === 'github' || next === 'local_directory' || next === 'compose') {
          onChoose(next);
        }
      }}
      size="sm"
      className="flex-wrap"
    >
      {BUILD_SOURCE_KINDS.map((candidate) => (
        <ToggleGroupItem
          key={candidate}
          value={candidate}
          data-testid={`image-build-source-${candidate}`}
        >
          {BUILD_SOURCE_LABEL[candidate]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function GithubSourceFields({
  draft,
  errors,
  onChange,
}: {
  draft: BuildSourceDraft;
  errors: BuildSourceErrors;
  onChange: (patch: Partial<BuildSourceDraft>) => void;
}) {
  return (
    <FormGrid>
      <FormField
        id="image-build-repository"
        label="Repository"
        error={errors.repository_url}
        errorTestId="image-build-error-repository-url"
      >
        <Input
          id="image-build-repository"
          type="url"
          value={draft.repositoryUrl}
          placeholder="https://github.com/<owner>/<repo>"
          aria-label="Build repository URL"
          aria-invalid={errors.repository_url ? true : undefined}
          data-testid="image-build-repository"
          onChange={(event) => onChange({ repositoryUrl: event.target.value })}
        />
      </FormField>
      <FormField
        id="image-build-ref"
        label="Branch or commit"
        error={errors.ref}
        errorTestId="image-build-error-ref"
      >
        <Input
          id="image-build-ref"
          type="text"
          value={draft.reference}
          placeholder="main or a full commit SHA"
          aria-label="Build source ref"
          aria-invalid={errors.ref ? true : undefined}
          data-testid="image-build-ref"
          onChange={(event) => onChange({ reference: event.target.value })}
        />
      </FormField>
    </FormGrid>
  );
}

function DirectorySourceFields({
  draft,
  errors,
  onChange,
}: {
  draft: BuildSourceDraft;
  errors: BuildSourceErrors;
  onChange: (patch: Partial<BuildSourceDraft>) => void;
}) {
  return (
    <FormField
      id="image-build-path"
      label="Directory"
      description="An absolute path inside the Server operator's authorized image source root."
      error={errors.path}
      errorTestId="image-build-error-path"
    >
      <Input
        id="image-build-path"
        type="text"
        value={draft.path}
        placeholder="/srv/nession/sources/<name>"
        aria-label="Build source directory"
        aria-invalid={errors.path ? true : undefined}
        data-testid="image-build-path"
        onChange={(event) => onChange({ path: event.target.value })}
      />
    </FormField>
  );
}

function ComposeSourceRow({
  row,
  index,
  errors,
  referenced,
  removeDisabled,
  onChange,
  onRemove,
}: {
  row: ComposeSourceDraft;
  index: number;
  errors: BuildSourceErrors;
  referenced: boolean;
  removeDisabled: boolean;
  onChange: (patch: Partial<ComposeSourceDraft>) => void;
  onRemove: () => void;
}) {
  return (
    <FormRow data-testid={`image-build-compose-row-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Source Image {index + 1}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove source Image ${index + 1}`}
          data-testid={`image-build-compose-remove-${index}`}
          disabled={removeDisabled}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <FormGrid>
        <FormField
          id={`image-build-compose-repository-${index}`}
          label="Repository"
          error={errors[`compose.${index}.repository`]}
          errorTestId={`image-build-error-compose-${index}-repository`}
        >
          <Input
            id={`image-build-compose-repository-${index}`}
            type="text"
            value={row.repository}
            placeholder="catalog repository"
            aria-label={`Compose source ${index + 1} repository`}
            aria-invalid={errors[`compose.${index}.repository`] ? true : undefined}
            data-testid="image-build-compose-repository"
            onChange={(event) => onChange({ repository: event.target.value })}
          />
        </FormField>
        <FormField
          id={`image-build-compose-ref-${index}`}
          label="Tag or digest"
          error={errors[`compose.${index}.ref`]}
          errorTestId={`image-build-error-compose-${index}-ref`}
        >
          <Input
            id={`image-build-compose-ref-${index}`}
            type="text"
            value={row.reference}
            placeholder="tag or sha256:…"
            aria-label={`Compose source ${index + 1} reference`}
            aria-invalid={errors[`compose.${index}.ref`] ? true : undefined}
            data-testid="image-build-compose-ref"
            onChange={(event) => onChange({ reference: event.target.value })}
          />
        </FormField>
      </FormGrid>
      {referenced ? null : (
        <FormField
          id={`image-build-compose-destination-${index}`}
          label="Destination prefix"
          description="Empty or / places the source at the composed root. Prefixes must not overlap."
          error={errors[`compose.${index}.destination`]}
          errorTestId={`image-build-error-compose-${index}-destination`}
        >
          <Input
            id={`image-build-compose-destination-${index}`}
            type="text"
            value={row.destination}
            placeholder="/opt/<name>"
            aria-label={`Compose source ${index + 1} destination`}
            aria-invalid={errors[`compose.${index}.destination`] ? true : undefined}
            data-testid="image-build-compose-destination"
            onChange={(event) => onChange({ destination: event.target.value })}
          />
        </FormField>
      )}
    </FormRow>
  );
}

function ComposeSourceFields({
  draft,
  errors,
  onRepresentation,
  onRow,
  onAdd,
  onRemove,
}: {
  draft: BuildSourceDraft;
  errors: BuildSourceErrors;
  onRepresentation: (representation: ImageComposeRepresentation) => void;
  onRow: (index: number, patch: Partial<ComposeSourceDraft>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const referenced = draft.representation === 'referenced';
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="image-build-compose">
      {draft.sources.map((row, index) => (
        <ComposeSourceRow
          key={index}
          row={row}
          index={index}
          errors={errors}
          referenced={referenced}
          removeDisabled={draft.sources.length === 1}
          onChange={(patch) => onRow(index, patch)}
          onRemove={() => onRemove(index)}
        />
      ))}
      <FormActions>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="image-build-compose-add"
          onClick={onAdd}
        >
          Add source Image
        </Button>
      </FormActions>
      {errors.compose ? (
        <p className="text-destructive" role="alert" data-testid="image-build-error-compose">
          {errors.compose}
        </p>
      ) : null}
      <FormField
        label="Output"
        error={errors.representation}
        errorTestId="image-build-error-representation"
      >
        <ToggleGroup
          data-testid="image-build-representation"
          aria-label="Compose output representation"
          value={[draft.representation]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === 'flattened' || next === 'referenced') {
              onRepresentation(next);
            }
          }}
          size="sm"
        >
          <ToggleGroupItem
            value="flattened"
            data-testid="image-build-representation-flattened"
          >
            Flattened
          </ToggleGroupItem>
          <ToggleGroupItem
            value="referenced"
            data-testid="image-build-representation-referenced"
          >
            Referenced
          </ToggleGroupItem>
        </ToggleGroup>
      </FormField>
    </div>
  );
}

function BuildSubmitActions({
  alias,
  error,
  submitting,
  onAlias,
  onSubmit,
}: {
  alias: string;
  error: string | undefined;
  submitting: boolean;
  onAlias: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <FormActions>
      <FormField
        id="image-build-alias"
        label="Optional alias"
        description="A mutable tag applied only after the bytes are ready."
        error={error}
        errorTestId="image-build-error-alias"
        className="min-w-40 flex-1"
      >
        <Input
          id="image-build-alias"
          type="text"
          value={alias}
          placeholder="optional alias"
          aria-label="Build alias"
          aria-invalid={error ? true : undefined}
          data-testid="image-build-alias"
          onChange={(event) => onAlias(event.target.value)}
        />
      </FormField>
      <Button
        type="button"
        size="sm"
        data-testid="image-build-submit"
        disabled={submitting}
        onClick={onSubmit}
      >
        {submitting ? 'Submitting…' : 'Build image'}
      </Button>
    </FormActions>
  );
}

function BuildSubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [draft, setDraft] = useState<BuildSourceDraft>(emptyBuildSourceDraft);
  const [alias, setAlias] = useState('');
  const [errors, setErrors] = useState<BuildSourceErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeDraft = (patch: Partial<BuildSourceDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const chooseKind = (kind: BuildSourceKind) => {
    setErrors({});
    setError(null);
    setDraft((current) => ({ ...current, kind }));
  };

  const chooseRepresentation = (representation: ImageComposeRepresentation) => {
    setErrors({});
    setDraft((current) => ({
      ...current,
      representation,
      // A referenced result keeps every source at the composed root, so a
      // destination typed for a flattened composition would only fail later.
      sources:
        representation === 'referenced'
          ? current.sources.map((row) => ({ ...row, destination: '' }))
          : current.sources,
    }));
  };

  const changeRow = (index: number, patch: Partial<ComposeSourceDraft>) => {
    setDraft((current) => ({
      ...current,
      sources: current.sources.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    }));
  };

  const addRow = () => {
    setDraft((current) => ({
      ...current,
      sources: [...current.sources, emptyComposeSourceDraft()],
    }));
  };

  const removeRow = (index: number) => {
    setDraft((current) => ({
      ...current,
      sources: current.sources.filter((_, rowIndex) => rowIndex !== index),
    }));
  };

  const submit = async () => {
    const validation = validateBuildSource(draft);
    const normalizedAlias = normalizeBuildAlias(alias);
    const nextErrors: BuildSourceErrors = { ...validation.errors };
    if (normalizedAlias === null) {
      nextErrors.alias =
        'Use a lowercase tag of at most 128 characters starting with a letter or digit';
    }
    setErrors(nextErrors);
    setError(null);
    if (!validation.source || Object.keys(nextErrors).length > 0) {
      // SC-01: an invalid or non-canonical source never becomes a submitted
      // Server job. The draft stays exactly as typed.
      return;
    }
    setSubmitting(true);
    try {
      await imagesApi.submitBuild(validation.source, {
        alias: normalizedAlias ?? undefined,
      });
      setDraft(emptyBuildSourceDraft());
      setAlias('');
      setErrors({});
      onSubmitted();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'The build could not be submitted');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormSurface data-testid="image-build-form">
      <FormSection
        title="Source"
        description="Only adapters this Server serves are listed. A build snapshots the declared source; it never runs repository scripts."
      >
        <SourceKindToggle kind={draft.kind} onChoose={chooseKind} />
        {draft.kind === 'github' ? (
          <GithubSourceFields draft={draft} errors={errors} onChange={changeDraft} />
        ) : draft.kind === 'local_directory' ? (
          <DirectorySourceFields draft={draft} errors={errors} onChange={changeDraft} />
        ) : (
          <ComposeSourceFields
            draft={draft}
            errors={errors}
            onRepresentation={chooseRepresentation}
            onRow={changeRow}
            onAdd={addRow}
            onRemove={removeRow}
          />
        )}
      </FormSection>
      <BuildSubmitActions
        alias={alias}
        error={errors.alias}
        submitting={submitting}
        onAlias={setAlias}
        onSubmit={() => void submit()}
      />
      {error ? (
        <p className="text-destructive" data-testid="image-build-submit-error">
          {error}
        </p>
      ) : null}
    </FormSurface>
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
