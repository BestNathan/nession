import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  imageAliases,
  imageBuildProgressLabel,
  imageBuildStageLabel,
  imageBuildStatusLabel,
  isTerminalBuild,
  type ImageBuildDescriptor,
  type ImageDescriptor,
} from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { ProjectDraft } from '../types';
import { useProjectImageBuild } from '../hooks/useProjectImageBuild';
import { ProjectImagePicker } from './ProjectImagePicker';

function ProjectImageBuildResult({
  image,
  disabled,
  onUse,
}: {
  image: ImageDescriptor;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border p-3"
      data-testid="project-image-build-result"
    >
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        Build succeeded:{' '}
        <strong>{imageAliases(image)[0] ?? image.image_id}</strong> is Server Ready. The
        Project reference has not changed yet.
      </p>
      <code className={cn('break-all', chromeMonoRole('code'))}>{image.digest}</code>
      <div>
        <Button
          type="button"
          size="sm"
          data-testid="project-image-use-build"
          disabled={disabled || !image.digest}
          onClick={onUse}
        >
          Use this image
        </Button>
      </div>
    </div>
  );
}

function ProjectImageBuildLifecycle({
  build,
  onCancel,
  onRetry,
}: {
  build: ImageBuildDescriptor;
  onCancel: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] border border-border p-3"
      data-testid="project-image-build-progress"
      data-build-id={build.build_id}
    >
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        {imageBuildStatusLabel(build)} — {imageBuildStageLabel(build)}. The build continues
        in the Server&apos;s durable build directory if you leave this view.
      </p>
      <p
        className={cn('text-muted-foreground', chromeMonoRole('code'))}
        data-testid="project-image-build-progress-detail"
      >
        {imageBuildProgressLabel(build)}
      </p>
      {build.error ? (
        <p className="text-destructive" data-testid="project-image-build-error">
          Build failed: {build.error}. The current reference is unchanged.
        </p>
      ) : null}
      <div className="flex items-center gap-1">
        {!isTerminalBuild(build) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="project-image-build-cancel"
            onClick={onCancel}
          >
            Cancel build
          </Button>
        ) : null}
        {build.status === 'failed' || build.status === 'canceled' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="project-image-build-retry"
            onClick={onRetry}
          >
            Retry build
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Project image reference and its explicit build path (#3181, #3334).
 *
 * A Git Source build is a Server action. This field submits the asynchronous
 * build unit, observes the durable record (including after navigation or a
 * reconnect) and requires an explicit "Use this image" before the draft
 * changes. Closing or failing preserves the old reference.
 */
export function ProjectImageReferenceField({
  draft,
  onChange,
  disabled,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const gitSource =
    draft.source && 'repository_url' in draft.source
      ? { repository_url: draft.source.repository_url, ref: draft.source.ref }
      : null;
  const {
    build,
    builtImage,
    submitting,
    submitError,
    active,
    start,
    cancel,
    retry,
    clear,
  } = useProjectImageBuild(gitSource);
  const succeeded = build?.status === 'succeeded';

  return (
    <div className="flex flex-col gap-2" data-testid="project-image-reference">
      <div className="flex flex-col gap-1">
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Image digest reference (optional)
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid="project-image-digest-field"
            className={cn('min-w-0 break-all', chromeMonoRole('code'))}
          >
            {draft.image_digest?.trim() || 'No image selected'}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            data-testid="project-image-choose"
            onClick={() => setPickerOpen(true)}
          >
            Select image
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || gitSource === null || submitting || active}
            data-testid="project-image-build"
            onClick={() => void start()}
          >
            {submitting ? 'Submitting…' : active ? 'Building…' : 'Build from Git Source'}
          </Button>
          {draft.image_digest ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              data-testid="project-image-clear"
              onClick={() => onChange({ ...draft, image_digest: undefined })}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p
          data-recipe-part="form-help"
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          A reference only. The Project never owns image bytes. The build requires this
          Project&apos;s GitHub source.
        </p>
      </div>

      {submitError ? (
        <p className="text-destructive" data-testid="project-image-build-submit-error">
          {submitError}. The current reference is unchanged.
        </p>
      ) : null}
      {build && !succeeded ? (
        <ProjectImageBuildLifecycle
          build={build}
          onCancel={() => void cancel()}
          onRetry={() => void retry()}
        />
      ) : null}
      {succeeded && builtImage ? (
        <ProjectImageBuildResult
          image={builtImage}
          disabled={disabled}
          onUse={() => {
            onChange({ ...draft, image_digest: builtImage.digest ?? undefined });
            clear();
          }}
        />
      ) : null}
      {succeeded && !builtImage ? (
        <p className="text-muted-foreground" data-testid="project-image-build-loading">
          The build succeeded; reading its immutable registry descriptor…
        </p>
      ) : null}

      <ProjectImagePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onChoose={(image) => {
          onChange({ ...draft, image_digest: image.digest ?? undefined });
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
