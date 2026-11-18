import type {
  ImageBuildAttempt,
  ImageBuildDescriptor,
  ImageBuildSourceKind,
  ImageBuildStatus,
  ImageDescriptor,
  ImageLibraryEntry,
  ImageLibraryRepresentation,
  ImageReferenceImpact,
  ImageSource,
} from './ImagesPlugin';
import type {
  ImageCacheState,
  ImageCacheStatus,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { ImageComposeRepresentation } from '@/generated/protocol/core/server-image-build-submit/v1';

export const IMAGE_PAGE_SIZE = 50;

/** The aliases that currently name this immutable digest, including the build alias. */
export function imageAliases(image: ImageDescriptor): string[] {
  const aliases = new Set(image.aliases);
  if (image.alias) {
    aliases.add(image.alias);
  }
  return [...aliases].sort();
}

/** A compact, unmistakably digest-shaped label for a row or header. */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) {
    return 'No digest';
  }
  return `${digest.slice(0, 19)}…${digest.slice(-6)}`;
}

/** How one Compose result is represented (#3696, #3697). */
export function composeRepresentationLabel(
  representation: ImageComposeRepresentation,
): string {
  return representation === 'referenced' ? 'Referenced' : 'Flattened';
}

/** The truthful source declaration for one image or durable build. */
export function imageSourceLabel(source: ImageSource): string {
  switch (source.kind) {
    case 'github':
      return `${source.repository_url}@${source.ref}`;
    case 'local_directory':
      return source.path;
    case 'compose':
      return `compose (${composeRepresentationLabel(source.representation)}): ${source.sources
        .map((entry) => `${entry.repository}@${entry.ref}${entry.destination === '' ? '' : ` -> ${entry.destination}`}`)
        .join(', ')}`;
  }
}

export function sourceLabel(image: ImageDescriptor): string {
  return imageSourceLabel(image.source);
}

export function imageServerStatusLabel(status: ImageDescriptor['status']): string {
  switch (status) {
    case 'ready':
      return 'Server Ready';
    case 'building':
      return 'Building';
    case 'failed':
      return 'Build failed';
  }
}

/** The UI words for an Agent cache observation. Never calls an unverified cache ready. */
export function cacheStateLabel(state: ImageCacheState): string {
  switch (state) {
    case 'verified':
      return 'Agent verified';
    case 'preparing':
      return 'Agent preparing';
    case 'absent':
      return 'Not cached';
    case 'failed':
      return 'Agent cache failed';
    case 'unavailable':
      return 'Agent cache unavailable';
  }
}

/** The row title for one Library revision: a Tag, then an alias, then its id. */
export function libraryTitle(entry: ImageLibraryEntry): string {
  return entry.tags[0] ?? imageAliases(entry.image)[0] ?? entry.image.image_id;
}

/** The Server Catalog repository, or an explicit unknown. */
export function libraryRepository(entry: ImageLibraryEntry): string {
  return entry.repository === '' ? 'Unknown repository' : entry.repository;
}

/** The repository Tag list, or the explicit absence of one. */
export function libraryTagsLabel(entry: ImageLibraryEntry): string {
  return entry.tags.length > 0 ? entry.tags.join(', ') : 'No tag';
}

/** The immutable Manifest/Index/Composite digest, or an explicit unknown. */
export function libraryManifestDigest(entry: ImageLibraryEntry): string {
  return entry.manifest_digest ?? 'Unknown manifest';
}

/** How the revision represents its EROFS bytes. */
export function representationLabel(
  representation: ImageLibraryRepresentation,
): string {
  switch (representation) {
    case 'single_layer':
      return 'Single layer';
    case 'flattened':
      return 'Flattened compose';
    case 'referenced':
      return 'Referenced composite';
    case 'unknown':
      return 'Unknown representation';
  }
}

/** One truthful one-line reference summary; never invents a zero. */
export function impactSummary(impact: ImageReferenceImpact | null | undefined): string {
  if (!impact) {
    return 'Reference impact not observed';
  }
  if (impact.unknown) {
    return 'Reference impact unknown; changes fail closed';
  }
  const parts = [
    `${impact.project_pins} Project pin${impact.project_pins === 1 ? '' : 's'}`,
    `${impact.session_pins} Session pin${impact.session_pins === 1 ? '' : 's'}`,
    `${impact.leases} lease${impact.leases === 1 ? '' : 's'}`,
    `${impact.compose_references} Compose reference${impact.compose_references === 1 ? '' : 's'}`,
  ];
  if (impact.other_tags.length > 0) {
    parts.push(`other tags: ${impact.other_tags.join(', ')}`);
  }
  return parts.join(' · ');
}

/** A digest→status lookup for a set of selected images. */
export function cacheStatusByDigest(
  statuses: readonly ImageCacheStatus[],
): Map<string, ImageCacheStatus> {
  return new Map(statuses.map((status) => [status.digest, status]));
}


/** Whether a durable build has reached a terminal lifecycle state. */
export function isTerminalBuild(build: ImageBuildDescriptor): boolean {
  return (
    build.status === 'succeeded'
    || build.status === 'failed'
    || build.status === 'canceled'
  );
}

/** The lifecycle word for one durable build status. */
export function imageBuildStatusText(status: ImageBuildStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Building';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
  }
}

/** The lifecycle word for one durable build. */
export function imageBuildStatusLabel(build: ImageBuildDescriptor): string {
  return imageBuildStatusText(build.status);
}

/** The current stage word, or the truthful "waiting" state before a worker. */
export function imageBuildStageLabel(build: ImageBuildDescriptor): string {
  switch (build.stage) {
    case 'fetching':
      return 'Fetching source';
    case 'snapshotting':
      return 'Copying source';
    case 'validating':
      return 'Validating snapshot';
    case 'packaging':
      return 'Packaging with mkfs.erofs';
    case 'publishing':
      return 'Publishing verified bytes';
    case undefined:
    case null:
      return build.status === 'queued' ? 'Waiting for a build worker' : 'No active stage';
  }
}

/**
 * Measured progress only (#3334): file/byte counts are absent until the
 * snapshot manifest measured them, and packaging has no native percentage.
 * Elapsed time is always the Server-observed value.
 */
export function imageBuildProgressLabel(build: ImageBuildDescriptor): string {
  const seconds = (build.progress.elapsed_ms / 1000).toFixed(1);
  const measured =
    build.progress.files !== null
    && build.progress.files !== undefined
    && build.progress.bytes !== null
    && build.progress.bytes !== undefined
      ? `${build.progress.files.toLocaleString()} files · ${build.progress.bytes.toLocaleString()} bytes`
      : 'No measured counts yet';
  return `${measured} · ${seconds}s`;
}

/** Every selectable build-history lifecycle state (#3798). */
export const IMAGE_BUILD_STATUSES: readonly ImageBuildStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
];

/** Every selectable build-history source adapter (#3798). */
export const IMAGE_BUILD_SOURCES: readonly ImageBuildSourceKind[] = [
  'github',
  'local_directory',
  'compose',
];

export function imageBuildSourceKindLabel(kind: ImageBuildSourceKind): string {
  switch (kind) {
    case 'github':
      return 'GitHub';
    case 'local_directory':
      return 'Directory';
    case 'compose':
      return 'Compose';
  }
}

/** One terminal attempt line, preserving its diagnostic. */
export function imageBuildAttemptLabel(attempt: ImageBuildAttempt): string {
  const stage = attempt.stage ? ` · ${attempt.stage}` : '';
  const seconds = Math.max(0, attempt.finished_at - attempt.started_at);
  return `#${attempt.attempt} ${attempt.status}${stage} · ${seconds}s`;
}
