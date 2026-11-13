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
import type { ImageCacheObservation } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { useImageCacheObservations } from '../hooks/useImageCacheObservations';
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

function DistributionRow({
  image,
  observation,
}: {
  image: ImageDescriptor;
  observation: ImageCacheObservation | undefined;
}) {
  return (
    <li
      data-testid="sandbox-distribution-row"
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
      </div>
      {observation?.detail ? (
        <p
          className={cn('break-words text-muted-foreground', chromeSansRole('caption'))}
          data-testid="sandbox-distribution-detail"
        >
          {observation.detail}
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

/**
 * The current Session Agent's per-digest cache distribution (#3412, #3408).
 *
 * Server Ready is never substituted for Agent verification. Bytes come from
 * the Agent's measured observation; a percent is shown only when a total is
 * known, an active transfer is only `downloading`/`verifying`, and Verifying
 * is explicitly not mount-ready.
 */
export function SandboxDistributionPanel({ sessionId }: { sessionId: string | null }) {
  const page = useImagesPage(IMAGE_PAGE_SIZE);
  const digests = page.images
    .filter((image) => image.status === 'ready' && image.digest)
    .map((image) => image.digest as string);
  const cache = useImageCacheObservations(sessionId, digests);

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
          downloading, resumable and verifying states are not.
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
        <ul className="flex min-w-0 flex-col p-1">
          {page.images.map((image) => (
            <DistributionRow
              key={image.image_id}
              image={image}
              observation={
                image.digest ? cache.observations.get(image.digest) : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
