import type { ImageBuildDescriptor, ImageDescriptor } from './ImagesPlugin';
import type {
  ImageCacheState,
  ImageCacheStatus,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';

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

export function sourceLabel(image: ImageDescriptor): string {
  return image.source.kind === 'github'
    ? `${image.source.repository_url}@${image.source.ref}`
    : image.source.path;
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

/** The lifecycle word for one durable build. */
export function imageBuildStatusLabel(build: ImageBuildDescriptor): string {
  switch (build.status) {
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
