import { useCallback, useEffect, useRef, useState } from 'react';
import { imagesApi, type ImageBuildDescriptor } from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';

export interface ImageBuildsState {
  builds: ImageBuildDescriptor[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  cancel: (buildId: string) => Promise<void>;
  retry: (buildId: string) => Promise<void>;
}

/**
 * The durable build inventory for the Images capability (#3334).
 *
 * The build directory is the execution authority. This hook reads the Server
 * snapshot on mount, applies pushed transitions, and re-reads the snapshot
 * after a reconnect. It holds no timer and fabricates no progress: a build
 * that the browser did not see transition is simply read again.
 */
export function useImageBuilds(limit = IMAGE_PAGE_SIZE): ImageBuildsState {
  const [builds, setBuilds] = useState<ImageBuildDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const previousState = useRef(imagesApi.connectionState());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void imagesApi
      .listBuilds({ offset: 0, limit })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setBuilds(page.builds);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setBuilds([]);
        setError(cause instanceof Error ? cause.message : 'Image builds could not be loaded');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limit, revision]);

  useEffect(
    () =>
      imagesApi.onBuildChanged((build) => {
        setBuilds((current) => {
          const next = current.filter((candidate) => candidate.build_id !== build.build_id);
          next.unshift(build);
          return next.slice(0, limit);
        });
      }),
    [limit],
  );

  useEffect(
    () =>
      imagesApi.onConnectionStateChange((state) => {
        // A new physical connection may have missed pushes: the durable
        // inventory is authoritative and is re-read once it is back.
        if (previousState.current !== 'connected' && state === 'connected') {
          setRevision((current) => current + 1);
        }
        previousState.current = state;
      }),
    [],
  );

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const cancel = useCallback(async (buildId: string) => {
    const build = await imagesApi.cancelBuild(buildId);
    setBuilds((current) => {
      const next = current.filter((candidate) => candidate.build_id !== build.build_id);
      next.unshift(build);
      return next;
    });
  }, []);
  const retry = useCallback(async (buildId: string) => {
    const build = await imagesApi.retryBuild(buildId);
    setBuilds((current) => {
      const next = current.filter((candidate) => candidate.build_id !== build.build_id);
      next.unshift(build);
      return next;
    });
  }, []);

  return { builds, loading, error, refresh, cancel, retry };
}
