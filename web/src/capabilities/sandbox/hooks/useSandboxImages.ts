import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ImageCacheStatus,
  SandboxImageSelection,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { cacheStatusByDigest, type ImageDescriptor } from '@/capabilities/images';
import { sandboxApi } from '../SandboxPlugin';

export interface SandboxImagesState {
  selections: SandboxImageSelection[];
  /** The Server status observed when each digest was selected. */
  serverStatuses: Map<string, ImageDescriptor['status']>;
  cacheStatuses: Map<string, ImageCacheStatus>;
  cacheLoading: boolean;
  cacheError: string | null;
  add: (selection: SandboxImageSelection, serverStatus: ImageDescriptor['status']) => string | null;
  remove: (index: number) => void;
  refreshCache: () => void;
}

/**
 * Sandbox-owned image selections and their Agent cache observations (#3181).
 *
 * The selection list belongs to the Sandbox composition. It is not the
 * Project's single-image reference and it has no shared Picker. The cache
 * observation is read from the same authenticated Session context; Server
 * Ready is never substituted for Agent verification.
 */
export function useSandboxImages(sessionId: string | null): SandboxImagesState {
  const [selections, setSelections] = useState<SandboxImageSelection[]>([]);
  const [serverStatuses, setServerStatuses] = useState<
    Map<string, ImageDescriptor['status']>
  >(() => new Map());
  const [cacheStatuses, setCacheStatuses] = useState<ImageCacheStatus[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheRevision, setCacheRevision] = useState(0);

  const digests = useMemo(
    () => selections.map((selection) => selection.digest),
    [selections],
  );

  useEffect(() => {
    if (sessionId === null || digests.length === 0) {
      setCacheStatuses([]);
      setCacheError(null);
      setCacheLoading(false);
      return;
    }
    let cancelled = false;
    setCacheLoading(true);
    setCacheError(null);
    void sandboxApi
      .imageCacheStatuses(sessionId, digests)
      .then((statuses) => {
        if (!cancelled) {
          setCacheStatuses(statuses);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setCacheStatuses([]);
          setCacheError(
            failure instanceof Error ? failure.message : 'Agent image cache status is unavailable',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCacheLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, digests, cacheRevision]);

  const add = useCallback((selection: SandboxImageSelection, serverStatus: ImageDescriptor['status']): string | null => {
    if (
      selection.role === 'base'
      && selections.some((item) => item.role === 'base')
    ) {
      return 'This composition already has a Base Runtime image.';
    }
    if (
      selection.role === 'workspace'
      && selections.some((item) => item.role === 'workspace')
    ) {
      return 'This composition already has a workspace image.';
    }
    if (
      selection.role === 'toolchain'
      && selections.some(
        (item) => item.role === 'toolchain' && item.target === selection.target,
      )
    ) {
      return 'A toolchain image already uses that /opt target.';
    }
    setSelections((current) => [...current, selection]);
    setServerStatuses((current) => new Map(current).set(selection.digest, serverStatus));
    return null;
  }, [selections]);

  const remove = useCallback((index: number) => {
    setSelections((current) => current.filter((_, at) => at !== index));
  }, []);

  const refreshCache = useCallback(() => {
    setCacheRevision((current) => current + 1);
  }, []);

  return {
    selections,
    serverStatuses,
    cacheStatuses: cacheStatusByDigest(cacheStatuses),
    cacheLoading,
    cacheError,
    add,
    remove,
    refreshCache,
  };
}
