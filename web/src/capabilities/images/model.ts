import type { ImageDescriptor } from './ImagesPlugin';
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
