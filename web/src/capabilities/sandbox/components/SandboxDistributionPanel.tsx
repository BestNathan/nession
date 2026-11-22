import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailEmpty } from '@/components/ui/resource-detail';
import { Input } from '@/components/ui/input';
import {
  IMAGE_PAGE_SIZE,
  imageAliases,
  imageServerStatusLabel,
  shortDigest,
  useImagesPage,
  type ImageDescriptor,
} from '@/capabilities/images';
import type {
  ImageCacheObservation,
  ImageCachePhase,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { SandboxImagePrepareIntent } from '@/generated/protocol/core/server-session-sandbox-image-prepare/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { useImageCacheObservations } from '../hooks/useImageCacheObservations';
import { sandboxApi } from '../SandboxPlugin';
import {
  formatBytes,
  observationPhaseLabel,
  transferLabel,
} from '../model';

function phaseVariant(
  phase: string,
): 'secondary' | 'outline' | 'destructive' {
  if (phase === 'verified') {
    return 'secondary';
  }
  if (phase === 'failed' || phase === 'unavailable') {
    return 'destructive';
  }
  return 'outline';
}

/**
 * The one explicit action an observation makes eligible (#3796).
 *
 * A verified identity needs nothing; an active transfer is already doing the
 * work; an unavailable cache cannot participate. The Server still authorizes
 * every action, so eligibility here is a truthful affordance, not authority.
 */
function eligibleIntent(phase: ImageCachePhase | undefined): SandboxImagePrepareIntent | null {
  switch (phase) {
    case 'absent':
      return 'prepare';
    case 'resumable':
      return 'resume';
    case 'failed':
      return 'retry';
    default:
      return null;
  }
}

const INTENT_LABEL: Record<SandboxImagePrepareIntent, string> = {
  prepare: 'Prepare',
  resume: 'Resume',
  retry: 'Retry',
};

const PENDING_LABEL: Record<SandboxImagePrepareIntent, string> = {
  prepare: 'Preparing…',
  resume: 'Resuming…',
  retry: 'Retrying…',
};

function DistributionRow({
  image,
  observation,
  pending,
  actionError,
  disabled,
  onAction,
}: {
  image: ImageDescriptor;
  observation: ImageCacheObservation | undefined;
  pending: SandboxImagePrepareIntent | null;
  actionError: string | null;
  disabled: boolean;
  onAction: (digest: string, intent: SandboxImagePrepareIntent) => void;
}) {
  const intent = observation ? eligibleIntent(observation.phase) : null;
  return (
    <li
      data-testid="sandbox-distribution-row"
      data-image-digest={image.digest ?? ''}
      className="flex min-w-0 flex-col gap-1 border-b border-border px-2 py-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
          {imageAliases(image)[0] ?? image.image_id}
        </span>
        <Badge variant={image.status === 'ready' ? 'secondary' : 'outline'}>
          {imageServerStatusLabel(image.status)}
        </Badge>
      </div>
      <span className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
        {shortDigest(image.digest)}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge
          variant={observation ? phaseVariant(observation.phase) : 'outline'}
          data-testid="sandbox-distribution-phase"
        >
          {observation ? observationPhaseLabel(observation.phase) : 'Not observed'}
        </Badge>
        <span
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
          data-testid="sandbox-distribution-transfer"
        >
          {observation ? transferLabel(observation) : '—'}
        </span>
        {observation?.active ? (
          <span
            className={cn('text-muted-foreground', chromeSansRole('caption'))}
            data-testid="sandbox-distribution-active"
          >
            active
          </span>
        ) : null}
        {intent && image.digest ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={`sandbox-distribution-${intent}`}
            disabled={disabled || pending !== null}            onClick={() => onAction(image.digest as string, intent)}
          >
            {pending === intent ? PENDING_LABEL[intent] : INTENT_LABEL[intent]}
          </Button>
        ) : null}
      </div>
      {observation?.detail ? (
        <p
          className={cn('break-words text-muted-foreground', chromeSansRole('caption'))}
          data-testid="sandbox-distribution-detail"
        >
          {observation.detail}
        </p>
      ) : null}
      {actionError ? (
        <p
          className={cn('break-words text-destructive', chromeSansRole('caption'))}
          role="alert"
          data-testid="sandbox-distribution-action-error"
        >
          {actionError}
        </p>
      ) : null}
      {observation && observation.total_bytes ? (
        <span className="text-muted-foreground" data-testid="sandbox-distribution-total">
          {formatBytes(observation.total_bytes)} total
        </span>
      ) : null}
    </li>
  );
}

function DistributionList({
  images,
  observations,
  pending,
  actionErrors,
  disabled,
  onAction,
}: {
  images: ImageDescriptor[];
  observations: Map<string, ImageCacheObservation>;
  pending: { digest: string; intent: SandboxImagePrepareIntent } | null;
  actionErrors: Record<string, string>;
  disabled: boolean;
  onAction: (digest: string, intent: SandboxImagePrepareIntent) => void;
}) {
  return (
    <ul className="flex min-w-0 flex-col p-1">
      {images.map((image) => (
        <DistributionRow
          key={image.image_id}
          image={image}
          observation={image.digest ? observations.get(image.digest) : undefined}
          pending={pending && image.digest === pending.digest ? pending.intent : null}
          actionError={image.digest ? (actionErrors[image.digest] ?? null) : null}
          disabled={disabled}
          onAction={onAction}
        />
      ))}
    </ul>
  );
}

/**
 * The current Session Agent's per-digest cache distribution (#3412, #3408,
 * #3796).
 *
 * Server Ready is never substituted for Agent verification. Bytes come from
 * the Agent's measured observation; a percent is shown only when a total is
 * known, an active transfer is only `downloading`/`verifying`, and Verifying
 * is explicitly not mount-ready. An explicit Prepare/Resume/Retry acts only on
 * this Agent and only when the observation makes that intent eligible.
 */
export function SandboxDistributionPanel({ sessionId }: { sessionId: string | null }) {
  const page = useImagesPage(IMAGE_PAGE_SIZE);
  const digests = page.images
    .filter((image) => image.status === 'ready' && image.digest)
    .map((image) => image.digest as string);
  const cache = useImageCacheObservations(sessionId, digests);
  const [pending, setPending] = useState<{ digest: string; intent: SandboxImagePrepareIntent } | null>(
    null,
  );
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const refreshObservations = cache.refresh;

  // A prepare can take minutes. The Agent's own progress is the authority, so
  // re-read it while the explicit action is in flight instead of showing a
  // static "Preparing" claim.
  useEffect(() => {
    if (pending === null) {
      return;
    }
    const timer = setInterval(() => refreshObservations(), 2_000);
    return () => clearInterval(timer);
  }, [pending, refreshObservations]);

  const runAction = async (digest: string, intent: SandboxImagePrepareIntent) => {
    if (sessionId === null || pending !== null) {
      return;
    }
    setPending({ digest, intent });
    setActionErrors((current) => {
      const next = { ...current };
      delete next[digest];
      return next;
    });
    try {
      const response = await sandboxApi.imagePrepare(sessionId, digest, intent);
      if (!response.success) {
        throw new Error(response.error ?? 'The Agent could not prepare this image');
      }
      cache.refresh();
    } catch (cause: unknown) {
      setActionErrors((current) => ({
        ...current,
        [digest]:
          cause instanceof Error ? cause.message : 'The Agent could not prepare this image',
      }));
      cache.refresh();
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      data-testid="sandbox-distribution"
      aria-label="Agent image cache distribution"
      className="flex min-w-0 flex-col"
    >
      <div className="flex min-w-0 flex-col gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className={cn('min-w-0', chromeSansRole('title'))}>Distribution</h2>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Refresh Agent cache observations"
            data-testid="sandbox-distribution-refresh"
            onClick={() => {
              page.refresh();
              cache.refresh();
            }}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Only the current Session&apos;s Agent is observed. A verified digest is mount-ready;
          downloading, resumable and verifying states are not. Prepare, Resume and Retry act on
          this Agent only.
        </p>
        <Input
          type="search"
          value={page.query}
          placeholder="Search alias, digest or source"
          aria-label="Search distribution images"
          data-testid="sandbox-distribution-search"
          onChange={(event) => page.setQuery(event.target.value)}
        />
        {cache.error ? (
          <p className="text-destructive" data-testid="sandbox-distribution-error">
            {cache.error}
          </p>
        ) : null}
      </div>
      {page.error ? (
        <p className="p-4 text-destructive" data-testid="sandbox-distribution-page-error">
          {page.error}
        </p>
      ) : page.loading && page.images.length === 0 ? (
        <p className="p-4 text-muted-foreground" data-testid="sandbox-distribution-loading">
          Reading the Server image registry…
        </p>
      ) : page.images.length === 0 ? (
        <DetailEmpty data-testid="sandbox-distribution-empty">
          {page.query.trim()
            ? 'No image matches this search.'
            : 'This Server currently holds no images.'}
        </DetailEmpty>
      ) : (
        <DistributionList
          images={page.images}
          observations={cache.observations}
          pending={pending}
          actionErrors={actionErrors}
          disabled={sessionId === null || pending !== null}
          onAction={(digest, intent) => void runAction(digest, intent)}
        />
      )}
    </section>
  );
}
