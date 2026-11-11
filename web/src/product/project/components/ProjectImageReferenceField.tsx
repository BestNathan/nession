import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { imageAliases, imagesApi, type ImageDescriptor } from '@/capabilities/images';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { ProjectDraft } from '../types';
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

/**
 * Project image reference and its explicit build path (#3181).
 *
 * A Git Source build is a Server action; this field only shows its result and
 * requires an explicit "Use this image" before the draft changes. Closing or
 * failing preserves the old reference.
 */
export function ProjectImageReferenceField({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [buildState, setBuildState] = useState<
    | { phase: 'idle' }
    | { phase: 'building' }
    | { phase: 'failed'; error: string }
    | { phase: 'ready'; image: ImageDescriptor }
  >({ phase: 'idle' });
  const gitSource = draft.source && 'repository_url' in draft.source ? { repository_url: draft.source.repository_url, ref: draft.source.ref } : null;

  const startBuild = async () => {
    if (!gitSource) {
      return;
    }
    setBuildState({ phase: 'building' });
    try {
      const image = await imagesApi.buildImage({
        kind: 'github',
        repository_url: gitSource.repository_url,
        ref: gitSource.ref,
      });
      setBuildState({ phase: 'ready', image });
    } catch (cause: unknown) {
      setBuildState({
        phase: 'failed',
        error: cause instanceof Error ? cause.message : 'The image build failed',
      });
    }
  };

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
            disabled={disabled || gitSource === null || buildState.phase === 'building'}
            data-testid="project-image-build"
            onClick={() => void startBuild()}
          >
            {buildState.phase === 'building' ? 'Building…' : 'Build from Git Source'}
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
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          A reference only. The Project never owns image bytes. The build requires this
          Project's GitHub source.
        </p>
      </div>

      {buildState.phase === 'failed' ? (
        <p className="text-destructive" data-testid="project-image-build-error">
          Build failed: {buildState.error}. The current reference is unchanged.
        </p>
      ) : null}
      {buildState.phase === 'ready' ? (
        <ProjectImageBuildResult
          image={buildState.image}
          disabled={disabled}
          onUse={() => {
            onChange({ ...draft, image_digest: buildState.image.digest ?? undefined });
            setBuildState({ phase: 'idle' });
          }}
        />
      ) : null}

      <ProjectImagePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onChoose={(image) => {
          onChange({ ...draft, image_digest: image.digest ?? undefined });
          setPickerOpen(false);
        }}
      />
      <span className="sr-only" id={`${idPrefix}-digest-description`}>
        The selected image digest is a reference to a Server-owned immutable artifact.
      </span>
    </div>
  );
}
